import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createNativeId, project, projectRuns } from "../../../core/src/ledger/index.ts";
import type { RunState } from "../../../core/src/ledger/index.ts";
import { createClaudeSessionObserver } from "../../src/observe/claude/sessions.ts";
import { openObservationService } from "../../src/service/index.ts";

const START_TS = "2026-09-01T00:00:00.000Z";
const CHECK_TS = "2026-10-08T00:00:12.000Z";

function createFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-claude-sessions-"));
  const service = openObservationService({ home, env: {}, dbPath: join(home, "ledger.db") });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  const directory = join(home, ".claude", "sessions");
  function addConversation(nativeId: string, state: RunState = "running",
    type: "interactive" | "subagent" = "interactive", origin: "observed" | "managed" = "observed", provider: "claude" | "codex" = "claude") {
    const id = createNativeId(provider, nativeId);
    const common = { source: "transcript-claude" as const, source_ts: START_TS, confidence: "confirmed" as const };
    service.ledger.append({ ...common, source_event_id: `conversation:${id}`, kind: "conversation.created",
      subject: `conversation:${id}`, payload: { provider, native_id: nativeId, origin, type, history_format: "jsonl" } });
    service.ledger.append({ ...common, source_event_id: `run:${id}`, kind: "run.created", subject: `run:${id}:1`,
      payload: { conversation_id: id, generation: 1, state, last_evidence: { kind: "turn_started" } } });
    return id;
  }
  function readFacts() { return service.ledger.readSince(0, Number.MAX_SAFE_INTEGER); }
  function readStates() { return new Map(projectRuns(readFacts()).map(run => [run.conversation_id, run.state])); }
  function writeSession(nativeId: string, pid = process.pid) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${pid}.json`);
    writeFileSync(path, JSON.stringify({ sessionId: nativeId, cwd: home, pid }));
    return path;
  }
  return { home, directory, service, addConversation, readFacts, readStates, writeSession };
}

test("一時 HOME の worker 取り込みは、生きている会話を保ち、不在の running と waiting を idle にする", t => {
  const fixture = createFixture(t);
  const live = fixture.addConversation("live");
  const absent = fixture.addConversation("absent");
  const approval = fixture.addConversation("approval", "waiting_approval");
  const input = fixture.addConversation("input", "waiting_input");
  const child = fixture.addConversation("child", "running", "subagent");
  const managed = fixture.addConversation("managed", "running", "interactive", "managed");
  const codex = fixture.addConversation("codex", "running", "interactive", "observed", "codex");
  fixture.writeSession("live");
  fixture.service.ingestOnce();
  assert.deepEqual(fixture.readStates(), new Map([[live, "running"], [absent, "idle"], [approval, "idle"],
    [input, "idle"], [child, "running"], [managed, "running"], [codex, "running"]]));
  const facts = fixture.readFacts();
  const evidence = projectRuns(facts).find(run => run.conversation_id === absent)!;
  const lastEvidence = evidence.last_evidence as { kind: string; checked_ts: string };
  assert.equal(lastEvidence.kind, "process_absent");
  assert.equal(lastEvidence.checked_ts, evidence.last_evidence_ts);
  fixture.service.ingestOnce();
  assert.deepEqual(fixture.readFacts(), facts);
  assert.deepEqual(project([...facts].reverse()), project(facts));
});

test("消えた file と死んだ pid は不在の根拠になる", t => {
  const fixture = createFixture(t);
  const id = fixture.addConversation("exited");
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  const path = fixture.writeSession("exited", Number(exited.stdout));
  const observe = createClaudeSessionObserver(fixture.service.ledger, fixture.directory);
  assert.equal(observe(CHECK_TS), 1);
  assert.equal(fixture.readStates().get(id), "idle");
  const absent = fixture.addConversation("removed");
  rmSync(path);
  // 生きている会話の集合が変わらないときは、1 分ごとの確かめで拾う。
  assert.equal(observe(CHECK_TS), 0);
  assert.equal(observe("2026-10-08T00:01:12.000Z"), 1);
  assert.equal(fixture.readStates().get(absent), "idle");
});

test("ディレクトリ不在、読めない file、壊れた JSON では何も追記しない", t => {
  const fixture = createFixture(t);
  fixture.addConversation("absent");
  const observe = createClaudeSessionObserver(fixture.service.ledger, fixture.directory);
  const before = fixture.readFacts();
  assert.equal(observe(CHECK_TS), 0);
  mkdirSync(join(fixture.directory, "unreadable.json"), { recursive: true });
  assert.equal(observe(CHECK_TS), 0);
  rmSync(join(fixture.directory, "unreadable.json"), { recursive: true });
  writeFileSync(join(fixture.directory, "invalid.json"), "{");
  assert.equal(observe(CHECK_TS), 0);
  assert.deepEqual(fixture.readFacts(), before);
});

test("PID の確認が拒まれた周期は、他の不在の会話も idle にしない", t => {
  const fixture = createFixture(t);
  fixture.addConversation("live");
  fixture.addConversation("absent");
  fixture.writeSession("live");
  const before = fixture.readFacts();
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("Denied"), { code: "EPERM" }); });
  assert.equal(createClaudeSessionObserver(fixture.service.ledger, fixture.directory)(CHECK_TS), 0);
  assert.deepEqual(fixture.readFacts(), before);
});

test("mtime が変わったときだけ file を読み、同じ分の不在の事実は重複しない", t => {
  const fixture = createFixture(t);
  const id = fixture.addConversation("live");
  const path = fixture.writeSession("live");
  utimesSync(path, new Date(START_TS), new Date(START_TS));
  const observe = createClaudeSessionObserver(fixture.service.ledger, fixture.directory);
  assert.equal(observe(CHECK_TS), 0);
  const mtime = statSync(path).mtime;
  writeFileSync(path, "{");
  utimesSync(path, mtime, mtime);
  assert.equal(observe("2026-10-08T00:00:20.000Z"), 0);
  assert.equal(fixture.readStates().get(id), "running");
  writeFileSync(path, JSON.stringify({ sessionId: "other", cwd: fixture.home, pid: process.pid }));
  utimesSync(path, new Date(CHECK_TS), new Date(CHECK_TS));
  assert.equal(observe(CHECK_TS), 1);
  const fact = fixture.readFacts().at(-1)!;
  assert.equal(fact.source_event_id, `process_absent:${id}:${Math.floor(Date.parse(CHECK_TS) / 60_000)}`);
  fixture.service.ledger.append({ source: "transcript-claude", source_event_id: "resumed", kind: "run.state_changed",
    subject: `run:${id}:1`, source_ts: "2026-10-08T00:00:15.000Z", confidence: "confirmed",
    payload: { conversation_id: id, generation: 1, state: "running", last_evidence: { kind: "turn_started" } } });
  const count = fixture.readFacts().length;
  assert.equal(observe("2026-10-08T00:00:30.000Z"), 0);
  assert.equal(fixture.readFacts().length, count);
  assert.equal(observe("2026-10-08T00:01:00.000Z"), 0);
  assert.equal(observe("2026-10-08T00:01:12.000Z"), 1);
  assert.equal(fixture.readStates().get(id), "idle");
});
