import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { repoKey } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { startHttpServer } from "../src/http/server.ts";
import { inferRole, observe, observers, tierOf } from "../src/observe.ts";
import { NotFoundError, registerSession } from "../src/sessions.ts";

async function createFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-graph-observe-")));
  execFileSync("git", ["init", "-q", root]);
  const key = repoKey(root);
  const store = openStore(":memory:");
  store.upsertRepo({ key, rootPath: root, name: "test" });
  const stores = new Map<string, Store>([[key, store]]);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await registerSession({ id: "s", cwd: root, client: "claude", model: "fable" }, stores);
  return { root, key, store, stores };
}

const at = (minute: number) => new Date(`2026-09-25T00:${String(minute).padStart(2, "0")}:00.000Z`);

function delegations(store: Store) {
  return store.db.prepare(`SELECT d.id, d.parent_id, d.role, d.title, d.status, d.kind, d.round_trips, a.executor, a.model, a.family, a.tier
    FROM delegations d LEFT JOIN assignments a ON a.delegation_id = d.id ORDER BY d.rowid`).all();
}

function eventsOf(store: Store, delegationId: string) {
  return store.db.prepare("SELECT kind, payload FROM events WHERE json_extract(payload, '$.delegationId') = ? ORDER BY ts, rowid").all(delegationId)
    .map((row) => ({ kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Record<string, unknown> }));
}

function roundsOf(store: Store, delegationId: string) {
  return store.db.prepare("SELECT kind, text FROM delegation_rounds WHERE delegation_id = ? ORDER BY seq").all(delegationId)
    .map((row) => ({ kind: String(row.kind), text: String(row.text) }));
}

test("observers は turn の 3 種を残し、サブエージェントの種類を足す", () => {
  assert.deepEqual(Object.keys(observers), ["turn_start", "turn_done", "waiting",
    "subagent_request", "subagent_done", "subagent_start", "subagent_message", "subagent_stop", "resumed"]);
});

test("Agent の呼び出しは kind subagent の行になり、SubagentStop で done と報告になる", async (t) => {
  const { store, stores } = await createFixture(t);
  observe({ kind: "waiting", sessionId: "s", reason: "permission" }, stores, at(0));
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_1", title: "契約を調べる", task: "contract.ts を読む\n詳細",
    subagentType: "Explore", model: "sonnet" }, stores, at(1));
  let rows = delegations(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "subagent");
  assert.equal(rows[0].status, "running");
  assert.equal(rows[0].title, "契約を調べる");
  assert.equal(rows[0].role, "research");
  assert.equal(rows[0].executor, "claude");
  assert.equal(rows[0].model, "sonnet");
  assert.equal(rows[0].family, "anthropic");
  assert.equal(rows[0].tier, "mid");
  assert.equal(rows[0].parent_id, null);
  // サブエージェントの観測は根の待ちを解除しない
  assert.equal(store.getSession("s")?.status, "waiting");
  observe({ kind: "resumed", sessionId: "s" }, stores, at(1));
  assert.equal(store.getSession("s")?.status, "running");
  const id = String(rows[0].id);
  observe({ kind: "subagent_start", sessionId: "s", agentId: "agent-1", agentType: "Explore" }, stores, at(2));
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "agent-1", agentType: "Explore",
    report: "見つけた\n- contract.ts\n- 3 行目\n4 行目", summary: "見つけた\n- contract.ts\n- 3 行目" }, stores, at(3));
  rows = delegations(store);
  assert.equal(rows[0].status, "done");
  const events = eventsOf(store, id);
  assert.deepEqual(events.map((event) => event.kind), ["delegation.requested", "subagent.dispatched", "subagent.started",
    "execution.started", "subagent.reported", "execution.finished", "delegation.finished"]);
  assert.equal(events[0].payload.task, "contract.ts を読む\n詳細");
  assert.deepEqual(events[1].payload, { delegationId: id, toolUseId: "toolu_1", agentType: "Explore" });
  assert.deepEqual(events[2].payload, { delegationId: id, agentId: "agent-1", agentType: "Explore" });
  assert.deepEqual(events[4].payload, { delegationId: id, agentId: "agent-1", output: "見つけた\n- contract.ts\n- 3 行目\n4 行目",
    summary: "見つけた\n- contract.ts\n- 3 行目" });
  assert.deepEqual(events[6].payload, { delegationId: id, status: "done" });
  assert.equal(store.getSession("s")?.lastSeenAt, at(3).toISOString());
});

