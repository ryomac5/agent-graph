import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Candidate, Role, Tier, Weight } from "../delegate/types.ts";

export const ROLES: Role[] = ["orchestrate", "implement", "research", "document", "review", "advisor", "plan", "proofread"];
export const WEIGHTS: Weight[] = ["light", "standard", "heavy"];
export type RoleModels = Candidate[] | Partial<Record<Weight, Candidate[]>>;
export interface ModelNote { model: string; latest: boolean; strength: string; specialties: string }
export type Constraint = { kind: "reviewerDifferentFamily" } | { kind: "implementerNotOrchestrator" }
  | { kind: "minTierForRole"; role: Role; tier: Tier };
export interface Policy {
  maxRoundTrips: number;
  roles: Record<Role, RoleModels>;
  criteria: Partial<Record<Role, Partial<Record<Weight, string>>>>;
  modelNotes: ModelNote[];
  quota: { softLimitPercent: number; hardLimitPercent: number };
  performance: { minSamples: number; weights: { acceptRate: number; reviewApprove: number; roundTrips: number; tokens: number } };
  constraints: Constraint[];
}
const claude = (model: string): Candidate => ({ executor: "claude", model, family: "anthropic", tier: model === "sonnet" ? "mid" : "high" });
const codex = (model: string, effort: string): Candidate => ({ executor: "codex", model, effort, family: "openai", tier: model === "gpt-6-astra" ? "high" : "mid" });
export function defaultPolicy(): Policy {
  return {
    maxRoundTrips: 2,
    roles: {
      implement: { light: [codex("gpt-6.1-sol", "low"), claude("opus")], standard: [codex("gpt-6-astra", "high"), claude("opus")], heavy: [codex("gpt-6-astra", "xhigh"), claude("opus")] },
      review: { light: [claude("opus"), codex("gpt-6-astra", "high")], standard: [claude("opus"), codex("gpt-6-astra", "high")], heavy: [claude("fable"), codex("gpt-6-astra", "xhigh")] },
      research: { standard: [claude("sonnet")] },
      document: { light: [claude("sonnet")], standard: [claude("opus")], heavy: [claude("opus")] },
      orchestrate: { standard: [claude("opus")] }, advisor: { standard: [claude("fable")] }, plan: { standard: [claude("opus")] },
      proofread: { standard: [{ executor: "antigravity", model: "gemini-3.8-flash-high", family: "google", tier: "high" }] },
    },
    criteria: {
      implement: { light: "1 ファイルの小さな直しや、名前の置き換え。", standard: "1 つのパッケージの中の機能の追加。", heavy: "複数のパッケージにまたがる変更、設計を伴う変更、性能や安全の直し。" },
      review: { light: "見た目や文言の差分。", standard: "ふつうの差分。", heavy: "台帳、権限、安全に触る差分。" },
      document: { light: "150 行以下の 1 ファイル。", heavy: "長い文書や設計書。" },
    },
    modelNotes: [
      { model: "gpt-6-astra", latest: false, strength: "SWE-bench で最上位。", specialties: "" },
      { model: "gemini-3.8-flash", latest: false, strength: "", specialties: "日本語の性能が高い。" },
    ],
    quota: { softLimitPercent: 70, hardLimitPercent: 90 },
    performance: { minSamples: 20, weights: { acceptRate: 0.4, reviewApprove: 0.3, roundTrips: 0.2, tokens: 0.1 } },
    constraints: [{ kind: "reviewerDifferentFamily" }, { kind: "implementerNotOrchestrator" }],
  };
}
export function getCandidates(policy: Policy, role: Role, weight: Weight = "standard"): Candidate[] {
  const entry = policy.roles[role];
  return Array.isArray(entry) ? entry : entry?.[weight] ?? entry?.standard ?? [];
}
export function staticPolicyTable(): Record<Role, Candidate[]> {
  const policy = defaultPolicy();
  return Object.fromEntries(ROLES.map(role => [role, getCandidates(policy, role)])) as Record<Role, Candidate[]>;
}
function readObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
export function validatePolicyOverride(value: unknown): Partial<Policy> {
  const object = readObject(value, "policy");
  const defaults = defaultPolicy();
  for (const key of Object.keys(object)) if (!Object.hasOwn(defaults, key)) throw new TypeError(`Unknown policy field: ${key}`);
  const choice = (value: unknown, choices: string[], name: string) => { if (typeof value !== "string" || !choices.includes(value)) throw new TypeError(`Invalid ${name}`); };
  const number = (value: unknown, name: string) => { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`Invalid ${name}`); };
  if (object.maxRoundTrips !== undefined) { number(object.maxRoundTrips, "maxRoundTrips"); if (!Number.isSafeInteger(object.maxRoundTrips)) throw new TypeError("Invalid maxRoundTrips"); }
  if (object.roles !== undefined) for (const [role, entries] of Object.entries(readObject(object.roles, "roles"))) {
    choice(role, ROLES, "role");
    const bands = Array.isArray(entries) ? { standard: entries } : readObject(entries, `roles.${role}`);
    for (const [weight, list] of Object.entries(bands)) {
      choice(weight, WEIGHTS, "weight");
      if (!Array.isArray(list)) throw new TypeError("Invalid candidates");
      for (const value of list) {
        const c = readObject(value, "candidate");
        if (Object.keys(c).some(key => !["executor", "model", "effort", "family", "tier"].includes(key))) throw new TypeError("Unknown candidate field");
        choice(c.executor, ["claude", "codex", "antigravity"], "executor"); choice(c.family, ["anthropic", "openai", "google"], "family"); choice(c.tier, ["high", "mid", "low"], "tier");
        if (c.family !== ({ claude: "anthropic", codex: "openai", antigravity: "google" } as Record<string, string>)[String(c.executor)]) throw new TypeError("Invalid candidate family");
        if (typeof c.model !== "string" || !c.model.trim() || c.effort !== undefined && (typeof c.effort !== "string" || !c.effort.trim())) throw new TypeError("Invalid candidate");
      }
    }
  }
  if (object.criteria !== undefined) for (const [role, bands] of Object.entries(readObject(object.criteria, "criteria"))) {
    choice(role, ROLES, "role");
    for (const [weight, text] of Object.entries(readObject(bands, "criteria"))) { choice(weight, WEIGHTS, "weight"); if (typeof text !== "string") throw new TypeError("Invalid criteria"); }
  }
  if (object.modelNotes !== undefined) {
    if (!Array.isArray(object.modelNotes)) throw new TypeError("Invalid modelNotes");
    const models = new Set<string>();
    for (const value of object.modelNotes) {
      const n = readObject(value, "model note");
      if (Object.keys(n).some(key => !["model", "latest", "strength", "specialties"].includes(key)) || typeof n.model !== "string" || !n.model.trim() || typeof n.latest !== "boolean" || typeof n.strength !== "string" || typeof n.specialties !== "string" || models.has(n.model)) throw new TypeError("Invalid model note");
      models.add(n.model);
    }
  }
  for (const key of ["quota", "performance"] as const) if (object[key] !== undefined) {
    const section = readObject(object[key], key);
    for (const [field, value] of Object.entries(section)) {
      if (!Object.hasOwn(defaults[key], field)) throw new TypeError(`Invalid ${key}.${field}`);
      if (field === "weights") for (const [name, weight] of Object.entries(readObject(value, "weights"))) {
        if (!Object.hasOwn(defaults.performance.weights, name)) throw new TypeError("Invalid performance weight"); number(weight, name);
      } else number(value, field);
    }
  }
  if (object.constraints !== undefined) {
    if (!Array.isArray(object.constraints)) throw new TypeError("Invalid constraints");
    for (const value of object.constraints) {
      const c = readObject(value, "constraint");
      choice(c.kind, ["reviewerDifferentFamily", "implementerNotOrchestrator", "minTierForRole"], "constraint");
      if (Object.keys(c).some(key => !(c.kind === "minTierForRole" ? ["kind", "role", "tier"] : ["kind"]).includes(key))) throw new TypeError("Unknown constraint field");
      if (c.kind === "minTierForRole") { choice(c.role, ROLES, "role"); choice(c.tier, ["high", "mid", "low"], "tier"); }
    }
  }
  return object as Partial<Policy>;
}
export function mergePolicy(base: Policy, value: unknown): Policy {
  const patch = structuredClone(validatePolicyOverride(value));
  const roles = { ...base.roles };
  for (const [role, entry] of Object.entries(patch.roles ?? {})) {
    // 旧形式の候補列は standard にだけ適用する。
    const previous = roles[role as Role];
    roles[role as Role] = Array.isArray(entry) ? { ...(Array.isArray(previous) ? { standard: previous } : previous), standard: entry } : structuredClone(entry);
  }
  const criteria = structuredClone(base.criteria);
  for (const [role, bands] of Object.entries(patch.criteria ?? {})) criteria[role as Role] = { ...criteria[role as Role], ...bands };
  const policy = { ...base, ...patch, roles, criteria, quota: { ...base.quota, ...patch.quota }, performance: { ...base.performance, ...patch.performance, weights: { ...base.performance.weights, ...patch.performance?.weights } } };
  if (!Number.isSafeInteger(policy.performance.minSamples) || policy.quota.softLimitPercent > policy.quota.hardLimitPercent || policy.quota.hardLimitPercent > 100) throw new TypeError("Invalid policy limits");
  return policy;
}
export function parsePolicyToml(text: string): Partial<Policy> {
  const root: Record<string, unknown> = {};
  let target = root;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    // JSON の文字列中の # は注釈として扱わない。
    const line = raw.replace(/#(?=(?:[^"\\]*(?:\\.[^"\\]*)*"[^"\\]*(?:\\.[^"\\]*)*")*[^"\\]*$).*$/, "").trim();
    if (!line) continue;
    const header = /^(?:\[\[([\w.-]+)\]\]|\[([\w.-]+)\])$/.exec(line);
    if (header) {
      const parts = (header[1] ?? header[2]).split("."); target = root;
      for (const key of parts.slice(0, -1)) { if (["__proto__", "constructor", "prototype"].includes(key)) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`); target[key] ??= {}; target = readObject(target[key], key); }
      const key = parts.at(-1)!;
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
      if (header[1]) { target[key] ??= []; if (!Array.isArray(target[key])) throw new TypeError("Invalid table"); const entry = {}; (target[key] as unknown[]).push(entry); target = entry; }
      else { target[key] ??= {}; target = readObject(target[key], key); }
      continue;
    }
    const pair = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!pair || ["__proto__", "constructor", "prototype"].includes(pair[1])) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
    let value: unknown;
    try { value = JSON.parse(pair[2]); } catch { throw new SyntaxError(`Unsupported TOML at line ${index + 1}`); }
    if (Object.hasOwn(target, pair[1])) throw new SyntaxError(`Duplicate TOML at line ${index + 1}`);
    target[pair[1]] = value;
    if (target === root.review && pair[1] === "max_round_trips" && (typeof value !== "number" || value < 0)) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
  }
  if (root.review) { const review = readObject(root.review, "review"); if (Object.keys(review).some(key => key !== "max_round_trips")) throw new TypeError("Invalid review"); root.maxRoundTrips = review.max_round_trips; delete root.review; }
  try { return validatePolicyOverride(root); } catch (error) { if (error instanceof TypeError && error.message.startsWith("Invalid quota.")) throw new SyntaxError(`Unsupported TOML at line ${text.trimEnd().split(/\r?\n/).length}`); throw error; }
}
export function loadPolicy(options: { path?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): Policy {
  const env = options.env ?? process.env;
  const path = options.path ?? join(env.XDG_CONFIG_HOME || join(options.home ?? homedir(), ".config"), "agent-graph", "policy.toml");
  let policy = defaultPolicy();
  if (existsSync(path)) policy = mergePolicy(policy, parsePolicyToml(readFileSync(path, "utf8")));
  if (env.AGENT_GRAPH_POLICY_JSON) policy = mergePolicy(policy, JSON.parse(readFileSync(env.AGENT_GRAPH_POLICY_JSON, "utf8")));
  return policy;
}
export function policyVersion(policy: Policy): string { return `policy-${createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 8)}`; }
