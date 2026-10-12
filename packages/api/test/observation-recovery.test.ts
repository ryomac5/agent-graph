import assert from "node:assert/strict";
import fs, { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openLedger } from "../../core/src/ledger/index.ts";
import { observeCodexFile } from "../src/observe/codex/index.ts";
import { fileReadMetrics, readAppendOnlyFile } from "../src/observe/files.ts";
import { openObservationService } from "../src/service/index.ts";

const TS = "2026-10-07T00:00:00.000Z";
const claudeMessage = (id: string, body = id) => JSON.stringify({ type: "user", uuid: id, timestamp: TS,
  message: { role: "user", content: body } }) + "\n";
const codexMeta = (id: string) => JSON.stringify({ type: "session_meta", timestamp: TS,
  payload: { id, timestamp: TS, source: "cli", history_mode: "legacy" } }) + "\n";
const codexMessage = (id: string, body = id) => JSON.stringify({ type: "response_item", timestamp: TS,
  payload: { type: "message", id, role: "assistant", content: body } }) + "\n";

for (const provider of ["claude", "codex"]) {
  test(`${provider}: device だけが変わった旧 cursor はサービス再開でもファイルを開かない`, t => {
    const home = mkdtempSync(join(tmpdir(), "observation-device-"));
    const directory = join(home, provider === "claude" ? ".claude/projects/test" : ".codex/sessions");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "rollout-test.jsonl");
    writeFileSync(path, provider === "claude" ? claudeMessage("test") : codexMeta("test") + codexMessage("test"));
    const options = { home, env: { HOME: home }, dbPath: join(home, "ledger.db") };
    let service = openObservationService(options);
    t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
    service.ingestOnce();
    service.close();
    const db = new DatabaseSync(options.dbPath);
    const state = JSON.parse(String(db.prepare("SELECT state FROM api_observation_cursors WHERE path = ?").get(path)!.state));
    state.cursor.identity = `${statSync(path).dev + 2}:${statSync(path).ino}`;
    db.prepare("UPDATE api_observation_cursors SET state = ? WHERE path = ?").run(JSON.stringify(state), path);
    db.close();
    const bytes = fileReadMetrics.contentBytes;
    assert.equal(readAppendOnlyFile(path, state.cursor).reset, false);
    assert.equal(fileReadMetrics.contentBytes, bytes);
    service = openObservationService(options);
    let opens = 0;
    const open = fs.openSync;
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { opens += 1; return open(...args); });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.equal(service.ingestOnce().appended, 0);
    assert.equal(opens, 0);
    assert.equal(fileReadMetrics.contentBytes, bytes);
  });
}

for (const provider of ["claude", "codex"]) {
  test(`${provider}: 衝突したファイルだけを隔離し、他の事実と cursor を確定する`, t => {
    const home = mkdtempSync(join(tmpdir(), "observation-conflict-"));
    const claude = join(home, ".claude/projects/test");
    const codex = join(home, ".codex/sessions");
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const bad = join(provider === "claude" ? claude : codex, "rollout-bad.jsonl");
    const good = join(provider === "claude" ? codex : claude, "rollout-good.jsonl");
    const options = { home, env: { HOME: home }, dbPath: join(home, "ledger.db") };
    let service = openObservationService(options);
    t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
    const text = (body: string) => provider === "claude" ? claudeMessage("bad", body) : codexMeta("bad") + codexMessage("bad", body);
    writeFileSync(bad, text("old"));
    service.ingestOnce();
    // 同じ発言 ID に別の本文を与え、同ファイル内の新しい事実も隔離されることを確かめる。
    writeFileSync(bad, text("new") + (provider === "claude" ? claudeMessage("quarantined") : codexMessage("quarantined")));
    writeFileSync(good, provider === "claude" ? codexMeta("good") + codexMessage("good") : claudeMessage("good"));
    assert.ok(service.ingestOnce().appended > 0);
    const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.ok(facts.some(f => f.kind === "message.created" && f.payload?.native_id === "good"));
    assert.ok(!facts.some(f => f.kind === "message.created" && f.payload?.native_id === "quarantined"));
    const records = facts.filter(f => f.kind === "observation.unsupported" && f.payload?.file_path === bad);
    assert.equal(records.length, 1);
    assert.equal((records[0].payload as { count: number }).count, 1);
    const db = new DatabaseSync(options.dbPath);
    for (const path of [bad, good]) {
      const state = JSON.parse(String(db.prepare("SELECT state FROM api_observation_cursors WHERE path = ?").get(path)!.state));
      assert.equal(state.cursor.offset, statSync(path).size);
    }
    db.close();
    service.close();
    service = openObservationService(options);
    assert.equal(service.ingestOnce().appended, 0);
    appendFileSync(bad, provider === "claude" ? claudeMessage("after") : codexMessage("after"));
    assert.ok(service.ingestOnce().appended > 0);
    assert.ok(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER).some(f => f.kind === "message.created" && f.payload?.native_id === "after"));
    assert.equal(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(f => f.kind === "observation.unsupported" && f.payload?.file_path === bad).length, 1);
  });
}