test("model が無ければ根の model を継ぎ、title が無ければ prompt の先頭行、summary が無ければ報告の先頭 3 行", async (t) => {
  const { store, stores } = await createFixture(t);
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_1", title: "  ", task: "\n\n  実装する  \n次の行" }, stores, at(1));
  const [row] = delegations(store);
  assert.equal(row.title, "実装する");
  assert.equal(row.model, "fable");
  assert.equal(row.tier, "high");
  assert.equal(row.role, "implement");
  assert.equal(eventsOf(store, String(row.id))[1].payload.agentType, "general-purpose");
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a", agentType: "general-purpose" }, stores, at(2));
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "a", agentType: "general-purpose", report: "1\n\n2\n3\n4" }, stores, at(3));
  const reported = eventsOf(store, String(row.id)).find((event) => event.kind === "subagent.reported")!;
  assert.equal(reported.payload.summary, "1\n2\n3");
});

test("SendMessage は宛先の子への再指示として rounds に足し、再開の SubagentStart で running に戻す", async (t) => {
  const { store, stores } = await createFixture(t);
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_1", title: "直す", task: "直す", subagentType: "general-purpose", name: "fixer" }, stores, at(1));
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_2", title: "別", task: "別", subagentType: "general-purpose" }, stores, at(1));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a1", agentType: "general-purpose" }, stores, at(2));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a2", agentType: "general-purpose" }, stores, at(2));
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "a1", agentType: "general-purpose", report: "できた" }, stores, at(3));
  observe({ kind: "subagent_message", sessionId: "s", toolUseId: "toolu_3", to: "a1", text: "テストが足りない" }, stores, at(4));
  observe({ kind: "subagent_message", sessionId: "s", toolUseId: "toolu_4", to: "fixer", text: "名前宛て" }, stores, at(4));
  observe({ kind: "subagent_message", sessionId: "s", toolUseId: "toolu_5", to: "unknown", text: "宛先が無い" }, stores, at(4));
  const [first, second] = delegations(store);
  assert.equal(first.round_trips, 2);
  assert.equal(second.round_trips, 0);
  const reinstructed = eventsOf(store, String(first.id)).filter((event) => event.kind === "subagent.reinstructed");
  assert.deepEqual(reinstructed.map((event) => event.payload), [
    { delegationId: first.id, agentId: "a1", toolUseId: "toolu_3", text: "テストが足りない" },
    { delegationId: first.id, agentId: "a1", toolUseId: "toolu_4", text: "名前宛て" },
  ]);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'subagent.reinstructed'").get()?.n, 2);
  // 再開。行は増えず、running に戻る
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a1", agentType: "general-purpose" }, stores, at(5));
  assert.equal(delegations(store).length, 2);
  assert.equal(delegations(store)[0].status, "running");
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "a1", agentType: "general-purpose", report: "足した" }, stores, at(6));
  assert.equal(delegations(store)[0].status, "done");
  assert.equal(eventsOf(store, String(first.id)).filter((event) => event.kind === "subagent.reported").length, 2);
});

test("サブエージェントの往復は delegation_rounds に request / reinstruct / report で積む", async (t) => {
  const { store, stores } = await createFixture(t);
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_1", title: "直す", task: "直す", subagentType: "general-purpose", name: "fixer" }, stores, at(1));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a1", agentType: "general-purpose" }, stores, at(2));
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "a1", agentType: "general-purpose", report: "できた" }, stores, at(3));
  observe({ kind: "subagent_message", sessionId: "s", toolUseId: "toolu_2", to: "a1", text: "テストが足りない" }, stores, at(4));
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "a1", agentType: "general-purpose", report: "足した" }, stores, at(5));
  const [row] = delegations(store);
  assert.deepEqual(roundsOf(store, String(row.id)), [
    { kind: "request", text: "直す" },
    { kind: "report", text: "できた" },
    { kind: "reinstruct", text: "テストが足りない" },
    { kind: "report", text: "足した" },
  ]);
});

test("AskUserQuestion は waiting_reason を question にし、PostToolUse で解除する", async (t) => {
  const { store, stores } = await createFixture(t);
  observe({ kind: "waiting", sessionId: "s", reason: "question" }, stores, at(1));
  assert.equal(store.getSession("s")?.status, "waiting");
  assert.equal(store.getSession("s")?.waitingReason, "question");
  observe({ kind: "resumed", sessionId: "s" }, stores, at(2));
  const session = store.getSession("s")!;
  assert.equal(session.status, "running");
  assert.equal(session.waitingReason, undefined);
  assert.equal(session.lastSeenAt, at(2).toISOString());
});

