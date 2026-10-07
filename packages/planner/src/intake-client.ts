import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { IntakeRequest, IntakeStatus } from "../../core/src/intake/index.ts";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 200;
const MAX_SEND_ATTEMPTS = 3;
const STATUS_POLL_MS = 200;
const TERMINAL_STATES = new Set(["done", "failed", "interrupted", "denied"]);
export type IntakeOptions = { cwd: string; env: NodeJS.ProcessEnv; socketPath?: string; signal?: AbortSignal;
  connectSocket?: (path: string) => Socket };

export function createPlannerRequestId(graphId: string, taskId: string, attempt: number): string {
  if (!graphId || !taskId || !Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError("Invalid planner request identity");
  return `planner:${JSON.stringify([graphId, taskId, attempt])}`;
}

// モデル名は系統と最低 tier の制約へ写し、最終候補は受付に任せる。
const MODEL_CONSTRAINTS = {
  "gpt-6-astra": { excludeFamily: ["anthropic"], minTier: "high" },
  "gpt-6-sol": { excludeFamily: ["anthropic"], minTier: "mid" },
  opus: { excludeFamily: ["openai"], minTier: "high" },
  fable: { excludeFamily: ["openai"], minTier: "high" },
  sonnet: { excludeFamily: ["openai"], minTier: "mid" },
} satisfies Record<string, NonNullable<IntakeRequest["constraints"]>>;

export function buildPlannerConstraints(task: { model: string; review_model: string }): IntakeRequest["constraints"] {
  if (!task.model) return undefined;
  if (!Object.hasOwn(MODEL_CONSTRAINTS, task.model)) throw new TypeError(`Unsupported model ${JSON.stringify(task.model)}: no intake constraint mapping`);
  const constraints = MODEL_CONSTRAINTS[task.model as keyof typeof MODEL_CONSTRAINTS];
  return { excludeFamily: [...constraints.excludeFamily], minTier: constraints.minTier };
}

// 両方の外部 ID がある場合は推測せず、管理下の実行 ID を優先する。
export function readPlannerOrigin(env: NodeJS.ProcessEnv): Pick<IntakeRequest, "parentRun" | "origin"> {
  if (env.AGENT_GRAPH_MANAGED) return { parentRun: env.AGENT_GRAPH_MANAGED };
  const claude = env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID;
  if (claude && codex) return {};
  if (claude) return { origin: { provider: "claude", nativeId: claude } };
  if (codex) return { origin: { provider: "codex", nativeId: codex } };
  return {};
}

export async function connectIntake(options: IntakeOptions) {
  const env = { ...process.env, ...options.env };
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new TypeError("State directory must be an absolute path");
  const path = options.socketPath ?? join(stateHome, "agent-graph", "runner.sock");
  const origin = readPlannerOrigin(env);
  const sockets = new Set<Socket>();
  let closed = false;
  const close = () => {
    closed = true;
    for (const socket of sockets) socket.destroy(new Error("Intake connection closed"));
    options.signal?.removeEventListener("abort", close);
  };
  options.signal?.addEventListener("abort", close, { once: true });
  if (options.signal?.aborted) close();

  const send = (command: string, payload: unknown, cmdId: string): Promise<IntakeStatus> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Intake connection closed")); return; }
    const socket = (options.connectSocket ?? createConnection)(path);
    sockets.add(socket);
    let ready = false;
    let buffer = "";
    const timer = setTimeout(() => socket.destroy(new Error("Runner response timed out")), REQUEST_TIMEOUT_MS);
    const finish = (error?: Error, status?: IntakeStatus) => {
      clearTimeout(timer);
      sockets.delete(socket);
      socket.destroy();
      if (error) reject(error); else resolve(status!);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(new Error("Runner disconnected")));
    socket.once("connect", () => socket.write(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, role: "cli" }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { finish(new Error("Runner frame too large")); return; }
        let message;
        try { message = JSON.parse(line); }
        catch { finish(new Error("Invalid runner JSON")); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { finish(new Error("Invalid runner frame")); return; }
        if (!ready) {
          if (message.type !== "hello" || message.version !== PROTOCOL_VERSION || message.role !== "runner") {
            finish(new Error("Incompatible runner protocol")); return;
          }
          ready = true;
          socket.write(JSON.stringify({ type: "req", cmd_id: cmdId, command: `intake.${command}`, payload }) + "\n");
        } else if (message.type === "evt") {
          continue;
        } else if (message.type === "res" && message.cmd_id === cmdId && typeof message.ok === "boolean") {
          if (!message.ok) {
            // 受付の拒否は通信障害と区別し、再送しない。
            const error = new Error(String(message.error));
            error.name = "IntakeRejection";
            finish(error);
          } else finish(undefined, message.result as IntakeStatus);
          return;
        } else { finish(new Error("Invalid runner response")); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) finish(new Error("Runner frame too large"));
    });
  });
  const request = async (command: string, payload: unknown): Promise<IntakeStatus> => {
    // 応答の喪失では同じ cmd_id と依頼を再送する。status の各照会は別 ID にする。
    const cmdId = randomUUID();
    for (let attempt = 1; ; attempt++) {
      try { return await send(command, payload, cmdId); }
      catch (error) {
        if (closed || attempt >= MAX_SEND_ATTEMPTS || error instanceof Error && error.name === "IntakeRejection") throw error;
        await delay(RECONNECT_MS);
      }
    }
  };
  const submit = (submission: IntakeRequest) => request("submit", { ...submission, ...origin, source: "planner" });
  const status = (requestId: string) => request("status", { requestId });
  const retry = (requestId: string) => request("retry", { requestId });
  return {
    submit, status, retry, close,
    async delegate(submission: IntakeRequest) {
      let current = await submit(submission);
      while (!TERMINAL_STATES.has(current.state)) {
        await delay(STATUS_POLL_MS);
        current = await status(submission.requestId);
      }
      if (!current.result) throw new Error(current.reason ?? `Delegation ${current.requestId}: ${current.state}`);
      return current.result;
    },
  };
}
