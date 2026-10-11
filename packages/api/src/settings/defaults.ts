import { spawn, execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { AvailableModel } from "../../../core/src/settings/index.ts";

const execute = promisify(execFile);
const RESOLUTION_TIMEOUT_MS = 5000;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export interface DefaultSource { kind: "file" | "environment" | "provider" | "unknown"; key: string; path?: string }
export interface ProviderDefaults {
  model: string | null;
  displayName: string | null;
  effort: string | null;
  modelSource: DefaultSource;
  effortSource: DefaultSource;
}
export interface DefaultOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  managedClaudePath?: string;
  codex?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
}
function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function unknownDefaults(): ProviderDefaults {
  return { model: null, displayName: null, effort: null, modelSource: { kind: "unknown", key: "model" }, effortSource: { kind: "unknown", key: "effort" } };
}
async function readJson(path: string): Promise<Record<string, unknown>> {
  try { return readObject(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
async function readLocalRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execute("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, timeout: RESOLUTION_TIMEOUT_MS });
    return dirname(stdout.trim());
  } catch { return cwd; }
}
async function resolveClaude(cwd: string, models: AvailableModel[], options: DefaultOptions): Promise<ProviderDefaults> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const repositoryRoot = process.platform === "win32" ? cwd : await readLocalRoot(cwd);
  const root = repositoryRoot === home ? cwd : repositoryRoot;
  const user = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json");
  const paths = [...new Set([user, join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json"), join(root, ".claude/settings.local.json"),
    options.managedClaudePath ?? (process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json")])];
  const sources = await Promise.all(paths.map(async path => ({ path, settings: await readJson(path) })));
  const mergedEnv = Object.assign({}, env, ...sources.map(source => readObject(source.settings.env))) as NodeJS.ProcessEnv;
  const result = unknownDefaults();
  function sourceOf(key: string): { value: unknown; source: DefaultSource } | undefined {
    const source = sources.findLast(item => Object.hasOwn(item.settings, key));
    return source && { value: source.settings[key], source: { kind: "file", path: source.path, key } };
  }
  function environmentSource(key: string): DefaultSource {
    const source = sources.findLast(item => Object.hasOwn(readObject(item.settings.env), key));
    return source ? { kind: "file", path: source.path, key: `env.${key}` } : { kind: "environment", key };
  }
  const setting = sourceOf("model");
  const model = readString(mergedEnv.ANTHROPIC_MODEL) ?? readString(setting?.value);
  result.modelSource = readString(mergedEnv.ANTHROPIC_MODEL) ? environmentSource("ANTHROPIC_MODEL") : setting?.source
    ?? (readString(mergedEnv.ANTHROPIC_DEFAULT_MODEL) ? environmentSource("ANTHROPIC_DEFAULT_MODEL") : { kind: "provider", key: "account default" });
  // default は購読・組織・CLI の版で変わるため、一覧の先頭から名前を推測しない。
  if (model && !["default", "inherit", "opusplan"].includes(model.toLowerCase())) {
    const family = /^(opus|sonnet|haiku|fable)(\[1m\])?$/.exec(model);
    const pin = family && `ANTHROPIC_DEFAULT_${family[1].toUpperCase()}_MODEL`;
    result.model = pin && readString(mergedEnv[pin]) || model;
    if (pin && readString(mergedEnv[pin])) result.modelSource = environmentSource(pin);
    const entry = models.find(item => item.model === result.model);
    result.displayName = entry && !/^default(?: \(recommended\))?$/i.test(entry.displayName) ? entry.displayName : result.model;
    if (family && result.displayName === model) { result.model = null; result.displayName = null; }
  }
  // modelSettings の同じモデルの値と effortLevel は、各ファイルの優先順で評価する。
  const named = /^(?:Claude )?(Opus|Sonnet|Haiku|Fable) (\d+(?:\.\d+)?)/i.exec(result.displayName ?? "");
  const modelKey = /^claude-(?:opus|sonnet|haiku|fable)-\d/.test(result.model ?? "") ? result.model!.replace(/\[1m\]$/, '')
    : named ? `claude-${named[1].toLowerCase()}-${named[2].replaceAll('.', '-')}` : '';
  const effortSetting = sources.findLast(source => {
    const specific = readObject(readObject(source.settings.modelSettings)[modelKey]);
    const userLegacy = source.path === user && /(?:Opus|Sonnet|Haiku) 5\.5|claude-(?:opus|sonnet|haiku)-5-5/i.test(result.displayName ?? "");
    return readString(specific.effortLevel) || !userLegacy && readString(source.settings.effortLevel);
  });
  const specific = readObject(readObject(effortSetting?.settings.modelSettings)[modelKey]);
  const environmentEffort = readString(mergedEnv.CLAUDE_CODE_EFFORT_LEVEL);
  const modelEffort = /^claude-(?:opus|sonnet|haiku)-5-5(?:$|-|\[)/.test(modelKey) ? "medium" : modelKey === "claude-opus-4-7" ? "xhigh"
    : /^claude-(?:opus-(?:4-6|4-8|5)|sonnet-(?:4-6|5)|fable-5)(?:$|-)/.test(modelKey) ? "high" : null;
  result.effort = environmentEffort === "auto" ? modelEffort : environmentEffort ?? readString(specific.effortLevel) ?? readString(effortSetting?.settings.effortLevel) ?? modelEffort;
  result.effortSource = environmentEffort ? environmentSource("CLAUDE_CODE_EFFORT_LEVEL") : effortSetting
    ? { kind: "file", path: effortSetting.path, key: readString(specific.effortLevel) ? `modelSettings.${modelKey}.effortLevel` : "effortLevel" }
    : { kind: "provider", key: "model default effort" };
  if (result.effort === "xhigh" && /^claude-(?:opus|sonnet)-4-6/.test(modelKey)) {
    result.effort = "high"; result.effortSource = { kind: "provider", key: "supported effort" };
  }
  const cap = sourceOf("maxEffortLevel");
  const limit = CLAUDE_EFFORTS.indexOf(String(cap?.value));
  if (limit >= 0 && CLAUDE_EFFORTS.indexOf(result.effort ?? "") > limit) {
    result.effort = String(cap!.value); result.effortSource = cap!.source;
  }
  return result;
}

// 推論やスレッドの作成をせず、CLI 自身に信頼・プロファイル・設定の順を解決させる。
export async function readCodexDefaults(cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  const child = spawn(env.AGENT_GRAPH_CODEX_BIN || "codex", ["app-server", "--listen", "stdio://"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let id = 0;
  let failed = false;
  const fail = () => { failed = true; for (const entry of pending.values()) entry.reject(new Error("Codex defaults unavailable")); pending.clear(); };
  const timer = setTimeout(() => { fail(); child.kill("SIGKILL"); }, RESOLUTION_TIMEOUT_MS);
  child.on("error", fail); child.on("close", fail); child.stdin.on("error", fail);
  lines.on("line", line => {
    try {
      const frame = JSON.parse(line);
      const entry = pending.get(frame.id);
      if (entry) { pending.delete(frame.id); if (frame.error) entry.reject(new Error("Codex defaults unavailable")); else entry.resolve(frame.result); }
    } catch { fail(); }
  });
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (failed) { reject(new Error("Codex defaults unavailable")); return; }
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "agent_graph_defaults", version: "1" }, capabilities: {} });
    child.stdin.write('{"method":"initialized"}\n');
    const config = await request("config/read", { cwd, includeLayers: true });
    let models: unknown = {};
    try { models = await request("model/list", {}); } catch { /* 設定で確定した値は一覧の失敗でも返す。 */ }
    return { ...readObject(config), models: readObject(models).data };
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end(); child.kill("SIGKILL");
  }
}
async function resolveCodex(cwd: string, options: DefaultOptions): Promise<ProviderDefaults> {
  const env = { ...(options.env ?? process.env) };
  if (options.home) { env.HOME = options.home; env.CODEX_HOME ||= join(options.home, ".codex"); }
  const response = readObject(await (options.codex ?? readCodexDefaults)(cwd, env));
  const config = readObject(response.config);
  const origins = readObject(response.origins);
  const models = (Array.isArray(response.models) ? response.models : []).map(readObject);
  const result = unknownDefaults();
  function sourceOf(key: string): DefaultSource {
    const name = readObject(readObject(origins[key]).name);
    const path = readString(name.file) ?? (readString(name.dotCodexFolder) ? join(String(name.dotCodexFolder), "config.toml") : null);
    return path ? { kind: "file", path, key } : { kind: "provider", key };
  }
  const entry = readString(config.model) ? models.find(item => item.model === config.model) : models.find(item => item.isDefault === true);
  result.model = readString(config.model) ?? readString(entry?.model);
  result.displayName = readString(entry?.displayName) ?? result.model;
  result.modelSource = readString(config.model) ? sourceOf("model") : { kind: "provider", key: "model/list.isDefault" };
  result.effort = readString(config.model_reasoning_effort) ?? readString(entry?.defaultReasoningEffort);
  result.effortSource = readString(config.model_reasoning_effort) ? sourceOf("model_reasoning_effort") : { kind: "provider", key: "model/list.defaultReasoningEffort" };
  return result;
}
export async function resolveProviderDefaults(provider: "claude" | "codex" | "antigravity", cwd: string, models: AvailableModel[], options: DefaultOptions = {}): Promise<ProviderDefaults> {
  if (!isAbsolute(cwd)) throw new TypeError("Default model cwd must be absolute");
  try {
    if (provider === "claude") return await resolveClaude(cwd, models, options);
    if (provider === "codex") return await resolveCodex(cwd, options);
  } catch { /* 読めない設定の本文や認証情報は API に出さない。 */ }
  return unknownDefaults();
}
