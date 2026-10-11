import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentHost, StartRequest, RunHandle, HostEvent, ModelInfo } from "../../host/contract.ts";

const STDERR_TAIL_LIMIT = 4096;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const EDIT_ONLY_PROMPT = "コマンドは実行できない。ファイルを読み、直すだけにする。受け入れの検査は呼び手が走らせる。";

function snapshotFiles(cwd: string): string | undefined {
  const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd, encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (files.status !== 0) return undefined;
  const hash = createHash("sha256");
  for (const file of [...new Set(files.stdout.split("\0").filter(Boolean))].sort()) {
    const path = join(cwd, file);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    hash.update(JSON.stringify([file, stat?.mode ?? null]));
    if (stat?.isSymbolicLink()) hash.update(readlinkSync(path));
    else if (stat?.isFile()) hash.update(createHash("sha256").update(readFileSync(path)).digest());
  }
  return hash.digest("hex");
}

// 編集の役だけファイル編集を許し、対話やコマンドの承認は持たない。
export class AntigravityHost implements AgentHost {
  readonly provider = "antigravity" as const;
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private binary: string;
  constructor(binary = process.env.AGENT_GRAPH_AGY_BIN || "agy") { this.binary = binary; }
  capabilities() { return { start: true, resume: false, fork: false, interrupt: true, approvals: false, setModel: false, delta: true, degraded: ["resume", "fork", "approvals", "setModel"] }; }
  async start(req: StartRequest): Promise<RunHandle> {
    if (this.children.has(req.runId)) throw new Error("Run already exists");
    const edits = req.role === "proofread" || req.role === "document";
    const before = snapshotFiles(req.cwd);
    const child = spawn(this.binary, ["--print", edits ? `${EDIT_ONLY_PROMPT}\n\n${req.input.text}` : req.input.text, "--model", req.model.model, "--sandbox", "--mode", edits ? "accept-edits" : "plan", "--output-format", "text",
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
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { failure = (failure + chunk).slice(-STDERR_TAIL_LIMIT); });
    child.on("error", error => { failure = error.message; });
    child.once("close", code => {
      const id = randomUUID();
      emit({ type: "fact", fact: { kind: "message.created", subject: `message:${id}`, source_event_id: id, source_ts: new Date().toISOString(), confidence: "confirmed",
        payload: { provider: "antigravity", native_id: id, version: 1, role: "assistant", phase: "final_answer", body, body_state: "stored" } } });
      // 発言を会話へ結ぶ事実も同じ実行から記録する。
      emit({ type: "fact", fact: { kind: "message_membership.created", subject: `message_membership:${id}`, source_event_id: randomUUID(), source_ts: new Date().toISOString(), confidence: "confirmed", payload: { message_id: id, conversation_id: req.conversationId, active: true } } });
      let empty = false;
      if (code === 0 && !body.trim()) {
        try {
          const after = snapshotFiles(req.cwd);
          empty = before === undefined || after === undefined || before === after;
        } catch (error) {
          empty = true;
          failure = `${failure}\nCannot verify file changes: ${error instanceof Error ? error.message : String(error)}`.slice(-STDERR_TAIL_LIMIT);
        }
      }
      emit({ type: "exit", exitCode: empty ? 1 : code ?? 1,
        cause: empty ? `Antigravity produced no final answer or file changes${failure.trim() ? `: ${failure.trim()}` : ""}`
          : code === 0 ? undefined : failure || "Antigravity interrupted" });
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
