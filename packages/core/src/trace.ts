import { randomBytes } from "node:crypto";

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
}

export interface TraceState {
  sessionId?: string;
  delegationId?: string;
  members: string[];
}

const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const AGENT_MEMBER = "agent-graph=";
const AGENT_STATE_PATTERN = /^agent-graph=session:([^;,=\s]+);delegation:([^;,=\s]+)$/;
const INVALID_STATE_ID_PATTERN = /[;,=\s]/;

function newId(bytes: number): string {
  let id: string;
  do {
    id = randomBytes(bytes).toString("hex");
  } while (/^0+$/.test(id));
  return id;
}

export function newTraceId(): string {
  return newId(TRACE_ID_BYTES);
}

export function newSpanId(): string {
  return newId(SPAN_ID_BYTES);
}

export function formatTraceparent(context: TraceContext): string {
  const value = `00-${context.traceId}-${context.spanId}-01`;
  if (!parseTraceparent(value)) {
    throw new TypeError("Invalid trace context IDs");
  }
  return value;
}

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (typeof value !== "string") return undefined;
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match || match[0] !== value) return undefined;
  const [, traceId, spanId] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

export function parseTracestate(value: string | undefined): TraceState {
  const state: TraceState = { members: [] };
  for (const member of value?.split(",") ?? []) {
    const normalized = member.trim();
    if (!normalized) continue;
    const match = AGENT_STATE_PATTERN.exec(normalized);
    if (match) {
      state.sessionId = match[1];
      state.delegationId = match[2];
    }
    state.members.push(normalized);
  }
  return state;
}

export function formatTracestate(state: TraceState): string {
  if (state.sessionId === undefined && state.delegationId === undefined) {
    return state.members.join(",");
  }
  if (!state.sessionId || !state.delegationId ||
      INVALID_STATE_ID_PATTERN.test(state.sessionId) || INVALID_STATE_ID_PATTERN.test(state.delegationId)) {
    throw new TypeError("Invalid session or delegation ID");
  }
  const agent = `${AGENT_MEMBER}session:${state.sessionId};delegation:${state.delegationId}`;
  let replaced = false;
  const members: string[] = [];
  for (const member of state.members) {
    if (member.startsWith(AGENT_MEMBER)) {
      if (!replaced) members.push(agent);
      replaced = true;
    } else {
      members.push(member);
    }
  }
  if (!replaced) members.unshift(agent);
  return members.join(",");
}

export function childContext(parent: TraceContext): TraceContext {
  return { ...parent, spanId: newSpanId(), parentSpanId: parent.spanId };
}

export function toEnv(context: TraceContext): Record<string, string> {
  const env: Record<string, string> = { TRACEPARENT: formatTraceparent(context) };
  if (context.traceState !== undefined) env.TRACESTATE = context.traceState;
  // TRACEPARENT は現在の span のみを持つため、親は補助変数で渡す。
  if (context.parentSpanId !== undefined) {
    if (!isSpanId(context.parentSpanId)) throw new TypeError("Invalid parent span ID");
    env.AGENT_GRAPH_PARENT_SPAN_ID = context.parentSpanId;
  }
  return env;
}

function isSpanId(value: string): boolean {
  return value.length === SPAN_ID_BYTES * 2 && SPAN_ID_PATTERN.test(value) && !/^0+$/.test(value);
}

export function fromEnv(env: Record<string, string | undefined> = process.env): TraceContext | undefined {
  const context = parseTraceparent(env.TRACEPARENT);
  if (!context) return undefined;
  if (env.TRACESTATE !== undefined) context.traceState = env.TRACESTATE;
  const parentSpanId = env.AGENT_GRAPH_PARENT_SPAN_ID;
  if (parentSpanId !== undefined) {
    if (!isSpanId(parentSpanId)) return undefined;
    context.parentSpanId = parentSpanId;
  }
  return context;
}
