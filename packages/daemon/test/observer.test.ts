import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../core/src/store/store.ts";
import { applyCodexSnapshot, parseCodexRows, startCodexObserver } from "../src/codex-observe.ts";
import { parseClaudeRows, startClaudeObserver } from "../src/claude-observe.ts";
import { buildProjectView } from "../src/http/views.ts";

const at = "2026-10-05T01:00:00.000Z";
function fixture() {
  const store = openStore(":memory:");
  store.upsertRepo({ key: "r", name: "repo", rootPath: "/repo" });
  store.insertSession({ id: "thread", repoKey: "r", name: "repo-001", client: "codex", traceId: "a".repeat(32), startedAt: at });
  return store;
}
function rows(id = "thread", parent?: string) {
  return [
    { type: "session_meta", timestamp: at, payload: { id, cwd: "/repo", ...(parent ? { source: { subagent: { spawn: { parent_thread_id: parent } } } } : {}) } },
    { type: "event_msg", timestamp: at, payload: { type: "task_started", turn_id: "turn1" } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "調査してください" }] } },
    { type: "turn_context", timestamp: at, payload: { model: "gpt-6.1-sol" } },
    { type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", phase: "analysis", content: [{ type: "output_text", text: "非公開の推論" }] } },
    { type: "event_msg", timestamp: "2026-10-05T01:01:00.000Z", payload: { type: "task_complete", last_agent_message: "全文\n".repeat(80) } },
  ];
}

test("Codex はモデルと応答全文を取り込み、推論は会話に含めず、再取り込みでも重複しない", (t) => {
  const store = fixture(); t.after(() => store.close());
  const snapshot = parseCodexRows(rows())!;
  assert.equal(snapshot.model, "gpt-6.1-sol");
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].prompt, "調査してください");
  applyCodexSnapshot(store, store.getSession("thread")!, snapshot);
  store.setTurnHidden(snapshot.turns[0].id, true);
  applyCodexSnapshot(store, store.getSession("thread")!, snapshot);
  const view = buildProjectView(store, "r")!;
  assert.equal(view.sessions[0].model, "gpt-6.1-sol");
  assert.equal(view.sessions[0].turns.length, 1);
  assert.equal(view.sessions[0].turns[0].reply, "全文\n".repeat(80));
  assert.equal(view.sessions[0].turns[0].hidden, true);
  assert.ok(!JSON.stringify(view).includes("非公開の推論"));
});

test("Codex observer は登録された根と親子関係が一致する子だけを取り込む", async (t) => {
  const store = fixture();
  const root = await mkdtemp(join(tmpdir(), "graph-codex-observe-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const dir = join(root, "2026", "10", "05"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-01-thread.jsonl"), rows().map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(dir, "rollout-02-child.jsonl"), rows("child", "thread").map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(join(dir, "rollout-03-unrelated.jsonl"), rows("unrelated", "other").map((row) => JSON.stringify(row)).join("\n") + "\n");
  const observer = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000, onError: (error) => { throw error; } });
  await observer.tick(); await observer.tick(); await observer.stop();
  const nodes = buildProjectView(store, "r")!.sessions[0].nodes;
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1].executor, "codex");
  assert.equal(nodes[1].model, "gpt-6.1-sol");
  assert.equal(nodes[1].status, "done");
  assert.equal(nodes[1].rounds?.length, 2);
});

test("Claude の履歴はモデルと公開本文だけを読み、既存の往復と非表示を保つ", async (t) => {
  const store = fixture(); store.updateSessionClient("thread", "claude");
  store.insertTurn({ id: "old", sessionId: "thread", at, prompt: "依頼" }); store.setTurnHidden("old", true);
  const root = await mkdtemp(join(tmpdir(), "graph-claude-observe-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const entries = [
    { type: "user", uuid: "u1", timestamp: at, message: { content: "依頼" } },
    { type: "assistant", timestamp: at, message: { model: "claude-opus-4-6", content: [{ type: "thinking", text: "推論" }, { type: "text", text: "回答の全文" }] } },
  ];
  assert.equal(parseClaudeRows(entries).turns[0].reply, "回答の全文");
  await mkdir(join(root, "-repo")); await writeFile(join(root, "-repo", "thread.jsonl"), entries.map((row) => JSON.stringify(row)).join("\n"));
  const observer = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await observer.tick(); await observer.stop();
  const session = buildProjectView(store, "r")!.sessions[0];
  assert.equal(session.model, "claude-opus-4-6");
  assert.equal(session.turns.length, 1); assert.equal(session.turns[0].reply, "回答の全文"); assert.equal(session.turns[0].hidden, true);
});

test("Claude は設定ディレクトリ内のサブディレクトリ起動の履歴も UUID で取得する", async (t) => {
  const store = fixture(); store.updateSessionClient("thread", "claude");
  const home = await mkdtemp(join(tmpdir(), "graph-claude-custom-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    store.close(); await rm(home, { recursive: true, force: true });
  });
  const dir = join(home, "projects", "-repo-nested"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "thread.jsonl"), JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6", content: [] } }));
  const observer = startClaudeObserver(new Map([["r", store]]), { intervalMs: 60_000 });
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("thread")!.model, "claude-sonnet-4-6");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 1);
});

