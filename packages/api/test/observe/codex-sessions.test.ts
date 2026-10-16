import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { TestContext } from "node:test";
import { createNativeId, openLedger, projectRuns } from "../../../core/src/ledger/index.ts";
import type { Ledger, RunState } from "../../../core/src/ledger/index.ts";
import { createCodexSessionObserver as createObserver } from "../../src/observe/codex/sessions.ts";
import type { CodexProcessReader } from "../../src/observe/codex/sessions.ts";
import { openObservationService } from "../../src/service/index.ts";

import { createSessionQuery } from "../../src/observe/session-query.ts";

const queries = new WeakMap<Ledger, ReturnType<typeof createSessionQuery>>();
function createCodexSessionObserver(ledger: Ledger, home: string, reader?: CodexProcessReader) {
  return createObserver(ledger, home, reader, queries.get(ledger)!);
}

const NATIVE_ID = "01a1196d-1d5a-7f91-acbc-8d36fc56b286";
const START_TS = "2026-10-08T00:00:00.000Z";
const CHECK_TS = "2026-10-08T00:05:00.000Z";
const HOME = "/fixture/.codex";
const FILE = `rollout-2026-10-08T00-00-00-${NATIVE_ID}.jsonl`;
const PS = " 79864 /vendor/bin/codex\n 80399 /vendor/bin/codex-code-mode-host\n";

function createFixture(t: TestContext, suppliedLedger?: Ledger) {
  const ledger = suppliedLedger ?? openLedger(":memory:");
  if (!suppliedLedger) t.after(() => ledger.close());
  const query = createSessionQuery(ledger);
  queries.set(ledger, query);
  function addConversation(nativeId = NATIVE_ID, state: RunState = "running", timestamp = START_TS,
    origin: "observed" | "managed" = "observed", generation = 1) {
    const id = createNativeId("codex", nativeId);
    const base = { source: "rollout-codex" as const, source_ts: timestamp, confidence: "confirmed" as const };
    ledger.append({ ...base, source_event_id: `conversation:${id}`, kind: "conversation.created",
      subject: `conversation:${id}`, cursor: JSON.stringify({ file_id: nativeId === NATIVE_ID ? FILE : nativeId }),
      payload: { provider: "codex", native_id: nativeId, origin, type: "interactive", history_format: "legacy" } });
    ledger.append({ ...base, source_event_id: `run:${id}:${generation}`, kind: "run.created", subject: `run:${id}:${generation}`,
      payload: { conversation_id: id, generation, state, last_evidence: { kind: "turn_started" } } });
    return id;
  }
  const readFacts = () => ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const readStates = () => new Map(projectRuns(readFacts()).map(run => [run.conversation_id, run.state]));
  return { ledger, query, addConversation, readFacts, readStates };
}

async function observeCompleted(observe: ReturnType<typeof createCodexSessionObserver>, timestamp: string): Promise<number> {
  const appended = observe(timestamp);
  await yieldTurn();
  return appended + observe(timestamp);
}

test("不在の観測した Codex は idle になり、出所と確認時刻を残す", async t => {
  const f = createFixture(t);
  const id = f.addConversation();
  const approval = f.addConversation("approval", "waiting_approval");
  const input = f.addConversation("input", "waiting_input");
  const managed = f.addConversation("managed", "running", START_TS, "managed");
  const reader: CodexProcessReader = { listProcesses: () => PS, readOpenFiles(pids) {
    assert.deepEqual(pids, [79864]);
    return "p79864\nn/dev/null\n";
  } };
  const observe = createCodexSessionObserver(f.ledger, HOME, reader);
  assert.equal(await observeCompleted(observe, CHECK_TS), 3);
  assert.deepEqual(f.readStates(), new Map([[id, "idle"], [approval, "idle"], [input, "idle"], [managed, "running"]]));
  const fact = f.readFacts().find(row => row.source_event_id === `process_absent:${id}:${Math.floor(Date.parse(CHECK_TS) / 60_000)}`)!;
  assert.equal(fact.source, "rollout-codex");
  assert.equal(fact.subject, `run:${id}:1`);
  assert.deepEqual(projectRuns(f.readFacts()).find(run => run.conversation_id === id)!.last_evidence,
    { kind: "process_absent", checked_ts: CHECK_TS });
  const before = f.readFacts();
  assert.equal(await observeCompleted(createCodexSessionObserver(f.ledger, HOME, reader), CHECK_TS), 0);
  assert.deepEqual(f.readFacts(), before);
});

