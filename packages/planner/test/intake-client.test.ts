import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve, respond } from "./fake-runner.ts";
import { createRequestId, readOrigin } from "../../core/src/intake/index.ts";
import type { IntakeRequest } from "../../core/src/intake/index.ts";
import { buildPlannerConstraints, connectIntake, createPlannerRequestId, readPlannerOrigin } from "../src/intake-client.ts";

const submission: IntakeRequest = { requestId: createPlannerRequestId("graph", "task", 1), source: "planner",
  role: "implement", title: "Task", task: "Change", accept: ["true"], cwd: "/worktree" };
const cleanOrigin = { CLAUDE_CODE_SESSION_ID: undefined, CODEX_THREAD_ID: undefined, AGENT_GRAPH_MANAGED: undefined };

test("model の系統と最低 tier の制約が intake.submit に届く", async (t) => {
  const runner = await serve(t, (frame, socket) => respond(socket, frame, {
    requestId: frame.payload.requestId, state: "accepted", attempt: 1,
  }));
  const client = await connectIntake({ cwd: "/repo", socketPath: runner.path, connectSocket: runner.connectSocket, env: cleanOrigin });
  t.after(() => client.close());
  for (const [model, constraints] of [
    ["gpt-6-sol", { excludeFamily: ["anthropic"], minTier: "mid" }],
    ["gpt-6-astra", { excludeFamily: ["anthropic"], minTier: "high" }],
    ["sonnet", { excludeFamily: ["openai"], minTier: "mid" }],
    ["opus", { excludeFamily: ["openai"], minTier: "high" }],
    ["fable", { excludeFamily: ["openai"], minTier: "high" }],
  ] as const) {
    await client.submit({ ...submission, requestId: createPlannerRequestId("graph", model, 1),
      constraints: buildPlannerConstraints({ model, review_model: "" }) });
    assert.equal(runner.frames.at(-1).command, "intake.submit");
    assert.deepEqual(runner.frames.at(-1).payload.constraints, constraints);
  }
  assert.equal(buildPlannerConstraints({ model: "", review_model: "" }), undefined);
  assert.throws(() => buildPlannerConstraints({ model: "unknown", review_model: "" }), /Unsupported model/);
  assert.deepEqual(buildPlannerConstraints({ model: "gpt-6-sol", review_model: "fable" }),
    { excludeFamily: ["anthropic"], minTier: "mid" });
});

test("CLI handshake, stable request identity, origin and status polling", async (t) => {
  let polls = 0;
  const runner = await serve(t, (frame, socket) => respond(socket, frame, {
    requestId: frame.payload.requestId, attempt: 1,
    state: frame.command === "intake.status" && ++polls === 2 ? "done" : "running",
    ...(polls === 2 ? { result: { delegationId: submission.requestId, status: "done" } } : {}),
  }));
  const client = await connectIntake({ cwd: "/repo", socketPath: runner.path, connectSocket: runner.connectSocket,
    env: { ...cleanOrigin, CLAUDE_CODE_SESSION_ID: "terminal" } });
  t.after(() => client.close());
  assert.equal((await client.delegate(submission)).status, "done");
  assert.deepEqual(runner.frames[0], { type: "hello", version: 1, role: "cli" });
  const requests = runner.frames.filter((frame) => frame.type === "req");
  assert.deepEqual(requests[0].payload, { ...submission, origin: { provider: "claude", nativeId: "terminal" } });
  assert.deepEqual(requests.map((frame) => frame.command), ["intake.submit", "intake.status", "intake.status"]);
  assert.notEqual(requests[1].cmd_id, requests[2].cmd_id);
  assert.equal(createPlannerRequestId("graph", "task", 1), submission.requestId);
  assert.notEqual(createPlannerRequestId("graph", "task", 2), submission.requestId);
  assert.notEqual(createPlannerRequestId("other", "task", 1), submission.requestId);
  assert.throws(() => createPlannerRequestId("graph", "task", 0));
});

