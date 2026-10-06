import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FactInput, JsonValue, Ledger } from "../../../core/src/ledger/index.ts";

export const HOOK_REQUEST_TIMEOUT_MS = 5000;
export const HOOK_PATH = "/hook-v2";
const LEDGER_READ_BATCH_SIZE = 1000;

export interface HookEvent {
  version: 1;
  session_id: string;
  generation: number;
  event_id: string;
  hook_event_name: string;
  source_ts: string;
  input: { [key: string]: JsonValue };
  managed: boolean;
  run_id?: string;
}

export function parseHookEvent(value: unknown): HookEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid hook event");
  const event = value as HookEvent;
  if (event.version !== 1 || ![event.session_id, event.event_id, event.hook_event_name].every(
    (field) => typeof field === "string" && field.length > 0,
  ) || !Number.isSafeInteger(event.generation) || event.generation < 1
    || typeof event.source_ts !== "string" || !Number.isFinite(Date.parse(event.source_ts))
    || typeof event.managed !== "boolean" || !event.input || typeof event.input !== "object"
    || Array.isArray(event.input) || (event.run_id !== undefined && (typeof event.run_id !== "string" || !event.run_id))) {
    throw new TypeError("Invalid hook event");
  }
  return event;
}

export function createHookFacts(event: HookEvent): FactInput[] {
  const source_event_id = JSON.stringify([event.session_id, event.generation, event.event_id]);
  const conversationId = `claude:${event.session_id}`;
  const runId = event.run_id ?? `${conversationId}:${event.generation}`;
  const base = { source: "hook" as const, source_event_id, source_ts: event.source_ts, confidence: "confirmed" as const };
  const evidence = {
    hook_event_name: event.hook_event_name, event_id: event.event_id,
    generation: event.generation, auxiliary: event.managed, input: event.input,
  };
  // 管理する実行はホストが正本。hook から状態や終了の根拠を作らない。
  if (event.managed) return [{ ...base, kind: "run.updated", subject: `run:${runId}`,
    payload: { generation: event.generation, last_evidence: evidence, last_evidence_ts: event.source_ts } }];
  const conversation: FactInput = { ...base, source_event_id: `${source_event_id}:conversation`,
    kind: "conversation.created", subject: `conversation:${conversationId}`,
    payload: { provider: "claude", native_id: event.session_id, origin: "observed",
      type: event.input.entrypoint === "sdk-cli" ? "unattended" : "interactive",
      history_format: "jsonl" } };
  const run: FactInput = { ...base, kind: "run.updated", subject: `run:${runId}`,
    payload: { conversation_id: conversationId, generation: event.generation,
      last_evidence: evidence, last_evidence_ts: event.source_ts } };
  if (event.hook_event_name === "SessionStart") {
    return [conversation, { ...run, kind: "run.created", payload: { ...run.payload, conversation_id: conversationId,
      generation: event.generation, state: "idle", started_ts: event.source_ts } }];
  } else if (event.hook_event_name === "SessionEnd") {
    run.payload = { ...run.payload, state: "ended", ended_ts: event.source_ts,
      end_evidence: { kind: "session_end", generation: event.generation } };
  } else if (event.hook_event_name === "Stop") run.payload = { ...run.payload, state: "idle" };
  else if (event.hook_event_name === "UserPromptSubmit") run.payload = { ...run.payload, state: "running" };
  return [conversation, run];
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createHookHandler(ledger: Ledger, token: string) {
  const conversations = new Set<string>();
  let lastSeq = 0;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const port = request.socket.localPort;
    const host = request.headers.host;
    const sent = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.socket.remoteAddress !== "127.0.0.1" || host !== `127.0.0.1:${port}`
      || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)
      || sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
      respond(response, 403, { accepted: false });
      return;
    }
    if (request.method !== "POST" || request.url !== HOOK_PATH) {
      respond(response, 404, { accepted: false });
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      respond(response, 415, { accepted: false });
      return;
    }
    let event: HookEvent;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      event = parseHookEvent(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      respond(response, 400, { accepted: false });
      return;
    }
    try {
      // 台帳の続きから作成済みの会話を確認し、再起動や別の取り込みでも重複させない。
      for (;;) {
        const facts = ledger.readSince(lastSeq, LEDGER_READ_BATCH_SIZE);
        for (const fact of facts) {
          if (fact.kind === "conversation.created") conversations.add(fact.subject);
          lastSeq = fact.seq;
        }
        if (facts.length < LEDGER_READ_BATCH_SIZE) break;
      }
      const results = createHookFacts(event)
        .filter((fact) => fact.kind !== "conversation.created" || !conversations.has(fact.subject))
        .map((fact) => {
          const result = ledger.append(fact);
          if (fact.kind === "conversation.created" && result.status !== "conflict") conversations.add(fact.subject);
          return result;
        });
      if (results.some((result) => result.status === "conflict")) {
        respond(response, 409, { accepted: false, event_id: event.event_id });
        return;
      }
      respond(response, 200, { accepted: true, event_id: event.event_id,
        generation: event.generation, session_id: event.session_id, results });
    } catch {
      respond(response, 503, { accepted: false });
    }
  };
}

export async function startHookServer(ledger: Ledger, port = 0) {
  const token = randomBytes(32).toString("base64url");
  const server = createServer(createHookHandler(ledger, token));
  server.requestTimeout = HOOK_REQUEST_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing hook address");
  return { server, token, url: `http://127.0.0.1:${address.port}${HOOK_PATH}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }) };
}
