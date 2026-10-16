import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applyIncremental, openLedger, projectRuns, readLedgerDatabase } from "../../../core/src/ledger/index.ts";
import { createClaudeChildObserver } from "../../src/observe/claude/children.ts";
import { createSessionQuery } from "../../src/observe/session-query.ts";
import { observeClaudeFile } from "../../src/observe/claude/index.ts";
import { observeClaudeContext } from "../../src/observe/claude/context.ts";

const START = Date.parse("2026-10-14T09:10:00Z");
const LATER = START + 29 * 60 * 60 * 1000;
const stamp = (at: number) => new Date(at).toISOString();
function fixture(t: TestContext, bind = true) {
  const directory = mkdtempSync(join(tmpdir(), "ag-child-"));
  const ledger = openLedger(":memory:");
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const sessions = join(directory, "sessions");
  const child = join(directory, "parent", "subagents", "agent-child.jsonl");
  const parent = join(directory, "parent.jsonl");
  mkdirSync(sessions); mkdirSync(join(directory, "parent", "subagents"), { recursive: true });
  let processes = new Map([[42, "old"]]);
  let fail = false;
  function register(pid = 42, procStart = "old") {
    writeFileSync(join(sessions, "parent.json"), JSON.stringify({ sessionId: "parent", pid, procStart, startedAt: START - 1000 }));
  }
  register();
  writeFileSync(parent, "");
  const reader = () => { if (fail) throw new Error("Denied"); return processes; };
  const query = createSessionQuery(ledger);
  const observer = createClaudeChildObserver(ledger, sessions, query, reader);
  if (bind) observer.observe([], stamp(START - 100));
  writeFileSync(child, JSON.stringify({ type: "assistant", uuid: "tool", timestamp: stamp(START), promptId: "child-turn",
    message: { role: "assistant", content: [{ type: "tool_use", id: "long-tool", name: "Bash", input: {} }] } }) + "\n");
  observeClaudeFile(ledger, child);
  observeClaudeContext(ledger, child, { parentAtLaunch: observer.parentAtLaunch });
  const facts = () => ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const run = () => projectRuns(facts())[0];
  function notify(kind = "queue", status = "stopped", id = "child", at = START + 1000) {
    const text = `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>Stopped</summary></task-notification>`;
    appendFileSync(parent, JSON.stringify({ timestamp: stamp(at), promptId: "parent-turn",
      ...(kind === "queue" ? { type: "queue-operation", operation: "enqueue", content: text }
        : { type: "user", uuid: "notice", message: { role: "user", content: [{ type: "text", text }] } }) }) + "\n");
  }
  return { ledger, observer, child, sessions, facts, run, register, notify,
    scan: (at = LATER) => observer.observe([child], stamp(at)),
    processes: (value: Map<number, string>) => { processes = value; }, fail: () => { fail = true; },
    restart: () => createClaudeChildObserver(ledger, sessions, query, reader) };
}

for (const projected of [false, true]) test(`親の PID が消えた子は29時間後に作業中でなくなる（投影済み=${projected}）`, t => {
  const f = fixture(t);
  assert.equal(f.run().state, "running");
  assert.deepEqual(f.run().launch, { parentProcessAtLaunch: { pid: 42, procStart: "old" } });
  if (projected) applyIncremental(readLedgerDatabase(f.ledger), 0);
  assert.equal(f.scan(), 0);
  assert.equal(f.run().state, "running");
  f.processes(new Map());
  assert.equal(f.scan(LATER + 1000), 1);
  assert.equal(f.run().state, "unknown");
  assert.equal(f.run().end_evidence, undefined);
  const facts = f.facts();
  assert.equal(f.scan(LATER + 2000), 0);
  assert.deepEqual(f.facts(), facts);
  assert.deepEqual(projectRuns([...facts].reverse()), projectRuns(facts));
  assert.equal(facts.some(fact => fact.kind === "run.updated"), false);
});