test("生きている Codex が開いた rollout の会話は書き換えない", async t => {
  const f = createFixture(t);
  f.addConversation();
  const before = f.readFacts();
  const reader = { listProcesses: () => PS,
    readOpenFiles: () => `p79864\nf67\nn${HOME}/sessions/2026/10/08/${FILE}\n` };
  assert.equal(await observeCompleted(createCodexSessionObserver(f.ledger, HOME, reader), CHECK_TS), 0);
  assert.deepEqual(f.readFacts(), before);
});

test("ps・lsof の失敗、形式不正、PID の部分取得では何も読まず書かない", async t => {
  const f = createFixture(t);
  f.addConversation();
  const before = f.readFacts();
  const fail = () => { throw new Error("Denied"); };
  const read = t.mock.method(f.query, "read");
  for (const reader of [
    { listProcesses: fail, readOpenFiles: fail },
    { listProcesses: () => PS, readOpenFiles: fail },
    { listProcesses: () => "broken", readOpenFiles: fail },
    { listProcesses: () => PS, readOpenFiles: () => "" },
    { listProcesses: () => `${PS}123 codex\n`, readOpenFiles: () => "p79864\nn/dev/null\n" },
  ]) assert.equal(await observeCompleted(createCodexSessionObserver(f.ledger, HOME, reader), CHECK_TS), 0);
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(f.readFacts(), before);
});

test("最後の記録から2分以内は保留し、1分後の走査で拾う", async t => {
  const f = createFixture(t);
  const id = f.addConversation(NATIVE_ID, "running", "2026-10-08T00:03:00.000Z");
  const reader = { listProcesses: () => "123 node\n", readOpenFiles() { throw new Error("No Codex PID"); } };
  const observe = createCodexSessionObserver(f.ledger, HOME, reader);
  assert.equal(await observeCompleted(observe, "2026-10-08T00:04:59.000Z"), 0);
  assert.equal(await observeCompleted(observe, CHECK_TS), 0);
  assert.equal(f.readStates().get(id), "running");
  assert.equal(await observeCompleted(observe, "2026-10-08T00:05:59.000Z"), 1);
  assert.equal(f.readStates().get(id), "idle");
});

test("ターン開始が古くても rollout の最後の記録が新しければ保留する", async t => {
  const f = createFixture(t);
  f.addConversation();
  f.ledger.append({ source: "rollout-codex", source_event_id: "recent-message", kind: "message.created",
    subject: "message:recent", source_ts: "2026-10-08T00:04:00.000Z", confidence: "confirmed",
    cursor: JSON.stringify({ file_id: FILE }), payload: { provider: "codex", native_id: "recent", role: "assistant", version: 1, body_state: "unavailable" } });
  const before = f.readFacts();
  assert.equal(await observeCompleted(createCodexSessionObserver(f.ledger, HOME,
    { listProcesses: () => "", readOpenFiles: () => "" }), CHECK_TS), 0);
  assert.deepEqual(f.readFacts(), before);
});

test("必要な実行を SQL で読むのは生存集合の変化時と1分ごとだけ", async t => {
  const f = createFixture(t);
  f.addConversation();
  let files = `p79864\nn${HOME}/sessions/2026/10/08/${FILE}\n`;
  const observe = createCodexSessionObserver(f.ledger, HOME, { listProcesses: () => PS, readOpenFiles: () => files });
  const read = t.mock.method(f.query, "read");
  await observeCompleted(observe, CHECK_TS);
  await observeCompleted(observe, "2026-10-08T00:05:30.000Z");
  assert.equal(read.mock.callCount(), 1);
  await observeCompleted(observe, "2026-10-08T00:06:00.000Z");
  assert.equal(read.mock.callCount(), 2);
  files = "p79864\nn/dev/null\n";
  assert.equal(await observeCompleted(observe, "2026-10-08T00:06:30.000Z"), 1);
  assert.equal(read.mock.callCount(), 3);
});

