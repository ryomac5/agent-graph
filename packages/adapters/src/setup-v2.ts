import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installCodexConfig, mergeCodexConfig } from "./codex-config.ts";
import { renderLaunchdPlist, type LaunchdOptions } from "./launchd.ts";
import { generateMarketplace, renderMarketplace } from "./marketplace.ts";
import { findExecutable, type CommandResult, type SetupOptions } from "./setup.ts";
import type { ProjectPayload } from "../../core/src/ledger/facts.ts";
import { defaultTemporaryRoots, normalizeTemporaryRoots, resolveProjectLocation, toProjectPayload } from "../../core/src/ledger/repository.ts";

const DAEMON = "dev.agent-graph.daemon";
const RUNNER = "dev.agent-graph.runner";
const API = "dev.agent-graph.api";
const PLUGIN = "agent-graph@agent-graph-local";
const DASHBOARD_URL = "http://127.0.0.1:7420/";
const FORWARDED_ENV = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];

export interface SetupV2Options extends SetupOptions {
  rollbackV1?: boolean;
  temporaryRoots?: string[];
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function listLegacyDatabases(state: string): string[] {
  if (!existsSync(state)) return [];
  // 旧 daemon はプロジェクトごとの直下に DB を置く。
  return readdirSync(state, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => join(state, entry.name, "agent-graph.db")).filter(existsSync).sort();
}

function listProjectDecisions(paths: string[], temporaryRoots: string[], run: NonNullable<SetupOptions["run"]>, dryRun: boolean, log: (message: string) => void): ProjectPayload[] {
  const decisions = new Map<string, ProjectPayload>();
  for (const path of paths) {
    // dry-run は WAL の共有メモリも作らない。更新中の一覧は停止後に読む。
    if (dryRun && existsSync(`${path}-wal`) && statSync(`${path}-wal`).size > 0) {
      log(`プロジェクト一覧は旧 daemon の停止後に確認: ${path}`);
      continue;
    }
    const db = new DatabaseSync(dryRun ? `${pathToFileURL(path).href}?immutable=1` : path, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT root_path FROM repos ORDER BY root_path").all()) {
        // 移行と同じ関数で判定する。作業ツリーは本体に寄り、一時の場所と消えたリポジトリは登録しない。
        const location = toProjectPayload(resolveProjectLocation(String(row.root_path), {
          temporaryRoots, git: (args) => run("git", args),
        }));
        decisions.set(location.repository_id, location);
      }
    } finally { db.close(); }
  }
  return [...decisions.values()];
}

// api のプロセスで台帳と投影を更新し、adapters は台帳へ直接書かない。
function renderRegistrationScript(root: string, dbPath: string, projects: ProjectPayload[]): string {
  return `
import { openObservationService } from ${JSON.stringify(pathToFileURL(join(root, "packages/api/src/service/index.ts")).href)};
import { projectProjects } from ${JSON.stringify(pathToFileURL(join(root, "packages/core/src/ledger/projections/projects.ts")).href)};
const service = openObservationService({ dbPath: ${JSON.stringify(dbPath)} });
try {
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const current = new Map(projectProjects(facts).map(project => [project.id, project]));
  service.batch(() => {
    for (const payload of ${JSON.stringify(projects)}) {
      const previous = current.get(payload.repository_id);
      if (previous && Object.keys(payload).every(key => previous[key] === payload[key])) continue;
      const subject = 'project:' + payload.repository_id;
      const predecessors = facts.filter(fact => fact.subject === subject);
      const timestamp = new Date(predecessors.reduce((latest, fact) => Math.max(latest, Date.parse(fact.source_ts) + 1), Date.now())).toISOString();
      const result = service.ledger.append({ source: 'ui', source_event_id: JSON.stringify(['cutover-project', payload, predecessors.at(-1)?.fact_id]),
        kind: previous ? 'project.updated' : 'project.created', subject, source_ts: timestamp, confidence: 'confirmed', payload });
      if (result.status === 'conflict') throw new Error('Project registration conflict');
    }
  });
  service.catchUp();
} finally { service.close(); }
`;
}

