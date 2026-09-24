import assert from "node:assert/strict";
import test from "node:test";
import {
  childContext, formatTraceparent, formatTracestate, fromEnv, newSpanId,
  newTraceId, parseTraceparent, parseTracestate, toEnv,
} from "../src/index.ts";
import type { TraceContext } from "../src/index.ts";

const TRACE_ID = "1234567890abcdef1234567890abcdef";
const SPAN_ID = "1234567890abcdef";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

test("TRACEPARENT と TRACESTATE が環境変数を往復する", () => {
  const context: TraceContext = {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    traceState: "vendor=value,agent-graph=session:session-1;delegation:delegation-1",
  };
  assert.equal(formatTraceparent(context), TRACEPARENT);
  assert.deepEqual(parseTraceparent(TRACEPARENT), { traceId: TRACE_ID, spanId: SPAN_ID });
  assert.deepEqual(fromEnv(toEnv(context)), context);
  const withoutState = { traceId: TRACE_ID, spanId: SPAN_ID };
  assert.deepEqual(toEnv(withoutState), { TRACEPARENT });
  assert.deepEqual(fromEnv(toEnv(withoutState)), withoutState);
});

test("子の文脈を環境変数で渡して親子関係を復元する", () => {
  const parent = { traceId: newTraceId(), spanId: newSpanId(), traceState: "other=kept" };
  const child = childContext(parent);
  assert.equal(child.traceId, parent.traceId);
  assert.notEqual(child.spanId, parent.spanId);
  assert.equal(child.parentSpanId, parent.spanId);
  assert.equal(child.traceState, parent.traceState);
  const env = toEnv(child);
  assert.deepEqual(env, {
    TRACEPARENT: formatTraceparent(child),
    TRACESTATE: child.traceState,
  });
  const received = fromEnv(env);
  assert.deepEqual(received, {
    traceId: child.traceId,
    spanId: child.spanId,
    traceState: child.traceState,
  });
  assert.ok(received);
  assert.equal(Object.hasOwn(received, "parentSpanId"), false);
  const grandchild = childContext(received);
  assert.equal(grandchild.parentSpanId, child.spanId);
  assert.equal(grandchild.traceId, parent.traceId);
  assert.equal(parent.spanId, child.parentSpanId);
});

test("不正な traceparent は例外を投げず undefined を返す", () => {
  const invalid = [
    undefined, "", "junk", TRACEPARENT.replace(/^00/, "ff"),
    TRACEPARENT.replace(/^00/, "01"),
    `00-${"0".repeat(32)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${"0".repeat(16)}-01`,
    `00-${TRACE_ID.slice(1)}-${SPAN_ID}-01`,
    `00-${TRACE_ID}0-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${SPAN_ID.slice(1)}-01`,
    `00-${TRACE_ID}-${SPAN_ID}0-01`,
    `00-${TRACE_ID.toUpperCase()}-${SPAN_ID}-01`,
    `00-${TRACE_ID}-${SPAN_ID.toUpperCase()}-01`,
    TRACEPARENT.replace("a", "g"), TRACEPARENT.slice(0, -1),
    TRACEPARENT.slice(0, -2) + "00", TRACEPARENT.slice(0, -2) + "zz",
    ` ${TRACEPARENT}`, `${TRACEPARENT} `, `${TRACEPARENT}\n`, `${TRACEPARENT}-extra`,
  ];
  for (const value of invalid) {
    assert.equal(parseTraceparent(value), undefined, JSON.stringify(value));
    assert.equal(fromEnv({ TRACEPARENT: value }), undefined, JSON.stringify(value));
  }
  assert.equal(fromEnv({}), undefined);
});

test("ID は小文字 hex、所定の長さ、非ゼロで生成される", () => {
  const traces = new Set<string>();
  const spans = new Set<string>();
  for (let index = 0; index < 100; index += 1) {
    const traceId = newTraceId();
    const spanId = newSpanId();
    assert.match(traceId, /^[0-9a-f]{32}$/);
    assert.match(spanId, /^[0-9a-f]{16}$/);
    assert.notEqual(traceId, "0".repeat(32));
    assert.notEqual(spanId, "0".repeat(16));
    traces.add(traceId);
    spans.add(spanId);
  }
  assert.equal(traces.size, 100);
  assert.equal(spans.size, 100);
});

test("tracestate は他ベンダの順序と値を保持して往復する", () => {
  const values = [
    "agent-graph=session:s1;delegation:d1",
    "first=abc,agent-graph=session:s1;delegation:d1,last=xyz",
    "first=abc,last=xyz", "",
  ];
  for (const value of values) {
    assert.equal(formatTracestate(parseTracestate(value)), value);
  }
  const state = parseTracestate(values[1]);
  assert.equal(state.sessionId, "s1");
  assert.equal(state.delegationId, "d1");
  state.delegationId = "d2";
  assert.equal(formatTracestate(state), "first=abc,agent-graph=session:s1;delegation:d2,last=xyz");
  assert.equal(formatTracestate({ ...parseTracestate("other=value"), sessionId: "s", delegationId: "d" }),
    "agent-graph=session:s;delegation:d,other=value");
  assert.deepEqual(parseTracestate(undefined), { members: [] });
  assert.equal(formatTracestate(parseTracestate("first=abc, last=xyz")), "first=abc,last=xyz");
});

test("formatter は不正な ID を拒否する", () => {
  assert.throws(() => formatTraceparent({ traceId: "bad", spanId: SPAN_ID }), TypeError);
  for (const sessionId of ["", "a,b", "a;b", "a=b", "a b", "a\n"]) {
    assert.throws(() => formatTracestate({ sessionId, delegationId: "d", members: [] }), TypeError);
  }
  assert.throws(() => formatTracestate({ sessionId: "s", members: [] }), TypeError);
});
