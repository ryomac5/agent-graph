import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execute } from "../src/exec/types.ts";
import type { ExecRequest } from "../src/exec/types.ts";

const fixtures = resolve(import.meta.dirname, "fixtures");
const trace = { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", traceState: "vendor=value" };

async function runFixture(executor: ExecRequest["executor"], hang = false) {
  const workDir = await mkdtemp(join(tmpdir(), "agent-graph-exec-"));
  const capture = join(workDir, "capture.json");
  const key = executor === "claude" ? "AGENT_GRAPH_CLAUDE_BIN" : "AGENT_GRAPH_CODEX_BIN";
  const previous = { bin: process.env[key], capture: process.env.FIXTURE_CAPTURE, hang: process.env.FIXTURE_HANG };
  process.env[key] = join(fixtures, executor);
  process.env.FIXTURE_CAPTURE = capture;
  if (hang) process.env.FIXTURE_HANG = "1";
  const req: ExecRequest = {
    executor, model: "test-model", task: "test task", cwd: workDir, trace,
    sessionId: "session-1", delegationId: "delegation-1", timeoutMs: hang ? 200 : 5_000, workDir,
  };
  try {
    const result = await execute(req);
    const received = JSON.parse(await readFile(capture, "utf8"));
    return { result, received, workDir };
  } finally {
    for (const [name, value] of [[key, previous.bin], ["FIXTURE_CAPTURE", previous.capture], ["FIXTURE_HANG", previous.hang]]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
  }
}

function assertTrace(received: any, result: Awaited<ReturnType<typeof execute>>) {
  assert.equal(received.traceparent, `00-${trace.traceId}-${result.childTrace.spanId}-01`);
  assert.equal(result.childTrace.parentSpanId, trace.spanId);
  assert.equal(received.tracestate, "agent-graph=session:session-1;delegation:delegation-1,vendor=value");
  assert.equal(received.session, "session-1");
  assert.equal(received.delegation, "delegation-1");
}

test("Claude の引数、標準入力、結果、usage とトレース", async () => {
  const { result, received, workDir } = await runFixture("claude");
  try {
    assert.deepEqual(received.args, ["-p", "--model", "test-model", "--output-format", "stream-json", "--verbose"]);
    assert.equal(received.input, "test task");
    assert.equal(result.output, "Claude result");
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.ok(result.durationMs >= 0);
    assertTrace(received, result);
  } finally { await rm(workDir, { recursive: true, force: true }); }
});

test("Codex の引数、標準入力、結果とトレース", async () => {
  const { result, received, workDir } = await runFixture("codex");
  try {
    assert.deepEqual(received.args, ["exec", "-m", "test-model", "--sandbox", "workspace-write",
      "--skip-git-repo-check", "--output-last-message", join(workDir, "last.md"), "-"]);
    assert.equal(received.input, "test task");
    assert.equal(result.output, "Codex result");
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assertTrace(received, result);
  } finally { await rm(workDir, { recursive: true, force: true }); }
});

test("制限時間で子プロセスを終了する", async () => {
  const { result, workDir } = await runFixture("claude", true);
  try {
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
  } finally { await rm(workDir, { recursive: true, force: true }); }
});
