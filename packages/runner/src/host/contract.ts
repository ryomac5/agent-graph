import type { FactInput, JsonValue, Provider, RunState } from "../../../core/src/ledger/facts.ts";

export type RunId = string;
export type ApprovalId = string;
export interface ModelChoice { model: string; effort?: string }
export interface ModelInfo extends ModelChoice { displayName: string }
export interface HostCapabilities {
  start: boolean;
  resume: boolean;
  fork: boolean;
  interrupt: boolean;
  approvals: boolean;
  setModel: boolean;
  delta: boolean;
  degraded?: string[];
}
export interface UserInput { text: string; attachments?: JsonValue[] }
export type Decision = string | { decision: string; updatedInput?: JsonValue };
export interface StartRequest {
  runId: RunId;
  conversationId: string;
  generation: number;
  cwd: string;
  input: UserInput;
  model: ModelChoice;
  env?: Record<string, string>;
}
export interface ResumeRequest extends StartRequest { nativeId: string }
export interface ForkRequest extends ResumeRequest { model: ModelChoice }
export type HostFact = {
  [K in FactInput["kind"]]: Omit<Extract<FactInput, { kind: K }>, "source" | "observed_ts">;
}[FactInput["kind"]];
export type HostEvent =
  | { type: "delta"; text: string; conversationId?: string; messageId?: string }
  | { type: "state"; state: Exclude<RunState, "ended" | "failed">; reason?: string }
  | { type: "exit"; exitCode: number; cause?: string; turnId?: string }
  | { type: "fact"; fact: HostFact };
export interface RunHandle {
  runId: RunId;
  nativeId: string;
  pid?: number;
  events: AsyncIterable<HostEvent>;
}
export interface AgentHost {
  readonly provider: Provider;
  capabilities(): HostCapabilities;
  start(req: StartRequest): Promise<RunHandle>;
  resume(req: ResumeRequest): Promise<RunHandle>;
  fork(req: ForkRequest): Promise<RunHandle>;
  send(run: RunId, input: UserInput): Promise<void>;
  interrupt(run: RunId): Promise<void>;
  answer(approval: ApprovalId, decision: Decision): Promise<void>;
  setModel(run: RunId, model: ModelChoice): Promise<void>;
  close(run: RunId): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
}

// 手動で出来事を送れるため、切断や並行実行も再現できる。
export class FakeHost implements AgentHost {
  readonly provider: Provider;
  readonly starts: StartRequest[] = [];
  readonly inputs: { run: RunId; input: UserInput }[] = [];
  readonly decisions: { approval: ApprovalId; decision: Decision }[] = [];
  private queues = new Map<RunId, { events: HostEvent[]; wake?: () => void; ended: boolean }>();
  constructor(provider: Provider = "claude") { this.provider = provider; }
  capabilities(): HostCapabilities {
    return { start: true, resume: true, fork: true, interrupt: true, approvals: true, setModel: true, delta: true };
  }
  async start(req: StartRequest): Promise<RunHandle> {
    if (this.queues.has(req.runId)) throw new Error("Run already exists");
    this.starts.push(req);
    const queue: { events: HostEvent[]; wake?: () => void; ended: boolean } = { events: [], ended: false };
    this.queues.set(req.runId, queue);
    return {
      runId: req.runId, nativeId: req.runId,
      events: (async function* () {
        while (!queue.ended || queue.events.length) {
          if (!queue.events.length) await new Promise<void>((resolve) => { queue.wake = resolve; });
          while (queue.events.length) yield queue.events.shift()!;
        }
      })(),
    };
  }
  resume(req: ResumeRequest): Promise<RunHandle> { return this.start(req); }
  fork(req: ForkRequest): Promise<RunHandle> { return this.start(req); }
  emit(run: RunId, event: HostEvent): void {
    const queue = this.queues.get(run);
    if (!queue || queue.ended) throw new Error("Run is not open");
    queue.events.push(event);
    if (event.type === "exit") queue.ended = true;
    queue.wake?.();
    queue.wake = undefined;
  }
  async send(run: RunId, input: UserInput): Promise<void> { this.inputs.push({ run, input }); }
  async interrupt(run: RunId): Promise<void> { this.emit(run, { type: "state", state: "idle" }); }
  async answer(approval: ApprovalId, decision: Decision): Promise<void> { this.decisions.push({ approval, decision }); }
  async setModel(run: RunId, model: ModelChoice): Promise<void> {
    const request = this.starts.find((request) => request.runId === run);
    if (!request) throw new Error("Unknown run");
    request.model = model;
  }
  async close(run: RunId): Promise<void> { this.emit(run, { type: "exit", exitCode: 0 }); }
  async listModels(): Promise<ModelInfo[]> { return [{ model: "fake", displayName: "Fake model" }]; }
}