test("同じ tool_use_id の二重送信と同じ報告の二重送信で行と往復を増やさない", async (t) => {
  const { store, stores } = await createFixture(t);
  const request = { kind: "subagent_request", sessionId: "s", toolUseId: "toolu_1", title: "調べる", task: "調べる", subagentType: "Explore" };
  observe(request, stores, at(1));
  observe(request, stores, at(1));
  assert.equal(delegations(store).length, 1);
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a", agentType: "Explore" }, stores, at(2));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "a", agentType: "Explore" }, stores, at(2));
  const stop = { kind: "subagent_stop", sessionId: "s", agentId: "a", agentType: "Explore", report: "結果" };
  observe(stop, stores, at(3));
  observe(stop, stores, at(3));
  const message = { kind: "subagent_message", sessionId: "s", toolUseId: "toolu_2", to: "a", text: "続き" };
  observe(message, stores, at(4));
  observe(message, stores, at(4));
  const [row] = delegations(store);
  assert.equal(delegations(store).length, 1);
  assert.equal(row.round_trips, 1);
  const kinds = eventsOf(store, String(row.id)).map((event) => event.kind);
  assert.equal(kinds.filter((kind) => kind === "subagent.started").length, 1);
  assert.equal(kinds.filter((kind) => kind === "subagent.reported").length, 1);
  assert.equal(kinds.filter((kind) => kind === "delegation.finished").length, 1);
  assert.equal(kinds.filter((kind) => kind === "subagent.reinstructed").length, 1);
});

test("入れ子の委譲は親の行に結び、agent_type だけの開始は行を作り、記録も種別も無い開始と停止は捨てる", async (t) => {
  const { store, stores } = await createFixture(t);
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_1", title: "親", task: "親", subagentType: "general-purpose" }, stores, at(1));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "parent", agentType: "general-purpose" }, stores, at(2));
  observe({ kind: "subagent_request", sessionId: "s", toolUseId: "toolu_2", title: "子", task: "子", subagentType: "Explore", parentAgentId: "parent" }, stores, at(3));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "internal" }, stores, at(4));
  observe({ kind: "subagent_stop", sessionId: "s", agentId: "internal", report: "内部" }, stores, at(4));
  observe({ kind: "subagent_start", sessionId: "s", agentId: "typed", agentType: "reviewer" }, stores, at(5));
  observe({ kind: "subagent_stop", sessionId: "s", agentType: "Explore", report: "agent_id 無しの停止" }, stores, at(6));
  const rows = delegations(store);
  assert.deepEqual(rows.map((row) => [row.title, row.parent_id, row.role, row.status]), [
    ["親", null, "implement", "running"],
    ["子", rows[0].id, "research", "done"],
    ["reviewer", null, "review", "running"],
  ]);
  assert.equal(eventsOf(store, String(rows[2].id))[0].payload.task, "");
});

test("役割と tier の推定", () => {
  assert.equal(inferRole("差分を検証する", "reviewer"), "review");
  assert.equal(inferRole("README を書く", "doc-light"), "document");
  assert.equal(inferRole("設計書を書く", "doc-heavy"), "document");
  assert.equal(inferRole("hook の形を確認", "claude-code-guide"), "research");
  assert.equal(inferRole("経路を探す", "Explore"), "research");
  assert.equal(inferRole("実装計画を作る", "Plan"), "research");
  assert.equal(inferRole("PR をレビューする", "general-purpose"), "review");
  assert.equal(inferRole("使い方を調査する", "general-purpose"), "research");
  assert.equal(inferRole("ガイド文書を書く", "general-purpose"), "document");
  assert.equal(inferRole("観測を実装する", "general-purpose"), "implement");
  assert.equal(inferRole("", ""), "implement");
  assert.equal(tierOf("opus"), "high");
  assert.equal(tierOf("claude-fable-5-1"), "high");
  assert.equal(tierOf("sonnet"), "mid");
  assert.equal(tierOf("haiku"), "low");
  assert.equal(tierOf(""), "mid");
});

test("不正な body と未知のセッションを拒む", async (t) => {
  const { stores } = await createFixture(t);
  assert.throws(() => observe({ kind: "subagent_nope", sessionId: "s" }, stores), TypeError);
  assert.throws(() => observe({ kind: "subagent_request", sessionId: "missing" }, stores), NotFoundError);
  assert.throws(() => observe({ kind: "turn_start", sessionId: "missing" }, stores), NotFoundError);
});

test("POST /api/observe はサブエージェントの観測を通す", async (t) => {
  const { root, store, stores } = await createFixture(t);
  let server;
  try { server = await startHttpServer({ port: 0, openStores: stores, listRepos: () => [], tokenPath: join(root, "dashboard.token") }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/observe`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ kind: "subagent_request", sessionId: "s", toolUseId: "t", title: "調べる", task: "x".repeat(20_000), subagentType: "Explore" })).status, 200);
  assert.equal((await post({ kind: "subagent_start", sessionId: "s", agentId: "a", agentType: "Explore" })).status, 200);
  assert.equal((await post({ kind: "subagent_message", sessionId: "s", toolUseId: "m", to: "a", text: "続き" })).status, 200);
  assert.equal((await post({ kind: "subagent_stop", sessionId: "s", agentId: "a", agentType: "Explore", report: "済み" })).status, 200);
  assert.equal((await post({ kind: "resumed", sessionId: "s" })).status, 200);
  assert.equal((await post({ kind: "subagent_stop", sessionId: "missing" })).status, 404);
  const [row] = delegations(store);
  assert.equal(row.status, "done");
  assert.equal(row.round_trips, 1);
});
