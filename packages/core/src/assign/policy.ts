import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Candidate, Role, Tier } from "../delegate/types.ts";

export function staticPolicyTable(): Record<Role, Candidate[]> {
  return {
    implement: [
      { executor: "codex", model: "gpt-6-astra", family: "openai", tier: "high" },
      { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "mid" },
      { executor: "claude", model: "opus", family: "anthropic", tier: "high" },
    ],
    review: [
      { executor: "claude", model: "fable", family: "anthropic", tier: "high" },
      { executor: "codex", model: "gpt-6-astra", family: "openai", tier: "high" },
    ],
    research: [
      { executor: "claude", model: "sonnet", family: "anthropic", tier: "mid" },
      { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "mid" },
    ],
    document: [
      { executor: "claude", model: "sonnet", family: "anthropic", tier: "mid" },
      { executor: "claude", model: "opus", family: "anthropic", tier: "high" },
    ],
    orchestrate: [{ executor: "claude", model: "fable", family: "anthropic", tier: "high" }],
  };
}

export type Constraint =
  | { kind: "reviewerDifferentFamily" }
  | { kind: "implementerNotOrchestrator" }
  | { kind: "minTierForRole"; role: Role; tier: Tier };
export interface Policy {
  maxRoundTrips: number;
  roles: Record<Role, Candidate[]>;
  quota: { softLimitPercent: number; hardLimitPercent: number };
  performance: { minSamples: number; weights: { acceptRate: number; reviewApprove: number; roundTrips: number; tokens: number } };
  constraints: Constraint[];
}
export function defaultPolicy(): Policy {
  return {
    maxRoundTrips: 2,
    roles: staticPolicyTable(),
    quota: { softLimitPercent: 70, hardLimitPercent: 90 },
    performance: { minSamples: 20, weights: { acceptRate: 0.4, reviewApprove: 0.3, roundTrips: 0.2, tokens: 0.1 } },
    constraints: [{ kind: "reviewerDifferentFamily" }, { kind: "implementerNotOrchestrator" }],
  };
}
const ROLES: Role[] = ["orchestrate", "implement", "research", "document", "review"];
const FIELDS = ["executor", "model", "family", "tier"] as const;

function validateOverride(value: unknown): Partial<Policy> {
  const record = (input: unknown, name: string): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError(`Invalid ${name}`);
    return input as Record<string, unknown>;
  };
  const object = record(value, "policy");
  if (object.maxRoundTrips !== undefined && (typeof object.maxRoundTrips !== "number" ||
    !Number.isInteger(object.maxRoundTrips) || object.maxRoundTrips < 0)) {
    throw new TypeError("Invalid maxRoundTrips");
  }
  if (object.roles !== undefined) {
    const roles = record(object.roles, "roles");
    for (const [role, entries] of Object.entries(roles)) {
      if (!ROLES.includes(role as Role) || !Array.isArray(entries)) throw new TypeError(`Invalid roles.${role}`);
      for (const entry of entries) {
        const candidate = record(entry, `roles.${role} candidate`);
        if (!FIELDS.every((field) => typeof candidate[field] === "string") ||
          !["claude", "codex"].includes(candidate.executor as string) ||
          !["anthropic", "openai"].includes(candidate.family as string) ||
          !["high", "mid", "low"].includes(candidate.tier as string)) {
          throw new TypeError(`Invalid roles.${role} candidate`);
        }
      }
    }
  }
  for (const [name, fields] of [
    ["quota", ["softLimitPercent", "hardLimitPercent"]],
    ["performance", ["minSamples"]],
  ] as const) {
    if (object[name] === undefined) continue;
    const section = record(object[name], name);
    for (const field of fields) if (section[field] !== undefined &&
      (typeof section[field] !== "number" || !Number.isFinite(section[field]))) throw new TypeError(`Invalid ${name}.${field}`);
  }
  if (object.performance !== undefined) {
    const performance = record(object.performance, "performance");
    if (performance.weights !== undefined) {
      const weights = record(performance.weights, "performance.weights");
      for (const field of ["acceptRate", "reviewApprove", "roundTrips", "tokens"]) {
        if (weights[field] !== undefined && (typeof weights[field] !== "number" || !Number.isFinite(weights[field]))) {
          throw new TypeError(`Invalid performance.weights.${field}`);
        }
      }
    }
  }
  if (object.constraints !== undefined) {
    if (!Array.isArray(object.constraints)) throw new TypeError("Invalid constraints");
    for (const entry of object.constraints) {
      const constraint = record(entry, "constraints entry");
      if (constraint.kind === "minTierForRole") {
        if (!ROLES.includes(constraint.role as Role) || !["high", "mid", "low"].includes(constraint.tier as string)) {
          throw new TypeError("Invalid constraints entry");
        }
      } else if (constraint.kind !== "reviewerDifferentFamily" && constraint.kind !== "implementerNotOrchestrator") {
        throw new TypeError("Invalid constraints entry");
      }
    }
  }
  return object as Partial<Policy>;
}

