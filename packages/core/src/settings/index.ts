import { defaultPolicy, type Policy } from "../assign/policy.ts";
import { validateRules } from "../ledger/redact.ts";

export type Isolation = "read-only" | "workspace-write" | "danger-full-access";
export const DEFAULT_SETTINGS_PORT = 7421;
export const LEGACY_DAEMON_PORT = 7420;
const MAX_PORT = 65535;
export interface ConfigSettings {
  agents: { claude: { model: string; effort: string; authentication: "subscription" | "api_key"; integrations: "disabled" | "strict" | "enabled" }; codex: { model: string; effort: string } };
  approval: { mode: "untrusted" | "on-request" | "never" };
  isolation: { policy: Isolation };
  observation: { repositories: string[]; claude: boolean; codex: boolean; kit: boolean };
  notifications: { quietStart: string; quietEnd: string; timezone: string; approvalException: boolean };
  storage: { scope: "metadata" | "message_body" | "tool_output" | "full_diff"; bodyRetentionDays: number; metadataRetentionDays: number | null; redaction: { defaults: boolean; patterns: string[] } };
  dashboard: { port: number };
  keys: Record<string, string>;
}
// 未指定のプロジェクト方針は個人の既定を継ぐ。
export interface ProjectSettings { isolation: { policy: Isolation | null }; acceptance: { commands: string[] }; scope: { exclude: string[] } }
export interface BrowserSettings {
  theme: "system" | "light" | "dark"; density: "comfortable" | "compact";
  diff: "side-by-side" | "unified"; time: "relative" | "absolute"; language: "en" | "ja";
  notifications: Record<"approval" | "input" | "completed" | "failed" | "reviewInvalidated" | "unknown" | "runnerFailure" | "apiFailure" | "disconnected", "in-app" | "browser" | "both" | "off">;
}
export type BrowserNotificationPermission = "default" | "granted" | "denied";
export interface AvailableModel { model: string; effort?: string; displayName: string }
export type AvailableModels = { state: "known"; models: AvailableModel[] } | { state: "unknown"; models: [] };
export interface ProjectRegistration { repositoryId: string; rootPath: string; displayName: string; namePrefix: string; registered: boolean }
export interface HostStatus { state: "ready" | "unavailable" | "unknown"; version: string | null; authentication: string | null; degraded: string[] }
export interface SettingsStatus {
  hosts: Record<"claude" | "codex", HostStatus>;
  connection: { runner: boolean; protocolVersion: number; apiVersion: string; updatePending: boolean };
  observation: { formats: string[]; unsupportedCount: number };
  rebuild: { state: "idle" | "running" | "done" | "failed"; completed: number; total: number };
  logs: { runner: string; api: string };
}
export interface SettingsByStore { config: ConfigSettings; policy: Policy; project: ProjectSettings; browser: BrowserSettings }
export type FileStore = "config" | "policy" | "project";
export function defaultConfig(): ConfigSettings {
  return {
    agents: { claude: { model: "opus", effort: "high", authentication: "subscription", integrations: "disabled" }, codex: { model: "gpt-6-astra", effort: "high" } },
    approval: { mode: "untrusted" }, isolation: { policy: "workspace-write" },
    observation: { repositories: [], claude: true, codex: true, kit: true },
    notifications: { quietStart: "22:00", quietEnd: "08:00", timezone: "UTC", approvalException: true },
    storage: { scope: "tool_output", bodyRetentionDays: 90, metadataRetentionDays: null, redaction: { defaults: true, patterns: [] } },
    dashboard: { port: DEFAULT_SETTINGS_PORT },
    keys: { command: "Cmd+K", home: "g h", workspace: "g w", inbox: "g i", tree: "g t", changes: "g c", next: "j", previous: "k", allow: "a", deny: "d", interrupt: "Esc", help: "?" },
  };
}
export function defaultProject(): ProjectSettings { return { isolation: { policy: null }, acceptance: { commands: [] }, scope: { exclude: [] } }; }
export function defaultBrowser(): BrowserSettings { return { theme: "system", density: "comfortable", diff: "side-by-side", time: "relative", language: "en", notifications: { approval: "both", input: "both", completed: "in-app", failed: "both", reviewInvalidated: "in-app", unknown: "in-app", runnerFailure: "both", apiFailure: "both", disconnected: "in-app" } }; }
export function getDefaults<S extends keyof SettingsByStore>(store: S): SettingsByStore[S] {
  return ({ config: defaultConfig(), policy: defaultPolicy(), project: defaultProject(), browser: defaultBrowser() })[store];
}
export function mergeSettings(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const result = structuredClone(base) as Record<string, unknown>;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new TypeError("Invalid settings object");
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(result, key)) throw new TypeError("Unknown setting field");
    result[key] = value && typeof value === "object" && !Array.isArray(value) ? mergeSettings(result[key], value) : structuredClone(value);
  }
  return result;
}
function assertChoice(value: string, choices: string[], path: string): void { if (!choices.includes(value)) throw new TypeError(`Invalid ${path}`); }
export function validateSettings<S extends keyof SettingsByStore>(store: S, input: unknown): SettingsByStore[S] {
  const defaults = getDefaults(store);
  const value = mergeSettings(defaults, input) as SettingsByStore[S];
  function check(actual: unknown, expected: unknown, path: string): void {
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) throw new TypeError(`Invalid ${path}`);
      if (expected.length) for (const entry of actual) check(entry, expected[0], path);
      else if (actual.some((entry) => typeof entry !== "string")) throw new TypeError(`Invalid ${path}`);
    } else if (expected !== null && typeof expected === "object") {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new TypeError(`Invalid ${path}`);
      for (const [key, child] of Object.entries(expected)) check((actual as Record<string, unknown>)[key], child, `${path}.${key}`);
    } else if (expected === null) {
      if (path === "project.isolation.policy" && typeof actual === "string") return;
      if (actual !== null && (typeof actual !== "number" || !Number.isSafeInteger(actual) || actual < 0)) throw new TypeError(`Invalid ${path}`);
    } else if (typeof actual !== typeof expected || typeof actual === "number" && (!Number.isFinite(actual) || actual < 0) || typeof actual === "string" && !actual.trim()) throw new TypeError(`Invalid ${path}`);
  }
  // 候補と制約の配列は可変の形を持つため、個別に検証する。
  if (store === "policy") {
    const p = value as Policy;
    check({ ...p, roles: defaults && (defaults as Policy).roles, constraints: [] }, { ...defaultPolicy(), constraints: [] }, "policy");
    if (!p.roles || typeof p.roles !== "object" || Array.isArray(p.roles)
      || Object.keys(p.roles).some((role) => !Object.hasOwn(defaultPolicy().roles, role))) throw new TypeError("Invalid roles");
    for (const entries of Object.values(p.roles)) {
      if (!Array.isArray(entries)) throw new TypeError("Invalid roles");
      for (const c of entries) {
        if (!c || typeof c.model !== "string" || !c.model.trim()) throw new TypeError("Invalid candidate");
        if (Object.keys(c).some((key) => !["executor", "model", "family", "tier"].includes(key))) throw new TypeError("Unknown candidate field");
        assertChoice(c.executor, ["claude", "codex"], "executor"); assertChoice(c.family, ["anthropic", "openai"], "family"); assertChoice(c.tier, ["high", "mid", "low"], "tier");
      }
    }
    if (!Array.isArray(p.constraints)) throw new TypeError("Invalid constraints");
    for (const c of p.constraints) {
      if (!c || typeof c !== "object") throw new TypeError("Invalid constraint");
      assertChoice(c.kind, ["reviewerDifferentFamily", "implementerNotOrchestrator", "minTierForRole"], "constraint");
      if (Object.keys(c).some((key) => !(c.kind === "minTierForRole" ? ["kind", "role", "tier"] : ["kind"]).includes(key))) throw new TypeError("Unknown constraint field");
      if (c.kind === "minTierForRole") { assertChoice(c.role, Object.keys(p.roles), "role"); assertChoice(c.tier, ["high", "mid", "low"], "tier"); }
    }
    if (!Number.isSafeInteger(p.maxRoundTrips) || !Number.isSafeInteger(p.performance.minSamples) || p.quota.softLimitPercent > p.quota.hardLimitPercent || p.quota.hardLimitPercent > 100) throw new TypeError("Invalid policy limits");
    return value;
  }
  check(value, defaults, store);
  if (store === "config") {
    const c = value as ConfigSettings;
    assertChoice(c.agents.claude.authentication, ["subscription", "api_key"], "authentication");
    assertChoice(c.agents.claude.integrations, ["disabled", "strict", "enabled"], "integrations");
    assertChoice(c.approval.mode, ["untrusted", "on-request", "never"], "approval.mode");
    assertChoice(c.storage.scope, ["metadata", "message_body", "tool_output", "full_diff"], "storage.scope");
    if (!Number.isSafeInteger(c.dashboard.port) || c.dashboard.port < 1 || c.dashboard.port > MAX_PORT || c.dashboard.port === LEGACY_DAEMON_PORT) throw new TypeError("Invalid dashboard.port");
    if (!Number.isSafeInteger(c.storage.bodyRetentionDays)) throw new TypeError("Invalid retention");
    if (validateRules(c.storage.redaction).length) throw new TypeError("Invalid redaction pattern");
    for (const time of [c.notifications.quietStart, c.notifications.quietEnd]) if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new TypeError("Invalid quiet time");
    try { new Intl.DateTimeFormat("en", { timeZone: c.notifications.timezone }); } catch { throw new TypeError("Invalid timezone"); }
    const keys = Object.values(c.keys).map((key) => key.trim().toLowerCase().replace(/\s+/g, " "));
    if (new Set(keys).size !== keys.length) throw new TypeError("Duplicate key binding");
  }
  if (store === "config" || store === "project") {
    const policy = (value as ConfigSettings | ProjectSettings).isolation.policy;
    if (policy !== null) assertChoice(policy, ["read-only", "workspace-write", "danger-full-access"], "isolation.policy");
  }
  if (store === "browser") {
    const b = value as BrowserSettings;
    for (const [key, choices] of Object.entries({ theme: ["system", "light", "dark"], density: ["comfortable", "compact"], diff: ["side-by-side", "unified"], time: ["relative", "absolute"], language: ["en", "ja"] })) assertChoice(b[key as "theme"], choices, key);
    for (const route of Object.values(b.notifications)) assertChoice(route, ["in-app", "browser", "both", "off"], "notifications");
  }
  return value;
}
