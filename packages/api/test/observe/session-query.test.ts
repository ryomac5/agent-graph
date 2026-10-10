import assert from "node:assert/strict";
import test from "node:test";
import { createNativeId, openLedger, readLedgerDatabase, rebuild } from "../../../core/src/ledger/index.ts";
import type { FactInput, JsonValue } from "../../../core/src/ledger/index.ts";
import { createSessionQuery } from "../../src/observe/session-query.ts";

const TS = "2026-10-08T00:00:00.000Z";
const RECENT = "2026-10-08T00:04:00.000Z";
const NATIVE = "01a1196d-1d5a-7f91-acbc-8d36fc56b286";
const FILE = `rollout-2026-10-08T00-00-00-${NATIVE}.jsonl`;

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: 遅れている投影と追いついた投影で、最新世代・元の subject・直近の記録が一致する`, t => {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    const db = readLedgerDatabase(ledger);
    const source = provider === "claude" ? "transcript-claude" : "rollout-codex";
    let event = 0;
    function append(input: Pick<FactInput, "kind" | "subject"> & { payload: JsonValue } & Partial<Pick<FactInput, "cursor" | "source_ts">>) {
      ledger.append({ source, source_event_id: `event-${event++}`, source_ts: TS, confidence: "confirmed", ...input } as FactInput);
    }
    function add(native: string, state: string, generation = 1, type = "interactive", origin = "observed") {
      const id = createNativeId(provider, native);
      append({ kind: "conversation.created", subject: `conversation:${id}`, cursor: JSON.stringify({ file_id: FILE }),
        payload: { provider, native_id: native, type, origin } });
      const conversation_id = `${provider}:${native}`;
      append({ kind: "run.created", subject: `run:original-${native}-${generation}`,
        payload: { conversation_id, generation, state, last_evidence: { kind: "turn_started" } } });
      return id;
    }
    const id = add(NATIVE, "running");
    add("approval", "waiting_approval");
    add("input", "waiting_input");
    add("managed", "running", 1, "interactive", "managed");
    add("finished", "running");
    add("finished", "idle", 2);
    add("child", "running", 1, "subagent");
    append({ kind: "run.created", subject: "run:older-generation", payload: {
      conversation_id: `${provider}:${NATIVE}`, generation: 0, state: "idle" } });
    append({ kind: "run.updated", subject: "run:older-generation", source_ts: RECENT, payload: { generation: 0 } });
    append({ kind: "message.created", subject: "message:recent", source_ts: RECENT,
      cursor: JSON.stringify({ file_id: FILE }), payload: { provider, native_id: "recent", version: 1,
        role: "assistant", body: "body must never be loaded".repeat(1000), body_state: "stored" } });
    const query = createSessionQuery(ledger);
    t.mock.method(ledger, "readSince", () => { throw new Error("Full ledger read"); });
    const pending = query.read(provider);
    assert.deepEqual(pending.map(row => row.nativeId).sort(), (provider === "claude"
      ? [NATIVE, "approval", "input"] : [NATIVE, "approval", "input", "child"]).sort());
    const run = pending.find(row => row.id === id)!;
    assert.equal(run.subject, `run:original-${NATIVE}-1`);
    assert.equal(run.conversation_id, `${provider}:${NATIVE}`);
    assert.equal(run.lastRecord, provider === "codex" ? Date.parse(RECENT) : 0);
    rebuild(db);
    // 追いついた投影は、会話・実行の事実の再投影も行わない。
    const prepare = db.prepare.bind(db);
    const checked = new Proxy(db, { get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = prepare(sql);
        if (sql.startsWith("SELECT * FROM facts")) t.mock.method(statement, "all", () => { throw new Error("Metadata replay"); });
        return statement;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    assert.deepEqual(createSessionQuery(ledger, checked).read(provider).sort((a, b) => a.id.localeCompare(b.id)),
      pending.sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(query.hasEvent(source, "event-0"), true);
    assert.equal(query.hasEvent(source, "missing"), false);
  });
}

test("生存観測の問い合わせは facts の全件走査をせず、対象の会話・実行・ファイルを索引で読む", t => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const db = readLedgerDatabase(ledger);
  const queries: string[] = [];
  const checked = new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      queries.push(sql);
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const id = createNativeId("codex", NATIVE);
  for (const input of [
    { kind: "conversation.created", subject: `conversation:${id}`, payload: { provider: "codex", native_id: NATIVE, origin: "observed" } },
    { kind: "run.created", subject: "run:active", payload: { conversation_id: id, generation: 0, state: "running" } },
  ]) ledger.append({ ...input, source: "rollout-codex", source_event_id: input.kind, source_ts: TS,
    confidence: "confirmed", cursor: JSON.stringify({ file_id: FILE }) } as FactInput);
  createSessionQuery(ledger, checked).read("codex");
  assert.ok(queries.some(sql => sql.includes("INDEXED BY api_session_file_records")));
  for (const sql of queries) {
    const args = Array.from({ length: sql.match(/\?/g)?.length ?? 0 }, () => "[]");
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail));
    if (sql.includes("INDEXED BY api_session_file_records")) {
      assert.ok(plan.some(detail => detail.includes("api_session_file_records") && detail.includes("<expr>=?")), plan.join("\n"));
    }
    assert.ok(!plan.some(detail => /SCAN (?:\w+\.)?facts\b/.test(detail)), `${sql}\n${plan.join("\n")}`);
  }
});
