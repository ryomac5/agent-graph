import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
