import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { createRequestId } from "../../core/src/intake/index.ts";
import type { DelegationState, FactInput } from "../../core/src/ledger/facts.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { formatWatchLine, watchLedger, type WatchLine } from "../src/watch/index.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const samples = JSON.parse(readFileSync(new URL("./samples/S18/input.json", import.meta.url), "utf8")) as {
  name: string; requestId: string; states: DelegationState[]; reason: string;
}[];
const expected = JSON.parse(readFileSync(new URL("./samples/S18/expected.json", import.meta.url), "utf8")) as
  Record<string, { states: string[]; exitCode: number }>;

function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-watch-"));
  const dbPath = join(directory, "ledger.db");
  const fixture = { directory, dbPath, ledger: openLedger(dbPath) };
  let index = 0;
  function append(input: Omit<FactInput, "source_event_id" | "source_ts" | "confidence">) {
    index += 1;
    return fixture.ledger.append({ ...input, source_event_id: `watch-${index}`,
      source_ts: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(), confidence: "confirmed" } as FactInput);
  }
  function create(requestId: string, state: DelegationState = "accepted", attempt = 1) {
    return append({ source: "intake", kind: "delegation.created", subject: `delegation:${requestId}`,
      payload: { request_id: requestId, role: "implement", title: "Watch fixture", state, attempt } });
  }
  function change(requestId: string, state: DelegationState, reason = "", attempt = 1) {
    return append({ source: "intake", kind: "delegation.state_changed", subject: `delegation:${requestId}`,
      payload: { state, attempt, ...{ reason } } });
  }
  t.after(() => { fixture.ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return Object.assign(fixture, { append, create, change });
}

function startWatch(t: TestContext, dbPath: string, args: string[], json = true) {
  const child = spawn(process.execPath, [cli, "watch", ...args, "--db", dbPath, ...(json ? ["--json"] : [])],
    { stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let buffer = "";
  let stderr = "";
  let closed = false;
  const waiters = new Set<() => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      lines.push(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    }
    for (const check of waiters) check();
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      for (const check of waiters) check();
      resolve(code);
    });
  });
  t.after(async () => { if (!closed) child.kill("SIGTERM"); await finished; });
  function waitForLines(count: number) {
    return new Promise<void>((resolve, reject) => {
      function check() {
        if (lines.length >= count || closed) {
          waiters.delete(check);
          if (lines.length >= count) resolve(); else reject(new Error(`Watch closed: ${stderr}`));
        }
      }
      waiters.add(check); check();
    });
  }
  return { lines, finished, waitForLines, rows: () => lines.map((line) => JSON.parse(line) as WatchLine), stderr: () => stderr };
}

for (const sample of samples) {
  test(`S18 ${sample.name}: stream each state and exit`, { timeout: 10000 }, async (t) => {
    const fixture = createFixture(t);
    fixture.create(sample.requestId);
    const watcher = startWatch(t, fixture.dbPath, [sample.requestId]);
    await watcher.waitForLines(1);
    for (const state of sample.states.slice(1)) fixture.change(sample.requestId, state,
      state === sample.states.at(-1) ? sample.reason : "");
    assert.equal(await watcher.finished, expected[sample.name].exitCode);
    const rows = watcher.rows();
    assert.deepEqual(rows.map((row) => row.state), expected[sample.name].states);
    assert.ok(rows.every((row) => row.target === sample.requestId && row.attempt === 1 && !Number.isNaN(Date.parse(row.time))));
    assert.deepEqual(rows.map((row) => row.seq), sample.states.map((_, index) => index + 1));
    assert.equal(rows.at(-1)?.reason, sample.reason);
  });

  test(`S18 ${sample.name}: already terminal prints only the current state`, { timeout: 10000 }, async (t) => {
    const fixture = createFixture(t);
    fixture.create(sample.requestId);
    for (const state of sample.states.slice(1)) fixture.change(sample.requestId, state, sample.reason);
    const watcher = startWatch(t, fixture.dbPath, [sample.requestId]);
    assert.equal(await watcher.finished, expected[sample.name].exitCode);
    assert.equal(watcher.lines.length, 1);
    assert.equal(watcher.rows()[0].state, sample.states.at(-1));
  });
}