test("同じ会話・同じ分の不在は再開と観測器の再作成でも二重に書かない", async t => {
  const f = createFixture(t);
  const id = f.addConversation();
  const reader = { listProcesses: () => "", readOpenFiles: () => "" };
  assert.equal(await observeCompleted(createCodexSessionObserver(f.ledger, HOME, reader), CHECK_TS), 1);
  f.ledger.append({ source: "rollout-codex", source_event_id: "resume", kind: "run.state_changed",
    subject: `run:${id}:1`, source_ts: "2026-10-08T00:05:01.000Z", confidence: "confirmed",
    payload: { generation: 1, state: "running", last_evidence: { kind: "turn_started" }, last_evidence_ts: START_TS } });
  const before = f.readFacts();
  assert.equal(await observeCompleted(createCodexSessionObserver(f.ledger, HOME, reader), "2026-10-08T00:05:30.000Z"), 0);
  assert.deepEqual(f.readFacts(), before);
});

test("service の取り込み周期に Codex の生存観測が組み込まれる", async t => {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-codex-sessions-"));
  const service = openObservationService({ home, env: {}, dbPath: join(home, "ledger.db"),
    codexProcessReader: { listProcesses: () => "", readOpenFiles: () => "" } });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  const f = createFixture(t, service.ledger);
  const id = f.addConversation();
  service.ingestOnce();
  await yieldTurn();
  service.ingestOnce();
  assert.equal(projectRuns(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)).find(run => run.conversation_id === id)!.state, "idle");
});

test("取得待ちでも周期は戻り、ps・lsof は30秒に一度だけで無更新時は起動しない", async t => {
  const f = createFixture(t);
  f.addConversation();
  let resolveProcesses!: (value: string) => void;
  let resolveFiles!: (value: string) => void;
  let processes = 0;
  let files = 0;
  const observe = createCodexSessionObserver(f.ledger, HOME, {
    listProcesses: () => { processes += 1; return new Promise<string>(resolve => { resolveProcesses = resolve; }); },
    readOpenFiles: () => { files += 1; return new Promise<string>(resolve => { resolveFiles = resolve; }); },
  });
  t.after(() => observe.close());
  const read = t.mock.method(f.query, "read");
  assert.equal(observe(CHECK_TS), 0);
  assert.equal(observe("2026-10-08T00:05:30.000Z"), 0);
  assert.equal(processes, 1);
  assert.equal(files, 0);
  assert.equal(read.mock.callCount(), 0);
  resolveProcesses(PS);
  await yieldTurn();
  assert.equal(files, 1);
  assert.equal(observe(CHECK_TS), 0);
  resolveFiles("p79864\nn/dev/null\n");
  await yieldTurn();
  assert.equal(read.mock.callCount(), 0);
  assert.equal(observe(CHECK_TS), 1);
  for (const seconds of [1, 10, 29]) assert.equal(observe(`2026-10-08T00:05:${String(seconds).padStart(2, "0")}.000Z`), 0);
  assert.equal(processes, 1);
  assert.equal(files, 1);
  assert.equal(observe("2026-10-08T00:05:30.000Z"), 0);
  assert.equal(processes, 2);
  resolveProcesses(PS);
  await yieldTurn();
  resolveFiles("p79864\nn/dev/null\n");
  await yieldTurn();
  assert.equal(observe("2026-10-08T00:05:30.000Z"), 0);
  assert.equal(files, 2);
  assert.equal(read.mock.callCount(), 1);
});

test("非同期取得の失敗では以前の結果を使わず、30秒後の成功で復帰する", async t => {
  const f = createFixture(t);
  f.addConversation();
  let fail = false;
  let files = `p79864\nn${HOME}/sessions/${FILE}\n`;
  let polls = 0;
  const observe = createCodexSessionObserver(f.ledger, HOME, {
    listProcesses: async () => { polls += 1; return PS; },
    readOpenFiles: async () => { if (fail) throw new Error("Unavailable"); return files; },
  });
  t.after(() => observe.close());
  const read = t.mock.method(f.query, "read");
  assert.equal(await observeCompleted(observe, CHECK_TS), 0);
  fail = true;
  assert.equal(await observeCompleted(observe, "2026-10-08T00:06:00.000Z"), 0);
  assert.equal(await observeCompleted(observe, "2026-10-08T00:06:29.000Z"), 0);
  assert.equal(read.mock.callCount(), 1);
  assert.equal(polls, 2);
  fail = false;
  files = "p79864\nn/dev/null\n";
  assert.equal(await observeCompleted(observe, "2026-10-08T00:06:30.000Z"), 1);
  assert.equal(read.mock.callCount(), 2);
});

