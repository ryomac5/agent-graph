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
// ps の lstart と同じ形の起動時刻。iso から seconds ずらした地方時で返す
function lstart(iso: string, seconds: number): string {
  const date = new Date(Date.parse(iso) + seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
}
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
    store.insertUnnamedSession({ id, repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: at, pid: 4242, pidStartedAt: lstart(at, -60) });
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
  // 途中で落ちても見回りを止め、テストを終わらせる
  t.after(() => observer.stop());
  await observer.tick(); await observer.stop();
  assert.deepEqual(["human", "headless", "tagged"].map((id) => store.getSession(id)?.name), ["repo-001", "", ""]);
  assert.equal(store.listTurns("headless").length, 1, "無人実行の会話も turns には入る");
  assert.deepEqual(buildProjectView(store, "r")!.sessions.map((session) => session.id), ["human"]);
});

test("fork の転写に写された親の指示では、session.forked が無くても番号を取らない", async (t) => {
  const store = openStore(":memory:");
  store.upsertRepo({ key: "r", name: "repo", rootPath: "/repo" });
  // 親は番号を持つ。fork は親の行を写した転写を持ち、session.forked はまだ無い
  store.insertSession({ id: "parent", repoKey: "r", name: "repo-001", client: "claude", traceId: "a".repeat(32), startedAt: at });
  const forkStart = "2026-10-05T02:00:00.000Z";
  store.insertUnnamedSession({ id: "fork", repoKey: "r", client: "claude", traceId: "b".repeat(32), startedAt: forkStart,
    pid: 4243, pidStartedAt: lstart(forkStart, 0) });
  const root = await mkdtemp(join(tmpdir(), "graph-claude-fork-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  // 写された行は sessionId も fork の id に書き換わり、時刻だけが親のまま残る
  const copied = [{ type: "user", uuid: "c1", timestamp: at, entrypoint: "cli", sessionId: "fork", message: { content: "親への指示" } },
    { type: "assistant", uuid: "c2", timestamp: at, sessionId: "fork", message: { model: "m", content: [{ type: "text", text: "親の応答" }] } }];
  await mkdir(join(root, "-repo"));
  const path = join(root, "-repo", "fork.jsonl");
  await writeFile(path, copied.map((row) => JSON.stringify(row)).join("\n"));
  const observer = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  // 途中で落ちても見回りを止め、テストを終わらせる
  t.after(() => observer.stop());
  await observer.tick();
  assert.equal(store.getSession("fork")?.name, "", "親の行では番号を取らない");
  assert.equal(store.listEvents().filter((event) => event.kind === "session.named").length, 0);
  // fork 自身の指示が来れば番号を取る
  await writeFile(path, [...copied, { type: "user", uuid: "o1", timestamp: "2026-10-05T02:00:05.000Z", entrypoint: "cli",
    sessionId: "fork", message: { content: "続きをお願いします" } }].map((row) => JSON.stringify(row)).join("\n"));
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("fork")?.name, "repo-002");
});

test("daemon の停止中に受けた指示は、登録より古くても起動後なら番号を取り、起動時刻が取れるまでは待つ", async (t) => {
  const store = openStore(":memory:");
  store.upsertRepo({ key: "r", name: "repo", rootPath: "/repo" });
  const processStart = "2026-10-05T01:00:00.000Z";
  // 登録は daemon の再起動後。指示はそれより前に来ていた
  store.insertUnnamedSession({ id: "late", repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: "2026-10-05T03:00:00.000Z", pid: 4244 });
  const root = await mkdtemp(join(tmpdir(), "graph-claude-late-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "-repo"));
  await writeFile(join(root, "-repo", "late.jsonl"), JSON.stringify({ type: "user", uuid: "l1", timestamp: "2026-10-05T01:00:10.000Z",
    entrypoint: "cli", sessionId: "late", message: { content: "停止中の指示" } }));
  const observer = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  // 途中で落ちても見回りを止め、テストを終わらせる
  t.after(() => observer.stop());
  await observer.tick();
  assert.equal(store.getSession("late")?.name, "", "起動時刻が無いうちは付けない");
  store.setSessionProcess("late", 4244, lstart(processStart, 0), "2026-10-05T03:00:30.000Z");
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("late")?.name, "repo-001");
});

test("Claude はプロセスの死で終えた会話でも、終わったあとの発言が記録に増えれば稼働に戻し古い pid を外す", async (t) => {
  const store = fixture(); store.updateSessionClient("thread", "claude");
  store.db.prepare("UPDATE sessions SET pid = 4242, pid_started_at = 'x' WHERE id = 'thread'").run();
  store.endSession("thread", "2026-10-06T12:00:00.000Z", "process_exit");
  const root = await mkdtemp(join(tmpdir(), "graph-claude-revive-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "-repo"));
  const write = (stamp: string) => writeFile(join(root, "-repo", "thread.jsonl"), [
    { type: "user", uuid: `u-${stamp}`, timestamp: stamp, message: { content: "続けて" } },
    { type: "assistant", timestamp: stamp, message: { model: "claude-opus-5-5", content: [{ type: "text", text: "はい" }] } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  await write("2026-10-06T11:00:00.000Z");
  const before = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await before.tick(); await before.stop();
  assert.equal(store.getSession("thread")!.status, "ended", "終わる前の発言では戻さない");
  await write("2026-10-06T13:00:00.000Z");
  const after = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await after.tick(); await after.stop();
  const session = store.getSession("thread")!;
  assert.equal(session.status, "running");
  assert.equal(session.pid, undefined);
  assert.equal(session.lastSeenAt, "2026-10-06T13:00:00.000Z");
});

test("Claude の記録の continued-in から、会話を続けた先の会話 ID を残す", async (t) => {
  const store = fixture(); store.updateSessionClient("thread", "claude");
  const root = await mkdtemp(join(tmpdir(), "graph-claude-continued-"));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "-repo"));
  await writeFile(join(root, "-repo", "thread.jsonl"), [
    { type: "user", uuid: "u1", timestamp: at, message: { content: "状況を整理したい" } },
    { type: "continued-in", timestamp: at, sessionId: "thread", continuedInSessionId: "next-id" },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const observer = startClaudeObserver(new Map([["r", store]]), { root, intervalMs: 60_000 });
  await observer.tick(); await observer.stop();
  assert.equal(store.getSession("thread")!.continuedIn, "next-id");
});
