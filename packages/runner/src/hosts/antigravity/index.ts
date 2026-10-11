import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentHost, StartRequest, RunHandle, HostEvent, ModelInfo } from "../../host/contract.ts";

// 校正は単発の読み取り専用実行とし、対話や承認を持つホストとしては公開しない。
export class AntigravityHost implements AgentHost {
  readonly provider = "antigravity" as const;
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private binary: string;
  constructor(binary = process.env.AGENT_GRAPH_AGY_BIN || "agy") { this.binary = binary; }
  capabilities() { return { start: true, resume: false, fork: false, interrupt: true, approvals: false, setModel: false, delta: true, degraded: ["resume", "fork", "approvals", "setModel"] }; }
  async start(req: StartRequest): Promise<RunHandle> {
    if (this.children.has(req.runId)) throw new Error("Run already exists");
    const child = spawn(this.binary, ["--print", req.input.text, "--model", req.model.model, "--sandbox", "--mode", "plan", "--output-format", "text",
      ...(req.model.effort ? ["--effort", req.model.effort] : [])], { cwd: req.cwd, env: { ...process.env, ...req.env } });
    this.children.set(req.runId, child);
    child.stdin.end();
    const queue: HostEvent[] = [{ type: "state", state: "running" }];
    let wake: (() => void) | undefined;
    let done = false;
    let body = "";
    let failure = "";
    const emit = (event: HostEvent) => { queue.push(event); wake?.(); wake = undefined; };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; emit({ type: "delta", text: chunk, conversationId: req.conversationId }); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { failure = (failure + chunk).slice(-4096); });
    child.on("error", error => { failure = error.message; });
    child.once("close", code => {
      const id = randomUUID();
      emit({ type: "fact", fact: { kind: "message.created", subject: `message:${id}`, source_event_id: id, source_ts: new Date().toISOString(), confidence: "confirmed",
        payload: { provider: "antigravity", native_id: id, version: 1, role: "assistant", phase: "final_answer", body, body_state: "stored" } } });
      // 発言を会話へ結ぶ事実も同じ実行から記録する。
      emit({ type: "fact", fact: { kind: "message_membership.created", subject: `message_membership:${id}`, source_event_id: randomUUID(), source_ts: new Date().toISOString(), confidence: "confirmed", payload: { message_id: id, conversation_id: req.conversationId, active: true } } });
      emit({ type: "exit", exitCode: code ?? 1, cause: code === 0 ? undefined : failure || "Antigravity interrupted" });
      done = true; this.children.delete(req.runId);
    });
    return { runId: req.runId, nativeId: req.conversationId, pid: child.pid,
      events: (async function* () { while (!done || queue.length) { if (!queue.length) await new Promise<void>(resolve => { wake = resolve; }); while (queue.length) yield queue.shift()!; } })() };
  }
  async resume(): Promise<RunHandle> { throw new Error("Antigravity resume unavailable"); }
  async fork(): Promise<RunHandle> { throw new Error("Antigravity fork unavailable"); }
  async send(): Promise<void> { throw new Error("Antigravity runs are single turn"); }
  async answer(): Promise<void> { throw new Error("Antigravity approvals unavailable"); }
  async setModel(): Promise<void> { throw new Error("Antigravity model changes apply on the next launch"); }
  async interrupt(run: string): Promise<void> { this.children.get(run)?.kill("SIGTERM"); }
  async close(run: string): Promise<void> { this.children.get(run)?.kill("SIGTERM"); }
  async listModels(): Promise<ModelInfo[]> { return []; }
}
