import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Candidate, Role, Tier } from "../delegate/types.ts";
import { staticPolicyTable } from "./static.ts";

export type Constraint =
  | { kind: "reviewerDifferentFamily" }
  | { kind: "implementerNotOrchestrator" }
  | { kind: "minTierForRole"; role: Role; tier: Tier };
export interface Policy {
  roles: Record<Role, Candidate[]>;
  quota: { softLimitPercent: number; hardLimitPercent: number };
  performance: { minSamples: number; weights: { acceptRate: number; reviewApprove: number; roundTrips: number; tokens: number } };
  constraints: Constraint[];
}
export function defaultPolicy(): Policy {
  return {
    roles: staticPolicyTable(),
    quota: { softLimitPercent: 70, hardLimitPercent: 90 },
    performance: { minSamples: 20, weights: { acceptRate: 0.4, reviewApprove: 0.3, roundTrips: 0.2, tokens: 0.1 } },
    constraints: [{ kind: "reviewerDifferentFamily" }, { kind: "implementerNotOrchestrator" }],
  };
}
const ROLES: Role[] = ["orchestrate", "implement", "research", "document", "review"];
const FIELDS = ["executor", "model", "family", "tier"] as const;

export function parsePolicyToml(text: string): Partial<Policy> {
  const result: Partial<Policy> = {};
  let section = "";
  let candidate: Partial<Candidate> | undefined;
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
    if (["[quota]", "[performance]", "[performance.weights]"].includes(line)) {
      section = line.slice(1, -1);
      continue;
    }
    const pair = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!pair) throw new SyntaxError(`Unsupported TOML at line ${index + 1}`);
    const [, key, rawValue] = pair;
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
  return result;
}

export function loadPolicy(options: { path?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): Policy {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const path = options.path ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "agent-graph", "policy.toml");
  const policy = defaultPolicy();
  const toml = existsSync(path) ? parsePolicyToml(readFileSync(path, "utf8")) : {};
  const json = env.AGENT_GRAPH_POLICY_JSON ? JSON.parse(readFileSync(env.AGENT_GRAPH_POLICY_JSON, "utf8")) as Partial<Policy> : {};
  for (const override of [toml, json]) {
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