test("seq catch-up crosses pages, ignores unrelated facts and duplicate states, and survives writer restart", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  fixture.create("target");
  const watcher = startWatch(t, fixture.dbPath, ["target"]);
  await watcher.waitForLines(1);
  for (let index = 0; index < 1100; index += 1) fixture.append({ source: "host-codex", kind: "message.created",
    subject: `message:${index}`, payload: { provider: "codex", native_id: String(index), version: 1, role: "assistant", body_state: "omitted" } });
  fixture.change("target", "assigned");
  fixture.change("target", "assigned");
  fixture.change("target", "running");
  await watcher.waitForLines(3);
  fixture.ledger.close();
  fixture.ledger = openLedger(fixture.dbPath);
  fixture.change("target", "verifying"); fixture.change("target", "reviewing"); fixture.change("target", "done");
  assert.equal(await watcher.finished, 0);
  assert.deepEqual(watcher.rows().map((row) => row.state), ["accepted", "assigned", "running", "verifying", "reviewing", "done"]);
  assert.deepEqual(watcher.rows().map((row) => row.seq), [1, 1102, 1104, 1105, 1106, 1107]);
});

test("judgment and input waits emit lines and remain open", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  fixture.create("request");
  fixture.append({ source: "host-codex", kind: "conversation.created", subject: "conversation:child",
    payload: { provider: "codex", native_id: "child", origin: "managed", type: "unattended", history_format: "jsonl" } });
  fixture.append({ source: "host-codex", kind: "run.created", subject: "run:child-run",
    payload: { conversation_id: "child", generation: 1, state: "running" } });
  fixture.append({ source: "intake", kind: "delegation.attempt_created", subject: "delegation:request",
    payload: { attempt: 1, run_id: "child-run" } });
  fixture.change("request", "running");
  const watcher = startWatch(t, fixture.dbPath, ["request"]);
  await watcher.waitForLines(1);
  for (const state of ["waiting_approval", "waiting_input", "running"] as const) fixture.append({
    source: "host-codex", kind: "run.state_changed", subject: "run:child-run", payload: { state } });
  await watcher.waitForLines(4);
  fixture.change("request", "done");
  assert.equal(await watcher.finished, 0);
  assert.deepEqual(watcher.rows().map((row) => row.state), ["running", "waiting_approval", "waiting_input", "running", "done"]);
});

test("graph waits for every task and reports a mixed failure", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  const task = (taskId: string, attempt = 1) => createRequestId({ source: "planner", graphId: "graph", taskId, attempt });
  fixture.create(task("a")); fixture.change(task("a"), "failed");
  fixture.create(task("a", 2)); fixture.create(task("b"));
  fixture.create(createRequestId({ source: "planner", graphId: "other", taskId: "x", attempt: 1 }));
  const watcher = startWatch(t, fixture.dbPath, ["--graph", "graph"]);
  await watcher.waitForLines(2);
  fixture.change(task("a", 2), "done");
  await watcher.waitForLines(3);
  fixture.change(task("b"), "running"); fixture.change(task("b"), "failed", "Host failed");
  assert.equal(await watcher.finished, 1);
  assert.deepEqual(watcher.rows().map((row) => [row.target, row.state]), [
    [task("a", 2), "accepted"], [task("b"), "accepted"], [task("a", 2), "done"],
    [task("b"), "running"], [task("b"), "failed"],
  ]);
});

