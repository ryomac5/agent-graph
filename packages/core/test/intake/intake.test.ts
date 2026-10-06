import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictsWithRequest, createRequestId, fingerprintRequest, readOrigin, retryStatus, transitionStatus, validateRequest, type IntakeRequest } from "../../src/intake/index.ts";
const request: IntakeRequest = { requestId: "id", source: "mcp", role: "implement", title: "Task", task: "Implement", accept: [] };
test("entry identities are stable and keep tuple boundaries", () => {
  for (const identity of [{ source: "ui", cmdId: "a" }, { source: "mcp", callId: "a" },
    { source: "planner", graphId: "g", taskId: "t", attempt: 1 }, { source: "kit", file: "f", position: 0 }] as const) {
    assert.equal(createRequestId(identity), createRequestId(identity));
  }
  assert.notEqual(createRequestId({ source: "ui", cmdId: "a" }), createRequestId({ source: "mcp", callId: "a" }));
  assert.throws(() => createRequestId({ source: "planner", graphId: "g", taskId: "t", attempt: 0 }));
});
test("content comparison ignores object key order and detects changed content", () => {
  assert.equal(fingerprintRequest(request), fingerprintRequest({ accept: [], task: "Implement", title: "Task", role: "implement", source: "mcp", requestId: "id" }));
  assert.equal(conflictsWithRequest(request, { ...request, task: "changed" }), true);
  assert.equal(conflictsWithRequest(request, { ...request, requestId: "other" }), false);
});
test("state transitions and retries are explicit", () => {
  assert.equal(transitionStatus({ requestId: "id", attempt: 1, state: "received" }, "accepted").state, "accepted");
  assert.throws(() => transitionStatus({ requestId: "id", attempt: 1, state: "accepted" }, "done"));
  assert.throws(() => retryStatus({ requestId: "id", attempt: 1, state: "running" }));
  assert.deepEqual(retryStatus({ requestId: "id", attempt: 1, state: "failed" }), { requestId: "id", attempt: 2, state: "accepted" });
});
test("managed parent wins and ambiguous native environments stay unknown", () => {
  assert.deepEqual(readOrigin({ AGENT_GRAPH_MANAGED: "run", CLAUDE_CODE_SESSION_ID: "c" }), { parentRun: "run" });
  assert.deepEqual(readOrigin({ CLAUDE_CODE_SESSION_ID: "c", CODEX_THREAD_ID: "x" }), {});
  assert.deepEqual(readOrigin({ CLAUDE_CODE_SESSION_ID: "c", CODEX_THREAD_ID: "x" }, "claude"), { origin: { provider: "claude", nativeId: "c" } });
  assert.deepEqual(readOrigin({ CODEX_THREAD_ID: "x" }), { origin: { provider: "codex", nativeId: "x" } });
  validateRequest(request);
  assert.throws(() => validateRequest({ ...request, accept: "false" }));
});