test("response loss resends the same IDs; explicit retry and Codex origin", async (t) => {
  let dropped = false;
  const runner = await serve(t, (frame, socket) => {
    if (frame.command === "intake.submit" && !dropped) { dropped = true; socket.destroy(); return; }
    respond(socket, frame, { requestId: frame.payload.requestId, state: "accepted", attempt: frame.command === "intake.retry" ? 2 : 1 });
  });
  const client = await connectIntake({ cwd: "/repo", socketPath: runner.path, connectSocket: runner.connectSocket,
    env: { ...cleanOrigin, CODEX_THREAD_ID: "thread" } });
  t.after(() => client.close());
  assert.equal((await client.submit(submission)).state, "accepted");
  const submits = runner.frames.filter((frame) => frame.command === "intake.submit");
  assert.equal(submits.length, 2);
  assert.deepEqual(submits[0], submits[1]);
  assert.deepEqual(submits[0].payload.origin, { provider: "codex", nativeId: "thread" });
  assert.equal((await client.retry(submission.requestId)).attempt, 2);
  assert.deepEqual(runner.frames.at(-1).payload, { requestId: submission.requestId });
});

test("managed parent takes priority, ambiguous origin is omitted", () => {
  assert.deepEqual(readPlannerOrigin({ CLAUDE_CODE_SESSION_ID: "a", CODEX_THREAD_ID: "b" }), {});
  assert.deepEqual(readPlannerOrigin({ AGENT_GRAPH_MANAGED: "run", CLAUDE_CODE_SESSION_ID: "a" }), { parentRun: "run" });
  assert.deepEqual(readPlannerOrigin({}), {});
});

test("intake rejection is not resent and closed clients reject", async (t) => {
  const runner = await serve(t, (frame, socket) => socket.push(JSON.stringify({ type: "res", cmd_id: frame.cmd_id,
    ok: false, error: "Conflicting requestId" }) + "\n"));
  const client = await connectIntake({ cwd: "/repo", socketPath: runner.path, connectSocket: runner.connectSocket, env: cleanOrigin });
  await assert.rejects(client.submit(submission), /Conflicting/);
  assert.equal(runner.frames.filter((frame) => frame.type === "req").length, 1);
  client.close();
  await assert.rejects(client.status(submission.requestId), /closed/);
});

test("real Unix runner socket receives CLI submission", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "planner-socket-"));
  const path = join(directory, "runner.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (frame.type === "hello") {
          assert.equal(frame.role, "cli");
          socket.write(JSON.stringify({ type: "hello", version: 1, role: "runner" }) + "\n");
        } else {
          assert.equal(frame.command, "intake.submit");
          assert.deepEqual(frame.payload, submission);
          socket.write(JSON.stringify({ type: "res", cmd_id: frame.cmd_id, ok: true,
            result: { requestId: submission.requestId, state: "accepted", attempt: 1 } }) + "\n");
        }
      }
    });
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("Unix socket listen denied by sandbox; stream protocol tests run separately");
    return;
  }
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  const client = await connectIntake({ cwd: "/repo", socketPath: path, env: cleanOrigin });
  try { assert.equal((await client.submit(submission)).state, "accepted"); }
  finally { client.close(); }
});

test("planner identity and origin match the core intake contract", () => {
  for (const [graphId, taskId, attempt] of [["graph", "task", 1], ['graph:"a', "task/日本語", 3]] as const) {
    assert.equal(createPlannerRequestId(graphId, taskId, attempt), createRequestId({ source: "planner", graphId, taskId, attempt }));
  }
  for (const env of [{}, { CLAUDE_CODE_SESSION_ID: "claude" }, { CODEX_THREAD_ID: "codex" },
    { CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" },
    { AGENT_GRAPH_MANAGED: "run", CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" }]) {
    assert.deepEqual(readPlannerOrigin(env), readOrigin(env));
  }
});
