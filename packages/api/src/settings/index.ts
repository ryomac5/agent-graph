import { createHash, randomUUID } from "node:crypto";
import { watchFile, unwatchFile } from "node:fs";
import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { getDefaults, mergeSettings, validateSettings, type FileStore, type SettingsByStore, type SettingsStatus } from "../../../core/src/settings/index.ts";
import { decide, type DecisionInput } from "../../../core/src/assign/assign.ts";
import type { DelegateRequest } from "../../../core/src/delegate/types.ts";
import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import type { JsonValue } from "../../../core/src/ledger/facts.ts";
import type { ScreenCommand } from "../ws/contract.ts";
import { parseSettingsToml, updateSettingsToml } from "./toml.ts";
export const SETTINGS_WATCH_INTERVAL_MS = 100;

export interface KeychainPort { setClaudeApiKey(value: string): Promise<void>; deleteClaudeApiKey(): Promise<void>; hasClaudeApiKey(): Promise<boolean> }
export interface PastDelegation { id: string; request: DelegateRequest; context: Omit<DecisionInput, "policy"> }
export interface SettingsOptions {
  paths: Record<FileStore, string>;
  ledger: Ledger;
  keychain: KeychainPort;
  history(): PastDelegation[];
  apply(store: FileStore, value: SettingsByStore[FileStore], confirmation: boolean): Promise<void>;
  preflight?(store: FileStore, value: SettingsByStore[FileStore], confirmation: boolean): Promise<void>;
  status(): Promise<SettingsStatus>;
  listModels(provider: "claude" | "codex"): Promise<JsonValue>;
  rebuild(progress: (completed: number, total: number) => void): Promise<void>;
  resync(): void;
  onError?(store: FileStore, reason: string): void;
}
export function settingsPaths(repository: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Record<FileStore, string> {
  const root = env.XDG_CONFIG_HOME || join(home, ".config");
  if (!isAbsolute(root) || !isAbsolute(repository)) throw new TypeError("Settings paths must be absolute");
  return { config: join(root, "agent-graph/config.toml"), policy: join(root, "agent-graph/policy.toml"), project: join(repository, "agent-graph.toml") };
}
async function readOptional(path: string): Promise<string> {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}
function revision(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function changedFields(before: unknown, after: unknown, prefix = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (after && typeof after === "object" && !Array.isArray(after)) return Object.entries(after).flatMap(([key, value]) => changedFields((before as Record<string, unknown>)[key], value, prefix ? `${prefix}.${key}` : key));
  return [prefix];
}
export class SettingsService {
  private options: SettingsOptions;
  private values: { [S in FileStore]: SettingsByStore[S] } = { config: getDefaults("config"), policy: getDefaults("policy"), project: getDefaults("project") };
  private errors: Partial<Record<FileStore, string>> = {};
  private watchers: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private previews = new Map<string, { policy: SettingsByStore["policy"]; base: string }>();
  private commands = new Map<string, { fingerprint: string; promise: Promise<JsonValue> }>();
  private rebuildState: SettingsStatus["rebuild"] = { state: "idle", completed: 0, total: 0 };
  constructor(options: SettingsOptions) { this.options = options; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  async start(): Promise<void> {
    if (this.watchers.length) return;
    for (const store of ["config", "policy", "project"] as const) {
      await mkdir(dirname(this.options.paths[store]), { recursive: true });
      // パスの監視は rename と削除後の再作成も追う。OS の監視枠を消費しない。
      const listener = () => {
        void this.reload(store).catch(() => undefined);
      };
      watchFile(this.options.paths[store], { interval: SETTINGS_WATCH_INTERVAL_MS, persistent: false }, listener);
      this.watchers.push(() => unwatchFile(this.options.paths[store], listener));
      await this.reload(store, true);
    }
  }
  close(): void { for (const stop of this.watchers) stop(); this.watchers = []; }
  read<S extends FileStore>(store: S): SettingsByStore[S] { return structuredClone(this.values[store]) as SettingsByStore[S]; }
  private async readKeyConfigured(): Promise<boolean> {
    try { return await this.options.keychain.hasClaudeApiKey(); }
    catch { throw new Error("Keychain unavailable"); }
  }
  private async applyRunner(store: FileStore, next: SettingsByStore[FileStore], confirmation: boolean, preflight = false): Promise<void> {
    // runner 由来の例外には秘密が含まれうるため、応答へ本文を渡さない。
    try {
      if (preflight) await this.options.preflight?.(store, structuredClone(next), confirmation);
      else await this.options.apply(store, structuredClone(next), confirmation);
    } catch { throw new Error("Settings application failed"); }
  }
  private async commit(store: FileStore, next: SettingsByStore[FileStore], origin: "api" | "file", confirmation = false, initial = false): Promise<void> {
    const fields = changedFields(this.values[store], next);
    if (!fields.length && !initial) { delete this.errors[store]; return; }
    await this.applyRunner(store, next, confirmation);
    try {
      if (fields.length && !initial) this.options.ledger.append({ source: "ui", source_event_id: `settings:${randomUUID()}`, kind: "setting.changed", subject: `setting:${store}:${this.options.paths[store]}`, source_ts: new Date().toISOString(), confidence: "confirmed", payload: { store, fields, origin, revision: revision(next) } });
    } catch {
      await this.applyRunner(store, this.read(store), true);
      throw new Error("Settings audit failed");
    }
    this.values = { ...this.values, [store]: structuredClone(next) }; delete this.errors[store];
  }
  reload(store: FileStore, initial = false): Promise<void> {
    return this.serialize(async () => {
      try {
        const text = await readOptional(this.options.paths[store]);
        const next = validateSettings(store, parseSettingsToml(text, store === "policy"));
        await this.applyRunner(store, next, false, true);
        await this.commit(store, next, "file", false, initial);
      } catch (error) {
        // 入力やキーの本文をエラーに混ぜない。
        const reason = error instanceof TypeError || error instanceof SyntaxError ? error.message : "Settings application failed";
        this.errors[store] = reason; this.options.onError?.(store, reason);
      }
    });
  }
  previewPolicy(patch: unknown) {
    const policy = validateSettings("policy", mergeSettings(this.values.policy, patch));
    const token = randomUUID();
    const rows = this.options.history().map(({ id, request, context }) => ({ id, before: decide(request, { ...context, policy: this.values.policy }), after: decide(request, { ...context, policy }) }));
    this.previews.set(token, { policy, base: revision(this.values.policy) });
    return { token, rows };
  }
  write(store: FileStore, patch: unknown, options: { previewToken?: string; confirmation?: boolean } = {}): Promise<void> {
    return this.serialize(async () => {
      const next = validateSettings(store, mergeSettings(this.values[store], patch));
      if (store === "policy") {
        const preview = this.previews.get(options.previewToken ?? "");
        if (!preview || preview.base !== revision(this.values.policy) || revision(preview.policy) !== revision(next)) throw new TypeError("Matching policy preview required before save");
      }
      const text = await readOptional(this.options.paths[store]);
      // 監視の通知より先に保存要求が来ても、手編集を上書きしない。
      if (revision(validateSettings(store, parseSettingsToml(text, store === "policy"))) !== revision(this.values[store])) throw new TypeError("Settings file changed; reload before saving");
      await this.applyRunner(store, next, !!options.confirmation, true);
      const edited = updateSettingsToml(text, patch as Record<string, unknown>, store === "policy");
      // 保存した表現を再検証し、TOML の省略が既定値と一致することも確認する。
      if (revision(validateSettings(store, parseSettingsToml(edited, store === "policy"))) !== revision(next)) throw new TypeError("Settings file changed; reload before saving");
      await writeAtomic(this.options.paths[store], edited);
      try { await this.commit(store, next, "api", !!options.confirmation); }
      catch (error) {
        await writeAtomic(this.options.paths[store], text);
        await this.applyRunner(store, this.read(store), true);
        throw error;
      }
    });
  }
  async handle(message: ScreenCommand): Promise<{ type: "ack"; cmd_id: string; ok: true; result: JsonValue } | { type: "ack"; cmd_id: string; ok: false; error: string }> {
    const fingerprint = revision({ command: message.command, payload: message.payload });
    try {
      // 読み取りは毎回取得し、再送で副作用が重複する操作だけを保持する。
      const cache = ["settings.write", "settings.apiKey", "settings.rebuild"].includes(message.command);
      const previous = this.commands.get(message.cmd_id);
      if (previous && previous.fingerprint !== fingerprint) throw new TypeError("cmd_id reused for another command");
      const promise = previous?.promise ?? this.execute(message.command, message.payload);
      if (cache && !previous) this.commands.set(message.cmd_id, { fingerprint, promise });
      return { type: "ack", cmd_id: message.cmd_id, ok: true, result: await promise };
    } catch (error) {
      return { type: "ack", cmd_id: message.cmd_id, ok: false, error: message.command !== "settings.apiKey" && (error instanceof TypeError || error instanceof SyntaxError) ? error.message : "Settings operation failed" };
    }
  }
  private async execute(command: string, payload?: JsonValue): Promise<JsonValue> {
    const p = (payload ?? {}) as Record<string, JsonValue>;
    if (command === "settings.read") return JSON.parse(JSON.stringify({ config: this.values.config, policy: this.values.policy, project: this.values.project, errors: this.errors, apiKeyConfigured: await this.readKeyConfigured() }));
    if (command === "settings.previewPolicy") return JSON.parse(JSON.stringify(this.previewPolicy(p.patch)));
    if (command === "settings.write") {
      if (!["config", "policy", "project"].includes(p.store as string)) throw new TypeError("Invalid settings store");
      const previousScope = this.values.config.storage.scope;
      await this.write(p.store as FileStore, p.patch, { previewToken: p.previewToken as string, confirmation: p.confirmation === true });
      const levels = ["metadata", "message_body", "tool_output", "full_diff"];
      const narrowed = p.store === "config" && levels.indexOf(this.values.config.storage.scope) < levels.indexOf(previousScope);
      return narrowed ? { saved: true, existingPayloadDeletion: "requires_confirmation" } : { saved: true };
    }
    if (command === "settings.apiKey") {
      if (p.remove === true) await this.options.keychain.deleteClaudeApiKey();
      else { if (typeof p.value !== "string" || !p.value.trim()) throw new TypeError("API key required"); await this.options.keychain.setClaudeApiKey(p.value); }
      this.options.ledger.append({ source: "ui", source_event_id: `settings:key:${randomUUID()}`, kind: "setting.changed", subject: "setting:keychain", source_ts: new Date().toISOString(), confidence: "confirmed", payload: { store: "keychain", fields: ["claudeApiKey"], origin: "api", revision: randomUUID() } });
      return { configured: await this.readKeyConfigured() };
    }
    if (command === "settings.status") return JSON.parse(JSON.stringify({ ...await this.options.status(), rebuild: this.rebuildState }));
    if (command === "settings.models") {
      if (p.provider !== "claude" && p.provider !== "codex") throw new TypeError("Invalid provider");
      try { return { state: "known", models: await this.options.listModels(p.provider) }; } catch { return { state: "unknown", models: [] }; }
    }
    if (command === "settings.rebuild") {
      if (this.rebuildState.state === "running") throw new TypeError("Rebuild already running");
      this.rebuildState = { state: "running", completed: 0, total: 0 };
      void Promise.resolve().then(() => this.options.rebuild((completed, total) => { this.rebuildState = { state: "running", completed, total }; })).then(() => { this.rebuildState.state = "done"; this.options.resync(); }, () => { this.rebuildState.state = "failed"; });
      return { started: true };
    }
    throw new TypeError("Unknown settings command");
  }
}