test("Codex は thread id のない MCP 登録を一意な直近の根に結び、再起動後も取得する", async (t) => {
  const store = fixture();
  const root = await mkdtemp(join(tmpdir(), "graph-codex-binding-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "rollout-01-native.jsonl"), rows("native").map((row) => JSON.stringify(row)).join("\n"));
  await writeFile(join(root, "rollout-02-child.jsonl"), rows("child", "native").map((row) => JSON.stringify(row)).join("\n"));
  const observer = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("thread")!.model, "gpt-6.1-sol");
  assert.equal(store.db.prepare("SELECT source_thread_id FROM sessions WHERE id = 'thread'").get()!.source_thread_id, "native");
  const restarted = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await restarted.tick(); await restarted.stop();
  assert.equal(buildProjectView(store, "r")!.sessions[0].nodes.length, 2);
});

test("Codex は複数の根が同時に起動しているときモデルを推測して結ばない", async (t) => {
  const store = fixture();
  const root = await mkdtemp(join(tmpdir(), "graph-codex-ambiguous-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (const id of ["one", "two"]) await writeFile(join(root, `rollout-${id}.jsonl`), rows(id).map((row) => JSON.stringify(row)).join("\n"));
  const observer = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("thread")!.model, undefined);
  assert.equal(store.db.prepare("SELECT source_thread_id FROM sessions WHERE id = 'thread'").get()!.source_thread_id, null);
});

test("Codex のプロセスが子のログも開いていても、モデルは根のログから取得する", async (t) => {
  const store = fixture(); store.setSessionProcess("thread", 42, undefined, at);
  const root = await mkdtemp(join(tmpdir(), "graph-codex-open-files-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const files = [join(root, "rollout-native.jsonl"), join(root, "rollout-child.jsonl")];
  // 再開済みの会話は開始時刻による補完では結べない。開いているファイルを使う。
  await writeFile(files[0], rows("native").map((row) => JSON.stringify(row).replaceAll(at, "2026-01-01T01:00:00.000Z")).join("\n"));
  await writeFile(files[1], rows("child", "native").map((row) => JSON.stringify(row)).join("\n"));
  const observer = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000, openFiles: async () => files });
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("thread")!.model, "gpt-6.1-sol");
});

test("Codex のアーカイブはプロセスが残っていても終了扱いになり、他のセッションの観測を妨げない", async (t) => {
  const store = fixture(); store.setSessionProcess("thread", process.pid, undefined, at);
  const home = await mkdtemp(join(tmpdir(), "graph-codex-archive-"));
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const root = join(home, "sessions"); const archived = join(home, "archived_sessions");
  await mkdir(root); await mkdir(archived);
  const name = "rollout-thread.jsonl";
  await writeFile(join(root, name), rows().map((row) => JSON.stringify(row)).join("\n"));
  const observer = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await observer.tick();
  await rename(join(root, name), join(archived, name));
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("thread")!.status, "ended");
  assert.equal(store.getSession("thread")!.model, "gpt-6.1-sol");
  const restarted = startCodexObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await restarted.tick(); await restarted.stop();
  assert.equal(store.getSession("thread")!.status, "ended");
});

test("空の store で起動した観測も、あとから足した store を次の回で読む", async (t) => {
  // デーモンは store を開く前に観測を起動する。最初の回が await を通らずに終わると、以後の回が二度と動かなかった
  const store = fixture(); store.updateSessionClient("thread", "claude");
  const root = await mkdtemp(join(tmpdir(), "graph-claude-late-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "-repo"));
  await writeFile(join(root, "-repo", "thread.jsonl"), JSON.stringify({ type: "assistant", timestamp: at, message: { model: "claude-opus-5-5", content: [] } }));
  const stores = new Map<string, ReturnType<typeof fixture>>();
  const claude = startClaudeObserver(stores, { root, intervalMs: 60_000 });
  const codex = startCodexObserver(stores, { root, intervalMs: 60_000 });
  await claude.tick(); await codex.tick();
  stores.set("r", store);
  await claude.tick();
  assert.equal(store.getSession("thread")?.model, "claude-opus-5-5");
  await claude.stop(); await codex.stop();
});

test("Claude の転写から入れた会話は、人の指示があれば番号を取り、無人実行なら取らない", async (t) => {
  const store = openStore(":memory:");
  store.upsertRepo({ key: "r", name: "repo", rootPath: "/repo" });
  for (const id of ["human", "headless", "tagged"]) {
    store.insertUnnamedSession({ id, repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: at });
  }
  const root = await mkdtemp(join(tmpdir(), "graph-claude-name-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const user = (uuid: string, content: string, entrypoint = "cli") => ({ type: "user", uuid, timestamp: at, entrypoint, message: { content } });
  const transcripts: Record<string, unknown[]> = {
    // daemon の停止中に人が指示した会話。先頭はタグだけの入力
    human: [user("h0", "<system-reminder>文脈</system-reminder>"), user("h1", "認証を直して")],
    headless: [user("p1", "無人実行です。作業してください", "sdk-cli")],
    tagged: [user("t1", "<task-notification>\n<task-id>a</task-id>\n</task-notification>")],
  };
  await mkdir(join(root, "-repo"));
  for (const [id, entries] of Object.entries(transcripts)) {
    await writeFile(join(root, "-repo", `${id}.jsonl`), entries.map((row) => JSON.stringify(row)).join("\n"));
  }
  const observer = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await observer.tick(); await observer.stop();
  assert.deepEqual(["human", "headless", "tagged"].map((id) => store.getSession(id)?.name), ["repo-001", "", ""]);
  assert.equal(store.listTurns("headless").length, 1, "無人実行の会話も turns には入る");
  assert.deepEqual(buildProjectView(store, "r")!.sessions.map((session) => session.id), ["human"]);
});