test("conversation waits through unknown and approval until confirmed end evidence", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  fixture.append({ source: "host-codex", kind: "conversation.created", subject: "conversation:conversation",
    payload: { provider: "codex", native_id: "native", origin: "managed", type: "interactive", history_format: "jsonl" } });
  fixture.append({ source: "host-codex", kind: "run.created", subject: "run:run",
    payload: { conversation_id: "conversation", generation: 1, state: "running" } });
  const watcher = startWatch(t, fixture.dbPath, ["--conversation", '["codex","native"]']);
  await watcher.waitForLines(1);
  fixture.append({ source: "host-codex", kind: "run.state_changed", subject: "run:run", payload: { state: "ended" } });
  fixture.append({ source: "host-codex", kind: "run.state_changed", subject: "run:run", payload: { state: "waiting_approval" } });
  await watcher.waitForLines(3);
  fixture.append({ source: "host-codex", kind: "run.state_changed", subject: "run:run",
    payload: { state: "ended", end_evidence: { kind: "host_exit", exit_code: 0 } } });
  assert.equal(await watcher.finished, 0);
  assert.deepEqual(watcher.rows().map((row) => row.state), ["running", "unknown", "waiting_approval", "done"]);
});

test("default text has ordered columns and keeps embedded newlines on one line", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  fixture.create("request"); fixture.change("request", "failed", "failure\nreason\ttext");
  const watcher = startWatch(t, fixture.dbPath, ["request"], false);
  assert.equal(await watcher.finished, 1);
  assert.equal(watcher.lines.length, 1);
  const columns = watcher.lines[0].split("\t");
  assert.ok(!Number.isNaN(Date.parse(columns[0])));
  assert.deepEqual(columns.slice(1), ["request", "failed", "1", "failure reason text"]);
  assert.equal(formatWatchLine({ time: "now", target: "target\nname", state: "done", attempt: 1, reason: "", seq: 1 }),
    "now\ttarget name\tdone\t1\t");
});

test("missing target and unreadable ledger exit 4 without creating a ledger", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  const missing = join(fixture.directory, "missing.db");
  for (const path of [fixture.dbPath, missing, fixture.directory]) {
    const watcher = startWatch(t, path, ["absent"]);
    assert.equal(await watcher.finished, 4);
    assert.equal(watcher.lines.length, 0);
    assert.ok(watcher.stderr().length > 0);
  }
  assert.equal(existsSync(missing), false);
});

test("help documents targets, JSON, columns and every exit code", () => {
  for (const args of [["--help"], ["watch", "--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    for (const text of ["--graph", "--conversation", "--json", "0 done", "1 failed", "2 interrupted", "3 denied", "4 target not found"])
      assert.ok(result.stdout.includes(text), text);
  }
});

test("read-only watch closes promptly on cancellation", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  fixture.create("request");
  const controller = new AbortController();
  const rows: WatchLine[] = [];
  const result = watchLedger({ dbPath: fixture.dbPath, target: { kind: "request", id: "request" },
    signal: controller.signal, write: (row) => rows.push(row) });
  controller.abort();
  assert.equal(await result, 2);
  assert.equal(rows.length, 1);
});

test("snapshot crosses pages and writes between snapshot and subscription are not lost", { timeout: 10000 }, async (t) => {
  const fixture = createFixture(t);
  fixture.create("request", "received");
  for (let index = 0; index < 1100; index += 1) fixture.append({ source: "host-codex", kind: "message.created",
    subject: `message:history-${index}`, payload: { provider: "codex", native_id: String(index), version: 1,
      role: "assistant", body_state: "omitted" } });
  fixture.change("request", "accepted", "", 2);
  const rows: WatchLine[] = [];
  const code = await watchLedger({ dbPath: fixture.dbPath, target: { kind: "request", id: "request" },
    write(row) {
      rows.push(row);
      if (rows.length === 1) {
        fixture.change("request", "assigned", "", 2);
        fixture.change("request", "running", "", 2);
        fixture.change("request", "failed", "Host failed", 2);
      }
    } });
  assert.equal(code, 1);
  assert.deepEqual(rows.map((row) => [row.seq, row.state, row.attempt]), [
    [1102, "accepted", 2], [1103, "assigned", 2], [1104, "running", 2], [1105, "failed", 2],
  ]);
});
