import { defaultConfig, defaultProject, validateSettings, type ConfigSettings, type ProjectSettings } from "../../core/src/settings/index.ts";
import { defaultPolicy, type Policy } from "../../core/src/assign/policy.ts";
import type { JsonValue } from "../../core/src/ledger/facts.ts";
import type { SocketRequest, ClientRole } from "./socket.ts";

export interface RunnerSettingsHooks {
  activeClaudeRuns(): string[];
  recordApprovalRelaxed(runId: string, mode: ConfigSettings["approval"]["mode"]): void;
  activeRuns(): string[];
}
// 境界ごとに値を読む。既存の StartRequest や割り当ては書き換えない。
export class RunnerSettings {
  private config = defaultConfig();
  private policy = defaultPolicy();
  private projects = new Map<string, ProjectSettings>();
  private hooks: RunnerSettingsHooks;
  constructor(hooks: RunnerSettingsHooks) { this.hooks = hooks; }
  validateConfig(input: unknown, confirmAuthenticationChange = false): ConfigSettings {
    const next = validateSettings("config", input);
    if (next.agents.claude.authentication !== this.config.agents.claude.authentication && this.hooks.activeClaudeRuns().length && !confirmAuthenticationChange) throw new Error("Active Claude conversations require authentication change confirmation");
    return next;
  }
  applyConfig(input: unknown, confirmAuthenticationChange = false): void {
    const next = this.validateConfig(input, confirmAuthenticationChange);
    const rank = { untrusted: 0, "on-request": 1, never: 2 };
    if (rank[next.approval.mode] > rank[this.config.approval.mode]) for (const run of this.hooks.activeRuns()) this.hooks.recordApprovalRelaxed(run, next.approval.mode);
    this.config = next;
  }
  applyPolicy(input: unknown): void { this.policy = validateSettings("policy", input); }
  applyProject(repositoryId: string, input: unknown): void { this.projects.set(repositoryId, validateSettings("project", input)); }
  forNewConversation<P extends "claude" | "codex">(provider: P): ConfigSettings["agents"][P] { return structuredClone(this.config.agents[provider]); }
  forNextTurn() { return structuredClone(this.config.approval); }
  forNewFact(): Pick<ConfigSettings["storage"], "scope" | "redaction"> {
    return { scope: this.config.storage.scope, redaction: structuredClone(this.config.storage.redaction) };
  }
  forNextCleanup(): Pick<ConfigSettings["storage"], "bodyRetentionDays" | "metadataRetentionDays"> {
    return { bodyRetentionDays: this.config.storage.bodyRetentionDays, metadataRetentionDays: this.config.storage.metadataRetentionDays };
  }
  forNextExecution(repositoryId?: string) { return { policy: this.projects.get(repositoryId ?? "")?.isolation.policy ?? this.config.isolation.policy }; }
  forNextDelegation(repositoryId?: string): { policy: Policy; project: ProjectSettings } { return { policy: structuredClone(this.policy), project: structuredClone(this.projects.get(repositoryId ?? "") ?? defaultProject()) }; }
  handleRequest(request: SocketRequest, role: ClientRole): JsonValue {
    if (role !== "api") throw new Error("Settings require the api connection");
    if (!["runner.settings.preflight", "runner.settings.apply"].includes(request.command)) throw new Error("Unknown runner settings command");
    const payload = request.payload as Record<string, JsonValue> | undefined;
    if (!payload || !["config", "policy", "project"].includes(payload.store as string)) throw new Error("Invalid settings store");
    const apply = request.command === "runner.settings.apply";
    if (payload.store === "config") {
      this.validateConfig(payload.value, payload.confirmation === true);
      if (apply) this.applyConfig(payload.value, payload.confirmation === true);
    } else if (payload.store === "policy") {
      validateSettings("policy", payload.value);
      if (apply) this.applyPolicy(payload.value);
    } else {
      if (typeof payload.repositoryId !== "string" || !payload.repositoryId) throw new Error("Repository ID required");
      validateSettings("project", payload.value);
      if (apply) this.applyProject(payload.repositoryId, payload.value);
    }
    return { [apply ? "applied" : "valid"]: true };
  }
}