test("close は取得を中断し、遅れて完了しても台帳に触れない", async t => {
  const f = createFixture(t);
  f.addConversation();
  let finish!: (value: string) => void;
  let signal: AbortSignal | undefined;
  const observe = createCodexSessionObserver(f.ledger, HOME, {
    listProcesses: current => { signal = current; return new Promise<string>(resolve => { finish = resolve; }); },
    readOpenFiles: () => { throw new Error("Should not read files"); },
  });
  const read = t.mock.method(f.query, "read");
  assert.equal(observe(CHECK_TS), 0);
  observe.close();
  assert.equal(signal?.aborted, true);
  finish("");
  await yieldTurn();
  assert.equal(observe("2026-10-08T00:06:00.000Z"), 0);
  assert.equal(read.mock.callCount(), 0);
});

for (const failure of [undefined, "stderr", "exit", "error", "signal", "overflow"] as const) {
  test(`非同期 spawn の出力を次の周期で消費し、不完全な取得は書かない: ${failure ?? "success"}`, async t => {
    const f = createFixture(t);
    f.addConversation();
    const calls: string[] = [];
    const children: (EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean })[] = [];
    t.mock.method(childProcess, "spawn", (command: string, args: string[], options: { timeout: number; signal: AbortSignal }) => {
      calls.push(command);
      assert.equal(options.timeout, 5_000);
      assert.equal(options.signal.aborted, false);
      assert.deepEqual(args, command === "ps" ? ["-axo", "pid=,comm="] : ["-nP", "-p", "79864", "-F", "pn"]);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill() { setImmediate(() => child.emit("close", null, "SIGTERM")); return true; },
      });
      children.push(child);
      return child;
    });
    t.mock.method(childProcess, "spawnSync", () => { throw new Error("Synchronous process observation"); });
    syncBuiltinESMExports();
    const observe = createCodexSessionObserver(f.ledger, HOME);
    t.after(() => { observe.close(); t.mock.restoreAll(); syncBuiltinESMExports(); });
    const read = t.mock.method(f.query, "read");
    assert.equal(observe(CHECK_TS), 0);
    assert.deepEqual(calls, ["ps"]);
    await yieldTurn();
    assert.equal(read.mock.callCount(), 0);
    children[0].stdout.write(PS);
    children[0].emit("close", 0, null);
    await yieldTurn();
    assert.deepEqual(calls, ["ps", "lsof"]);
    const child = children[1];
    child.stdout.write("p79864\nn/dev/null\n");
    if (failure === "stderr") child.stderr.write("Permission denied");
    if (failure === "error") child.emit("error", new Error("Unavailable"));
    if (failure === "overflow") child.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1));
    child.emit("close", failure === "exit" ? 1 : 0, failure === "signal" ? "SIGTERM" : null);
    await yieldTurn();
    assert.equal(read.mock.callCount(), 0);
    assert.equal(observe(CHECK_TS), failure ? 0 : 1);
    assert.equal(read.mock.callCount(), failure ? 0 : 1);
    assert.equal(observe("2026-10-08T00:05:29.000Z"), 0);
    assert.equal(calls.length, 2);
  });
}

test("遅い取得の完了後も30秒空け、lsof を短い間隔で再起動しない", async t => {
  const f = createFixture(t);
  let finish!: (value: string) => void;
  let polls = 0;
  const observe = createCodexSessionObserver(f.ledger, HOME, {
    listProcesses: () => { polls += 1; return new Promise<string>(resolve => { finish = resolve; }); },
    readOpenFiles: async () => "p79864\nn/dev/null\n",
  });
  t.after(() => observe.close());
  assert.equal(observe(CHECK_TS), 0);
  finish(PS);
  await yieldTurn();
  assert.equal(observe("2026-10-08T00:05:05.000Z"), 0);
  assert.equal(observe("2026-10-08T00:05:34.000Z"), 0);
  assert.equal(polls, 1);
  assert.equal(observe("2026-10-08T00:05:35.000Z"), 0);
  assert.equal(polls, 2);
  finish(PS);
  await yieldTurn();
});