test("Codex の中断導出は観測時刻・再送・既存の旧規則によらず決定的で、旧事実を残す", t => {
  const home = mkdtempSync(join(tmpdir(), "observation-deterministic-"));
  const path = join(home, "rollout-test.jsonl");
  writeFileSync(path, codexMeta("test") + JSON.stringify({ type: "event_msg", timestamp: TS,
    payload: { type: "turn_aborted", turn_id: "turn-1" } }) + "\n");
  const ledger = openLedger(":memory:");
  const reference = openLedger(":memory:");
  t.after(() => { ledger.close(); reference.close(); rmSync(home, { recursive: true, force: true }); });
  observeCodexFile(reference, path, { codexHome: home, observedTs: "2026-10-07T00:00:00Z" });
  const state = reference.readSince(0, Number.MAX_SAFE_INTEGER).find(f => f.kind === "run.state_changed")!;
  const legacy = { ...state, source_event_id: state.source_event_id.replace(/:v\d+$/, ""),
    payload: { ...state.payload, last_evidence: { kind: "turn_completed", turn_id: "turn-1" } } };
  ledger.append(legacy as never);
  assert.ok(observeCodexFile(ledger, path, { codexHome: home, observedTs: "2026-10-12T00:00:00Z" }).every(r => r.status !== "conflict"));
  const derived = ledger.readSince(0, Number.MAX_SAFE_INTEGER).find(f => f.source_event_id === state.source_event_id)!;
  assert.deepEqual(derived.payload, state.payload);
  assert.equal(derived.source_ts, state.source_ts);
  assert.deepEqual(ledger.readSince(0, 1)[0].payload, legacy.payload);
  assert.ok(observeCodexFile(ledger, path, { codexHome: home, observedTs: "2030-01-01T00:00:00Z" }).every(r => r.status === "duplicate"));
});

test("大きなファイルの衝突は保存済みの準備分と索引も戻し、同じ会話の別ファイルは取り込む", t => {
  const home = mkdtempSync(join(tmpdir(), "observation-large-conflict-"));
  const directory = join(home, ".codex/sessions");
  mkdirSync(directory, { recursive: true });
  const service = openObservationService({ home, env: { HOME: home }, dbPath: join(home, "ledger.db") });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  service.ledger.append({ source: "rollout-codex", source_event_id: "message:collision:1", kind: "message.created",
    subject: 'message:["codex","collision"]', source_ts: TS, confidence: "confirmed",
    payload: { provider: "codex", native_id: "collision", role: "assistant", version: 1, body: "old", body_state: "stored" } });
  const bad = join(directory, "rollout-a.jsonl");
  // 4096 件の準備上限を越えても、ファイル全体を保存から外す。
  writeFileSync(bad, codexMeta("shared") + Array.from({ length: 2100 }, (_, index) => codexMessage(`discard-${index}`)).join("")
    + codexMessage("collision", "new"));
  writeFileSync(join(directory, "rollout-b.jsonl"), codexMeta("shared") + codexMessage("retained")
    + JSON.stringify({ type: "event_msg", timestamp: TS, payload: { type: "task_started", turn_id: "next" } }) + "\n");
  service.ingestOnce();
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.ok(!facts.some(f => f.kind === "message.created" && f.payload?.native_id?.startsWith("discard-")));
  assert.ok(facts.some(f => f.kind === "message.created" && f.payload?.native_id === "retained"));
  assert.equal(facts.filter(f => f.kind === "run.created").length, 1);
  assert.equal(facts.filter(f => f.kind === "run.state_changed").length, 1);
  assert.equal(facts.filter(f => f.kind === "conversation.updated").length, 1);
  assert.equal(facts.filter(f => f.kind === "observation.unsupported" && f.payload?.file_path === bad).length, 1);
  assert.equal(service.ingestOnce().appended, 0);
});

test("Claude の隔離で会話の文脈も戻し、同じ native ID の別ファイルに未保存の実行を渡さない", t => {
  const home = mkdtempSync(join(tmpdir(), "observation-claude-shared-"));
  const a = join(home, ".claude/projects/a");
  const b = join(home, ".claude/projects/b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const service = openObservationService({ home, env: { HOME: home }, dbPath: join(home, "ledger.db") });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  service.ledger.append({ source: "transcript-claude", source_event_id: 'message:["claude","collision"]',
    kind: "message.created", subject: 'message:["claude","collision"]', source_ts: TS, confidence: "confirmed",
    payload: { provider: "claude", native_id: "collision", version: 1, role: "user", body: "old", body_state: "stored" } });
  writeFileSync(join(a, "shared.jsonl"), claudeMessage("collision", "new"));
  writeFileSync(join(b, "shared.jsonl"), claudeMessage("retained"));
  service.ingestOnce();
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.equal(facts.filter(f => f.kind === "run.created").length, 1);
  assert.equal(facts.filter(f => f.kind === "conversation.created").length, 1);
  assert.ok(facts.some(f => f.kind === "message.created" && f.payload?.native_id === "retained"));
  assert.equal(facts.filter(f => f.kind === "observation.unsupported").length, 1);
});

test("Codex の入力時刻が欠けても、状態の根拠に観測時刻を混ぜない", t => {
  const home = mkdtempSync(join(tmpdir(), "observation-missing-time-"));
  const path = join(home, "rollout-missing-time.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "missing-time", source: "cli" } }) + "\n"
    + JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn" } }) + "\n");
  const ledgers = [openLedger(":memory:"), openLedger(":memory:")];
  t.after(() => { for (const ledger of ledgers) ledger.close(); rmSync(home, { recursive: true, force: true }); });
  const readState = (index: number, observedTs: string) => {
    observeCodexFile(ledgers[index], path, { codexHome: home, observedTs });
    const fact = ledgers[index].readSince(0, Number.MAX_SAFE_INTEGER).find(f => f.kind === "run.state_changed")!;
    return { id: fact.source_event_id, source_ts: fact.source_ts, payload: fact.payload };
  };
  assert.deepEqual(readState(0, "2026-10-07T00:00:00Z"), readState(1, "2030-01-01T00:00:00Z"));
  assert.ok(observeCodexFile(ledgers[0], path, { codexHome: home, observedTs: "2035-01-01T00:00:00Z" })
    .every(result => result.status === "duplicate"));
});
