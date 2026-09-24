import assert from "node:assert/strict";
import test from "node:test";
import type { Event, EventKind, EventPayload, Span } from "../src/index.ts";
import { newTraceId, newSpanId, ulid } from "../src/index.ts";

test("イベントと span を共通の文脈で記録できる", () => {
  const trace = { traceId: newTraceId(), spanId: newSpanId() };
  const event: Event<"session.started"> = {
    id: ulid(), ts: new Date().toISOString(), kind: "session.started",
    repo: "repo-key", session: "s1", trace, payload: { sessionId: "s1" },
  };
  const span: Span = {
    trace, name: "delegate", startedAt: event.ts, status: "unset",
    attributes: {
      "agent.role": "implement", "agent.executor": "codex", "agent.model": "model",
      "agent.session": "s1", "agent.delegation": "d1", attempts: 1, active: true,
    },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  assert.deepEqual(span.trace, event.trace);
  assert.equal(span.attributes["agent.session"], event.payload.sessionId);
});

// 型検査時に payload の対応と必須属性の欠落を検出する。
type Assert<T extends true> = T;
type RequiredAttribute = "agent.role" | "agent.executor" | "agent.model" | "agent.session" | "agent.delegation";
type CheckPayloadKeys = Assert<EventKind extends keyof EventPayload ? true : false>;
type CheckExtraPayloadKeys = Assert<keyof EventPayload extends EventKind ? true : false>;
type CheckRequiredAttributes = Assert<{
  [K in RequiredAttribute]: {} extends Pick<Span["attributes"], K> ? false : true;
}[RequiredAttribute]>;
type CheckPayload = Assert<Event<"session.started">["payload"] extends { sessionId: string } ? true : false>;