export function parsePolicyToml(text: string): Partial<Policy> {
  const result: Partial<Policy> = {};
  let section = "";
  let candidate: Partial<Candidate> | undefined;
  let constraint: Record<string, string> | undefined;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const roleMatch = /^\[\[roles\.(\w+)\]\]$/.exec(line);
    if (roleMatch) {
      const role = roleMatch[1] as Role;
      if (!ROLES.includes(role)) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
      result.roles ??= {} as Record<Role, Candidate[]>;
      result.roles[role] ??= [];
      candidate = {};
      result.roles[role].push(candidate as Candidate);
      section = "role";
      continue;
    }
    if (line === "[[constraints]]") {
      result.constraints ??= [];
      constraint = {};
      result.constraints.push(constraint as unknown as Constraint);
      section = "constraint";
      continue;
    }
    if (["[quota]", "[performance]", "[performance.weights]", "[review]"].includes(line)) {
      section = line.slice(1, -1);
      continue;
    }
    const pair = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!pair) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
    const [, key, rawValue] = pair;
    if (section === "constraint" && constraint) {
      if (!["kind", "role", "tier"].includes(key)) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
      const value = /^"([^"\\]*)"$/.exec(rawValue)?.[1];
      if (value === undefined) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
      constraint[key] = value;
      continue;
    }
    if (section === "role" && candidate && FIELDS.includes(key as typeof FIELDS[number])) {
      const value = /^"([^"\\]*)"$/.exec(rawValue)?.[1];
      if (value === undefined || (key === "executor" && !["claude", "codex"].includes(value)) ||
        (key === "family" && !["anthropic", "openai"].includes(value)) ||
        (key === "tier" && !["high", "mid", "low"].includes(value))) {
        throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
      }
      (candidate as unknown as Record<string, string>)[key] = value;
      continue;
    }
    const numeric: Record<string, string[]> = {
      quota: ["softLimitPercent", "hardLimitPercent"], performance: ["minSamples"],
      "performance.weights": ["acceptRate", "reviewApprove", "roundTrips", "tokens"],
    };
    if (section === "review" && key === "max_round_trips" && /^\d+$/.test(rawValue)) {
      result.maxRoundTrips = Number(rawValue);
      continue;
    }
    if (!numeric[section]?.includes(key) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawValue)) {
      throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
    }
    if (section === "quota") {
      result.quota ??= {} as Policy["quota"];
      (result.quota as unknown as Record<string, number>)[key] = Number(rawValue);
    } else {
      result.performance ??= {} as Policy["performance"];
      if (section === "performance") result.performance.minSamples = Number(rawValue);
      else {
        result.performance.weights ??= {} as Policy["performance"]["weights"];
        (result.performance.weights as unknown as Record<string, number>)[key] = Number(rawValue);
      }
    }
  }
  if (result.roles) for (const candidates of Object.values(result.roles)) {
    for (const entry of candidates) if (!FIELDS.every((field) => typeof entry[field] === "string")) {
      throw new SyntaxError("Incomplete TOML role candidate");
    }
  }
  return validateOverride(result);
}

export function loadPolicy(options: { path?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): Policy {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const path = options.path ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "agent-graph", "policy.toml");
  const policy = defaultPolicy();
  const toml = existsSync(path) ? parsePolicyToml(readFileSync(path, "utf8")) : {};
  const json = env.AGENT_GRAPH_POLICY_JSON ? validateOverride(JSON.parse(readFileSync(env.AGENT_GRAPH_POLICY_JSON, "utf8"))) : {};
  for (const override of [toml, json]) {
    if (override.maxRoundTrips !== undefined) policy.maxRoundTrips = override.maxRoundTrips;
    if (override.roles) policy.roles = { ...policy.roles, ...override.roles };
    if (override.quota) policy.quota = { ...policy.quota, ...override.quota };
    if (override.performance) policy.performance = {
      ...policy.performance, ...override.performance,
      weights: { ...policy.performance.weights, ...override.performance.weights },
    };
    if (override.constraints) policy.constraints = override.constraints;
  }
  return policy;
}

export function policyVersion(policy: Policy): string {
  return `policy-${createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 8)}`;
}