export async function setupAgentGraphV2(options: SetupV2Options = {}): Promise<{ url?: string; warnings: string[] }> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("自動セットアップは macOS に対応しています。");
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 以上が必要です。");
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const root = options.rootPath ?? fileURLToPath(new URL("../../../", import.meta.url));
  const nodePath = options.nodePath ?? env.AGENT_GRAPH_SETUP_NODE ?? process.execPath;
  const state = join(env.XDG_STATE_HOME || join(home, ".local/state"), "agent-graph");
  const codexPath = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
  const data = join(env.XDG_DATA_HOME || join(home, ".local/share"), "agent-graph");
  for (const path of [home, root, nodePath, state, codexPath, data, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.CLAUDE_CONFIG_DIR]) {
    if (path && !isAbsolute(path)) throw new Error(`設定の置き場は絶対パスで指定してください: ${path}`);
  }
  const searchPath = [...new Set([dirname(nodePath), join(home, ".local/bin"), ...(env.PATH ?? "").split(":")])].filter(Boolean).join(":");
  const run = options.run ?? ((command: string, args: string[]): CommandResult => {
    const result = spawnSync(command, args, { cwd: root, env: { ...env, HOME: home, PATH: searchPath }, encoding: "utf8", timeout: 60_000 });
    if (result.error) throw result.error;
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
  const checked = (command: string, args: string[]) => {
    const result = run(command, args);
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
    return result;
  };
  const log = options.log ?? console.log;
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`;
  const plistDir = join(home, "Library/LaunchAgents");
  const backupPath = join(state, "cutover-v1-daemon.plist");
  const dbPath = join(state, "agent-graph.db");
  const socketPath = join(state, "runner.sock");
  const runnerPath = join(root, "packages/runner/src/cli.ts");
  const apiPath = join(root, "packages/api/src/cli.ts");
  const rollback = options.rollbackV1 === true;
  const relay: "legacy" | "v2" = rollback ? "legacy" : "v2";
  const shimPath = join(root, rollback ? "packages/daemon/src/shim.ts" : "packages/adapters/src/shim-v2/cli.ts");
  const hookPath = join(root, rollback ? "packages/adapters/src/hook.ts" : "packages/adapters/src/hook-v2/cli.ts");
  const claude = findExecutable("claude", searchPath);
  const warnings = claude ? [] : ["Claude CLI がありません。プラグインの生成先を登録してください。"];
  let marketplaceDir = join(data, "marketplace");
  let installed: Record<string, unknown> | undefined;
  let registered = false;
  if (claude) {
    const list = (args: string[]) => {
      const value: unknown = JSON.parse(checked(claude, args).stdout);
      if (!Array.isArray(value)) throw new Error("Claude の登録一覧を取得できません。");
      return value as Record<string, unknown>[];
    };
    const existing = list(["plugin", "marketplace", "list", "--json"]).find((entry) => entry.name === "agent-graph-local");
    if (existing) {
      if (existing.source !== "directory" || typeof existing.path !== "string" || !isAbsolute(existing.path)) throw new Error("agent-graph-local が別の配布元に登録されています。");
      marketplaceDir = existing.path;
      registered = true;
    }
    installed = list(["plugin", "list", "--json"]).find((entry) => entry.id === PLUGIN && entry.scope === "user");
  }
  const serviceStatus = new Map([DAEMON, RUNNER, API].map((label) => [label, run("launchctl", ["print", `${domain}/${label}`])]));
  if (options.doctor) {
    for (const [label, result] of serviceStatus) log(`${label}: ${result.status === 0 ? result.stdout.trim() || "登録済み" : "未登録"}`);
    const direction = (text: string) => /(?:hook|shim)-v2/.test(text) ? "v2" : /(?:hook\.ts|daemon\/src\/shim\.ts)/.test(text) ? "v1" : "未登録";
    log(`Claude hook: ${direction(readOptional(join(marketplaceDir, "plugins/agent-graph/hooks/hooks.json")))}`);
    log(`Claude MCP: ${direction(readOptional(join(marketplaceDir, "plugins/agent-graph/.mcp.json")))}`);
    log(`Codex MCP: ${direction(readOptional(codexPath).split(/\n(?=\[)/).filter((section) => /^\[mcp_servers\.agent-graph(?:\]|\.)/.test(section.trim())).join("\n"))}`);
    return { warnings };
  }
  for (const path of [shimPath, hookPath, runnerPath, apiPath]) if (!existsSync(path)) throw new Error(`実行ファイルがありません: ${path}`);
  const marketplace = { outDir: marketplaceDir, plugin: { nodePath, shimPath, hookPath, relay } };
  const files = renderMarketplace(marketplace);
  const manifest = readOptional(join(marketplaceDir, ".claude-plugin/marketplace.json"));
  if (manifest && (!Array.isArray(JSON.parse(manifest).plugins) || JSON.parse(manifest).plugins.some((plugin: { name: string }) => plugin.name !== "agent-graph"))) {
    throw new Error("独自のプラグイン一覧があるため上書きしません。");
  }
  const pluginChanged = Object.entries(files).some(([path, content]) => readOptional(join(marketplaceDir, path)) !== content);
  const config = readOptional(codexPath);
  const updatedConfig = mergeCodexConfig(config, { nodePath, shimPath, relay });
  const serviceEnv: Record<string, string> = { HOME: home, PATH: searchPath };
  for (const key of FORWARDED_ENV) if (env[key] !== undefined) serviceEnv[key] = env[key];
  for (const provider of ["claude", "codex"]) {
    const binary = findExecutable(provider, searchPath);
    if (binary) serviceEnv[`AGENT_GRAPH_${provider.toUpperCase()}_BIN`] = binary;
  }
  const serviceOptions = (label: string, daemonPath: string, args: string[]): LaunchdOptions => ({
    plistDir, label, nodePath, daemonPath, args, env: serviceEnv, logDir: join(state, "run", label.split(".").at(-1)!),
  });
  const runner = serviceOptions(RUNNER, runnerPath, ["serve", "--db", dbPath, "--socket", socketPath]);
  const api = serviceOptions(API, apiPath, ["serve", "--db", dbPath, "--runner-socket", socketPath, "--port", "0", "--dashboard-port", "7420"]);
  const daemonPlist = join(plistDir, `${DAEMON}.plist`);
  const originalDaemon = readOptional(daemonPlist) || readOptional(backupPath);
  if (!rollback && serviceStatus.get(RUNNER)!.status === 0 && readOptional(join(plistDir, `${RUNNER}.plist`)) !== renderLaunchdPlist(runner)) {
    throw new Error("runner の設定が変わっています。実行の終了後に runner を停止して再実行してください。");
  }
  const legacyPaths = rollback ? [] : listLegacyDatabases(state);
  const temporaryRoots = normalizeTemporaryRoots(options.temporaryRoots ?? defaultTemporaryRoots(env, home));
  const projects = options.dryRun ? listProjectDecisions(legacyPaths, temporaryRoots, run, true, log) : [];
  const act = (description: string, action: () => void) => { log(description); if (!options.dryRun) action(); };
  const stop = (label: string) => act(`launchctl bootout ${domain}/${label}; launchd 登録を外す`, () => {
    if (serviceStatus.get(label)!.status === 0) checked("launchctl", ["bootout", `${domain}/${label}`]);
    const path = join(plistDir, `${label}.plist`);
    if (existsSync(path)) unlinkSync(path);
  });
  const start = (options: LaunchdOptions) => {
    const path = join(plistDir, `${options.label}.plist`);
    const plist = renderLaunchdPlist(options);
    if (serviceStatus.get(options.label!)!.status === 0 && readOptional(path) === plist) { log(`${options.label}: 変更なし`); return; }
    act(`plist を生成: ${path}; launchctl bootstrap ${domain} ${path}`, () => {
      if (serviceStatus.get(options.label!)!.status === 0) checked("launchctl", ["bootout", `${domain}/${options.label}`]);
      mkdirSync(plistDir, { recursive: true }); mkdirSync(options.logDir, { recursive: true });
      writeFileSync(path, plist);
      checked("launchctl", ["bootstrap", domain, path]);
    });
  };
  if (rollback) {
    if (!originalDaemon) throw new Error("旧 daemon の plist がありません。v1 のセットアップで復元してください。");
    stop(API); stop(RUNNER);
    act(`旧 daemon の plist を復元: ${daemonPlist}; launchctl bootstrap ${domain} ${daemonPlist}`, () => {
      mkdirSync(plistDir, { recursive: true }); writeFileSync(daemonPlist, originalDaemon);
      if (serviceStatus.get(DAEMON)!.status !== 0) checked("launchctl", ["bootstrap", domain, daemonPlist]);
    });
  } else {
    act(`旧 daemon の plist を保存: ${backupPath}`, () => {
      if (originalDaemon && !existsSync(backupPath)) { mkdirSync(state, { recursive: true, mode: 0o700 }); writeFileSync(backupPath, originalDaemon); }
    });
    stop(DAEMON);
    for (const path of legacyPaths) act(`api migrate --from ${path} --db ${dbPath}`, () => {
      const result = checked(nodePath, [apiPath, "migrate", "--from", path, "--db", dbPath,
        ...temporaryRoots.flatMap((directory) => ["--temporary-root", directory])]);
      const report = JSON.parse(result.stdout);
      if (report.errors?.length) throw new Error(`旧 DB の移行に失敗しました: ${JSON.stringify(report.errors)}`);
      log(result.stdout.trim());
    });
    if (!options.dryRun) projects.push(...listProjectDecisions(legacyPaths, temporaryRoots, run, false, log));
    for (const project of projects) log(`プロジェクト ${project.state}: ${project.root_path} → ${project.repository_id}`);
    if (legacyPaths.length) act("api で通常のリポジトリだけをプロジェクト登録し作業ツリーと一時場所を除外", () => {
      checked(nodePath, ["--input-type=module", "--eval", renderRegistrationScript(root, dbPath, projects)]);
    });
    start(runner); start(api);
  }
  act(`Claude hook と MCP を ${relay} へ生成: ${marketplaceDir}`, () => {
    if (pluginChanged) generateMarketplace(marketplace);
    if (claude) {
      if (!registered) checked(claude, ["plugin", "marketplace", "add", marketplaceDir, "--scope", "user"]);
      if (!installed) checked(claude, ["plugin", "install", PLUGIN, "--scope", "user"]);
      else if (pluginChanged) checked(claude, ["plugin", "update", PLUGIN]);
      if (installed && !installed.enabled) checked(claude, ["plugin", "enable", PLUGIN, "--scope", "user"]);
    }
  });
  act(`Codex MCP を ${relay} へ変更: ${codexPath}`, () => {
    if (config !== updatedConfig) { mkdirSync(dirname(codexPath), { recursive: true }); installCodexConfig({ configPath: codexPath, nodePath, shimPath, relay }); }
  });
  log(`台帳を保持: ${dbPath}`);
  log(`ダッシュボード: ${DASHBOARD_URL}`);
  for (const warning of warnings) log(warning);
  return { url: options.dryRun ? undefined : DASHBOARD_URL, warnings };
}
