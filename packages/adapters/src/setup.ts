import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installCodexConfig, mergeCodexConfig } from "./codex-config.ts";
import { installLaunchd, renderLaunchdPlist } from "./launchd.ts";
import { generateMarketplace, renderMarketplace } from "./marketplace.ts";
import { installShellCommands } from "./setup-shell.ts";

const SERVICE = "dev.agent-graph.daemon";
const PLUGIN = "agent-graph@agent-graph-local";
const START_TIMEOUT_MS = 15_000;
const LOG_TAIL_BYTES = 65_536;
const FORWARDED_ENV = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "AGENT_GRAPH_PORT", "AGENT_GRAPH_SOCKET", "HERDR_CONFIG_PATH", "HERDR_SESSION", "HERDR_SOCKET_PATH"];

export interface CommandResult { status: number; stdout: string; stderr: string }
export interface SetupOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  nodePath?: string;
  rootPath?: string;
  uid?: number;
  dryRun?: boolean;
  doctor?: boolean;
  authenticate?: boolean;
  interactiveRun?: (command: string, args: string[]) => number;
  run?: (command: string, args: string[]) => CommandResult;
  log?: (message: string) => void;
  wait?: (logDir: string) => Promise<string>;
}

function readOptional(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

export function findExecutable(name: string, path: string): string | undefined {
  for (const directory of path.split(":").filter(Boolean)) {
    const candidate = resolve(directory, name);
    // 自動更新でリンク先が変わるCLIは、入口のパスを保持する。
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return undefined;
}

function parseList(result: CommandResult, label: string): Record<string, unknown>[] {
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr.trim() || result.stdout.trim()}`);
  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value)) throw new Error(`${label}: JSON の一覧を取得できません。Claude Code を更新してください。`);
  return value as Record<string, unknown>[];
}

function readDashboardUrl(logDir: string): string | undefined {
  const path = join(logDir, "daemon.log");
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
    const length = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return [...buffer.toString("utf8", 0, length).matchAll(/dashboard (http:\/\/127\.0\.0\.1:\d+\/)/g)].at(-1)?.[1];
  } finally { closeSync(fd); }
}

async function waitForDashboard(logDir: string): Promise<string> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = readDashboardUrl(logDir);
    if (url) {
      try {
        const response = await fetch(`${url}api/overview`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok && Array.isArray((await response.json() as { projects?: unknown }).projects)) return url;
      } catch { /* 起動途中の接続失敗だけを待ち直す */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`起動を確認できません。${join(logDir, "daemon.stderr.log")} を確認してください。`);
}

export async function setupAgentGraph(options: SetupOptions = {}): Promise<{ url?: string; warnings: string[] }> {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("自動セットアップは macOS に対応しています。");
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 以上が必要です。");
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const root = options.rootPath ?? fileURLToPath(new URL("../../../", import.meta.url));
  const nodePath = options.nodePath ?? env.AGENT_GRAPH_SETUP_NODE ?? process.execPath;
  const log = options.log ?? console.log;
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  for (const path of [home, configHome, stateHome, dataHome, codexHome, nodePath]) {
    if (!isAbsolute(path)) throw new Error(`設定の置き場は絶対パスで指定してください: ${path}`);
  }
  const searchPath = [...new Set([dirname(nodePath), join(home, ".local", "bin"), ...(env.PATH ?? "").split(":")])].filter(Boolean).join(":");
  const claude = findExecutable("claude", searchPath);
  const codex = findExecutable("codex", searchPath);
  const herdr = findExecutable("herdr", searchPath);
  const runtimeEnv = { ...env, HOME: home, PATH: searchPath };
  const run = options.run ?? ((command, args) => {
    const result = spawnSync(command, args, { cwd: root, env: runtimeEnv, encoding: "utf8", timeout: 60_000 });
    if (result.error) throw result.error;
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
  const checked = (command: string, args: string[]): CommandResult => {
    const result = run(command, args);
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  };
  const warnings: string[] = [];
  if (!claude) warnings.push("Claude CLIは通常のセットアップで自動導入します。");
  if (!codex) warnings.push("Codex CLIは通常のセットアップで自動導入します。");
  if (!herdr) warnings.push("画面操作用のHerdrは通常のセットアップで自動導入します。");
  const shimPath = join(root, "packages", "daemon", "src", "shim.ts");
  const hookPath = join(root, "packages", "adapters", "src", "hook.ts");
  const daemonPath = join(root, "packages", "daemon", "src", "main.ts");
  for (const path of [shimPath, hookPath, daemonPath]) if (!existsSync(path)) throw new Error(`実行ファイルがありません: ${path}`);
  // 設定を書き換える前に、配布物の依存ファイルも読み込めることを確かめる。
  await import(pathToFileURL(daemonPath).href);
  const configPath = join(codexHome, "config.toml");
  const config = readOptional(configPath);
  const updatedConfig = mergeCodexConfig(config, { nodePath, shimPath });
  const logDir = join(stateHome, "agent-graph", "run");
  const plistDir = join(home, "Library", "LaunchAgents");
  const serviceEnv: Record<string, string> = { HOME: home, PATH: searchPath };
  for (const key of FORWARDED_ENV) if (env[key] !== undefined) serviceEnv[key] = env[key];
  if (claude) serviceEnv.AGENT_GRAPH_CLAUDE_BIN = claude;
  if (codex) serviceEnv.AGENT_GRAPH_CODEX_BIN = codex;
  const launchd = { plistDir, nodePath, daemonPath, logDir, env: serviceEnv, uid: options.uid };
  const plistPath = join(plistDir, `${SERVICE}.plist`);
  const plist = renderLaunchdPlist(launchd);
  const target = `gui/${options.uid ?? process.getuid?.() ?? 0}/${SERVICE}`;
  const service = run("launchctl", ["print", target]);
  const loaded = service.status === 0;
  const stopped = loaded && /^\s*state = (?:not running|waiting|spawn scheduled|exited)\s*$/m.test(service.stdout)
    && !/^\s*pid = [1-9]\d*\s*$/m.test(service.stdout);
  const serviceChanged = readOptional(plistPath) !== plist;

  if (options.doctor) {
    log(`Node: ${process.versions.node}`);
    log(`Codex 設定: ${config === updatedConfig ? "登録済み" : "再セットアップが必要"}`);
    if (claude) {
      const plugins = parseList(run(claude, ["plugin", "list", "--json"]), "Claude の登録確認");
      log(`Claude 登録: ${plugins.some((plugin) => plugin.id === PLUGIN && plugin.scope === "user" && plugin.enabled) ? "有効" : "未登録または無効"}`);
    }
    log(`常駐起動: ${loaded ? "登録済み" : "未登録"}${loaded && serviceChanged ? "（設定更新が必要）" : ""}`);
    let url: string | undefined;
    if (loaded) url = await (options.wait ?? waitForDashboard)(logDir);
    if (url) log(`ダッシュボード: ${url}`);
    for (const warning of warnings) log(warning);
    return { url, warnings };
  }

  let marketplaceDir = join(dataHome, "agent-graph", "marketplace");
  let registered = false;
  let installed: Record<string, unknown> | undefined;
  if (claude) {
    const marketplaces = parseList(run(claude, ["plugin", "marketplace", "list", "--json"]), "Claude のマーケットプレイス確認");
    const existing = marketplaces.find((item) => item.name === "agent-graph-local");
    if (existing) {
      if (existing.source !== "directory" || typeof existing.path !== "string" || !isAbsolute(existing.path)) throw new Error("agent-graph-local が別の配布元に登録されています。既存の登録を確認してください。");
      marketplaceDir = existing.path;
      registered = true;
    }
    installed = parseList(run(claude, ["plugin", "list", "--json"]), "Claude のプラグイン確認")
      .find((item) => item.id === PLUGIN && item.scope === "user");
  }
  const marketplace = { outDir: marketplaceDir, plugin: { shimPath, hookPath, nodePath } };
  const files = renderMarketplace(marketplace);
  const pluginChanged = Object.entries(files).some(([path, content]) => readOptional(join(marketplaceDir, path)) !== content);
  const manifestPath = join(marketplaceDir, ".claude-plugin", "marketplace.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { plugins?: { name: string }[] };
    if (!Array.isArray(manifest.plugins) || manifest.plugins.some((plugin) => plugin.name !== "agent-graph")) {
      throw new Error(`独自のプラグイン一覧があるため上書きしません: ${manifestPath}`);
    }
  }
  if (options.dryRun) {
    log(`Codex: ${config === updatedConfig ? "変更なし" : "登録"} → ${configPath}`);
    log(`Claude: ${claude ? "ユーザー全体へ登録" : "CLI 導入後に登録"} → ${marketplaceDir}`);
    log(`常駐起動: ${loaded && !serviceChanged ? "変更なし（再起動しない）" : "登録・起動"} → ${plistPath}`);
    for (const warning of warnings) log(warning);
    return { warnings };
  }
  if (options.authenticate) {
    if (!claude || !codex || !herdr) throw new Error("必要なCLIが不足しています。bash scripts/setup.sh から導入してください。");
    const interactive = options.interactiveRun ?? ((command, args) => {
      const result = spawnSync(command, args, { cwd: root, env: runtimeEnv, stdio: "inherit" });
      if (result.error) throw result.error;
      return result.status ?? 1;
    });
    const isLoggedIn = (command: string, args: string[]): boolean => {
      const result = run(command, args);
      if (command === claude) return result.status === 0 && (JSON.parse(result.stdout) as { loggedIn?: boolean }).loggedIn === true;
      return result.status === 0;
    };
    for (const [command, statusArgs, loginArgs] of [
      [claude, ["auth", "status", "--json"], ["auth", "login"]],
      [codex, ["login", "status"], ["login"]],
    ] as const) {
      if (isLoggedIn(command, [...statusArgs])) continue;
      log(`${command === claude ? "Claude" : "Codex"} にログインしてください。`);
      if (interactive(command, [...loginArgs]) !== 0 || !isLoggedIn(command, [...statusArgs])) throw new Error("ログインが完了していません。同じセットアップを再実行してください。");
    }
  }
  // 既に動いているタスクの接続を、セットアップで切らない。
  if (loaded && serviceChanged && !stopped) {
    const url = await (options.wait ?? waitForDashboard)(logDir);
    const overview = await (await fetch(`${url}api/overview`, { signal: AbortSignal.timeout(2_000) })).json() as { projects: { key: string }[] };
    for (const project of overview.projects) {
      const view = await (await fetch(`${url}api/project?repo=${encodeURIComponent(project.key)}`, { signal: AbortSignal.timeout(2_000) })).json() as {
        sessions: { nodes: { kind: string; status: string }[] }[];
        graphs: { nodes: { kind: string; status: string }[] }[];
      };
      if ([...view.sessions, ...view.graphs].some((group) => group.nodes.some((node) => node.kind !== "root" && node.status === "running"))) {
        throw new Error("実行中の委譲があります。完了後にセットアップを再実行してください。");
      }
    }
  }
  if (config !== updatedConfig) {
    mkdirSync(dirname(configPath), { recursive: true });
    installCodexConfig({ configPath, nodePath, shimPath });
  }
  installShellCommands(home, env.SHELL, [dirname(nodePath), join(dataHome, "agent-graph", "tools", "bin"), join(home, ".local", "bin")], root);
  log("Codex の登録を確認しました。");
  if (pluginChanged) generateMarketplace(marketplace);
  if (claude) {
    if (!registered) checked(claude, ["plugin", "marketplace", "add", marketplaceDir, "--scope", "user"]);
    if (!installed) checked(claude, ["plugin", "install", PLUGIN, "--scope", "user"]);
    else if (pluginChanged) checked(claude, ["plugin", "update", PLUGIN]);
    if (installed && !installed.enabled) checked(claude, ["plugin", "enable", PLUGIN, "--scope", "user"]);
    log("Claude を全プロジェクトで使えるように登録しました。");
  }
  if (herdr) {
    for (const provider of ["claude", "codex"]) checked(herdr, ["integration", "install", provider]);
    const serverOptions = { ...launchd, label: "dev.agent-graph.herdr", nodePath: herdr, daemonPath: "server", logDir: join(logDir, "herdr") };
    if (run(herdr, ["status", "server"]).status !== 0) {
      const serverTarget = `gui/${options.uid ?? process.getuid?.() ?? 0}/dev.agent-graph.herdr`;
      if (run("launchctl", ["print", serverTarget]).status !== 0) installLaunchd({ ...serverOptions, launchctl: (args) => run("launchctl", args).status });
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (run(herdr, ["status", "server"]).status === 0) { ready = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error(`Herdrの起動を確認できません。${logDir} のログを確認してください。`);
    } else {
      // 手動起動済みのサーバーは止めず、次回ログイン用の設定だけを保存する。
      const serverPlistPath = join(plistDir, "dev.agent-graph.herdr.plist");
      const serverPlist = renderLaunchdPlist(serverOptions);
      if (readOptional(serverPlistPath) !== serverPlist) {
        mkdirSync(plistDir, { recursive: true });
        mkdirSync(serverOptions.logDir, { recursive: true });
        writeFileSync(serverPlistPath, serverPlist);
      }
    }
    log("画面からの起動・送信に使うHerdrを確認しました。");
  }
  if (!loaded || serviceChanged) installLaunchd({ ...launchd, launchctl: (args) => run("launchctl", args).status });
  const url = await (options.wait ?? waitForDashboard)(logDir);
  log(`ダッシュボード: ${url}`);
  log("新しいターミナルでは claude / codex / herdr / agent-graph --doctor を使えます。");
  log("開いている Claude / Codex は再起動してください。次回のPCログインからはデーモンが自動起動します。");
  for (const warning of warnings) log(warning);
  return { url, warnings };
}
