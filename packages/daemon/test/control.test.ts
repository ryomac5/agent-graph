import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../../core/src/store/store.ts";
import { controlAction, type ControlClient } from "../src/control.ts";
import { parseAction } from "../src/actions.ts";

function fixture() {
  const store = openStore(":memory:");
  store.upsertRepo({ key: "r", rootPath: "/repo", name: "repo" });
  store.insertSession({ id: "s", repoKey: "r", name: "repo-001", client: "claude", traceId: "a".repeat(32), startedAt: "2026-10-05T01:00:00.000Z" });
  return { store, stores: new Map([["r", store]]) };
}

test("新規起動は登録済み PJ の cwd と検証済み client だけで起動する", async (t) => {
  const { store, stores } = fixture(); t.after(() => store.close());
  const calls: string[][] = [];
  const client: ControlClient = { run: async (args) => { calls.push(args); return JSON.stringify({ result: { pane_id: "w1:p2" } }); } };
  assert.equal((await controlAction({ action: "new_session", repo: "r", client: "codex" }, stores, client)).ok, true);
  assert.deepEqual(calls[0], ["tab", "create", "--label", "repo", "--cwd", "/repo", "--no-focus"]);
  assert.deepEqual(calls[1], ["pane", "run", "w1:p2", "export HERDR_PANE_ID=w1:p2; codex"]);
  assert.throws(() => parseAction({ action: "new_session", repo: "r", client: "codex; touch x" }), /Invalid client/);
  assert.throws(() => parseAction({ action: "set_model", repo: "r", sessionId: "s", model: "opus; touch x" }), /Invalid model/);
});

test("モデル変更は対象の pane に送り、確認を抜けるまで待つ。表示モデルを推測で更新しない", async (t) => {
  const { store, stores } = fixture(); t.after(() => store.close());
  const calls: string[][] = []; let read = 0;
  const client: ControlClient = { run: async (args) => {
    calls.push(args);
    if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: [{ pane_id: "p1", agent_session: { value: "s" } }] } });
    if (args[1] === "read") return read++ ? "Ready" : "Switching models";
    return "";
  } };
  const result = await controlAction({ action: "set_model", repo: "r", sessionId: "s", model: "opus" }, stores, client);
  assert.equal(result.ok, true);
  assert.ok(calls.some((args) => args.join(" ") === "agent prompt p1 /model opus"));
  assert.ok(calls.some((args) => args.join(" ") === "pane send-keys p1 enter"));
  assert.equal(store.getSession("s")!.model, undefined);
});

test("子の再実行は planner と分け、元の条件が無いときは理由を返す", async (t) => {
  const { store, stores } = fixture(); t.after(() => store.close());
  store.insertDelegation({ id: "d", repoKey: "r", sessionId: "s", role: "research", title: "調査", status: "failed", task: "依頼" });
  const result = await controlAction({ action: "rerun_delegation", repo: "r", sessionId: "s", delegationId: "d" }, stores);
  assert.equal(result.ok, false); assert.match(result.message, /実行条件/);
  store.finishDelegation("d", "running");
  assert.match((await controlAction({ action: "rerun_delegation", repo: "r", sessionId: "s", delegationId: "d" }, stores)).message, /状態/);
});

test("再実行は依頼・受け入れ条件・scope を保存どおり使い、二重起動を防ぎ、古い失敗を残す", async (t) => {
  const { store, stores } = fixture(); t.after(() => store.close());
  store.insertDelegation({ id: "d", repoKey: "r", sessionId: "s", role: "research", title: "調査", status: "failed", task: "元の依頼" });
  const original = { role: "research", title: "調査", task: "元の依頼", accept: ["original-check"], cwd: process.cwd(), scope: ["src/**"], outputs: ["report.txt"], review: false };
  store.db.prepare("INSERT INTO delegation_requests (delegation_id, request) VALUES (?, ?)").run("d", JSON.stringify(original));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let ran = ""; let checks: string[] = [];
  const body = { action: "rerun_delegation", repo: "r", sessionId: "s", delegationId: "d" };
  const result = await controlAction(body, stores, { run: async () => "" }, {
    execute: async (req) => {
      ran = req.task; await gate;
      return { exitCode: 0, output: "完了", timedOut: false, durationMs: 1, usage: { inputTokens: 1, outputTokens: 1 }, childTrace: req.trace };
    },
    accept: async (req) => { checks = req.commands; return { passed: true, results: [], scopeViolations: [] }; },
  });
  assert.equal(result.ok, true);
  assert.match((await controlAction(body, stores)).message, /再実行中/);
  release();
  for (let i = 0; i < 100; i++) {
    if (store.db.prepare("SELECT 1 FROM delegations WHERE id != 'd' AND status = 'done'").get()) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(ran, "元の依頼"); assert.deepEqual(checks, ["original-check"]);
  assert.equal(store.db.prepare("SELECT status FROM delegations WHERE id = 'd'").get()!.status, "failed");
  const created = store.db.prepare("SELECT id, status FROM delegations WHERE id != 'd'").get()!;
  assert.equal(created.status, "done");
  assert.deepEqual(JSON.parse(String(store.db.prepare("SELECT request FROM delegation_requests WHERE delegation_id = ?").get(String(created.id))!.request)), original);
});