for (const kind of ["queue", "user"]) test(`${kind} の stopped 通知で生きている親の子も作業中でなくなる`, t => {
  const f = fixture(t);
  f.notify(kind);
  assert.equal(f.scan(), 1);
  assert.equal(f.run().state, "unknown");
  assert.equal(f.run().reason, "boundary_unavailable");
  assert.equal(f.run().end_evidence, undefined);
});

for (const [pid, start] of [[43, "old"], [42, "new"], [43, "new"]] as const) test(`親の起動回が違う ${pid}/${start} は生存を貸さない`, t => {
  const f = fixture(t);
  f.register(pid, start); f.processes(new Map([[42, "old"], [pid, start]]));
  assert.equal(f.restart().observe([f.child], stamp(LATER)), 1);
  assert.equal(f.run().state, "unknown");
  assert.equal(f.run().reason, "owner_restarted");
  assert.deepEqual(f.run().launch, { parentProcessAtLaunch: { pid: 42, procStart: "old" } });
});

test("起動時の組を持たない古い子は現在の親で補わない。新鮮な進行は保つ", t => {
  const f = fixture(t, false);
  assert.equal(f.scan(START + 1000), 0);
  assert.equal(f.scan(), 1);
  assert.equal(f.run().state, "unknown");
  assert.deepEqual(f.run().launch, { parentProcessAtLaunch: null });
});

test("走査失敗・壊れた登録は死亡を作らず、前回確認の期限だけ保つ", t => {
  const f = fixture(t);
  assert.equal(f.scan(), 0);
  writeFileSync(join(f.sessions, "bad.json"), "{");
  f.processes(new Map());
  assert.equal(f.scan(LATER + 1000), 0);
  f.fail();
  assert.equal(f.scan(LATER + 30_000), 1);
  assert.equal(f.run().state, "unknown");
  assert.equal(f.run().end_evidence, undefined);
});

test("別の task-id と通知のない子は長い tool を保つ", t => {
  const f = fixture(t);
  f.notify("queue", "stopped", "child-other");
  assert.equal(f.scan(), 0);
  assert.equal(f.run().state, "running");
});

test("古い turn の停止通知は新しい turn を止めない", t => {
  const f = fixture(t);
  f.notify();
  appendFileSync(f.child, JSON.stringify({ type: "assistant", uuid: "next", timestamp: stamp(START + 2000), promptId: "next-turn",
    message: { role: "assistant", content: [{ type: "tool_use", id: "next-tool", name: "Bash", input: {} }] } }) + "\n");
  assert.equal(f.scan(), 0);
  assert.equal(f.run().state, "running");
});

test("取り込みサービスは変更のない子にも後着した親の停止通知を反映する", async t => {
  const { openObservationService } = await import("../../src/service/index.ts");
  const home = mkdtempSync(join(tmpdir(), "ag-child-service-"));
  const projects = join(home, ".claude", "projects", "fixture");
  const child = join(projects, "parent", "subagents", "agent-child.jsonl");
  mkdirSync(join(projects, "parent", "subagents"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(child, JSON.stringify({ type: "assistant", uuid: "tool", timestamp: now, promptId: "child-turn",
    message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Bash", input: {} }] } }) + "\n");
  const service = openObservationService({ home, env: {}, dbPath: join(home, "ledger.db"),
    claudeProcessReader: () => new Map(), codexProcessReader: { listProcesses: () => "", readOpenFiles: () => "" } });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  service.ingestOnce();
  const read = () => projectRuns(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)).find(run => run.conversation_id.includes("agent-child"))!;
  assert.equal(read().state, "running");
  writeFileSync(join(projects, "parent.jsonl"), JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: now,
    content: "<task-notification><task-id>child</task-id><status>stopped</status></task-notification>" }) + "\n");
  service.ingestOnce();
  assert.equal(read().state, "unknown");
});
