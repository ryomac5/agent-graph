import assert from "node:assert/strict";
import test from "node:test";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { parseSay, sayToSession, type Herdr } from "../src/say.ts";
import { NotFoundError } from "../src/sessions.ts";

const startedAt = "2026-09-25T00:00:00.000Z";
const repo = "repo-abc123";
const sessionId = "0a18b147-c116-4c4d-b2c1-a7e52ccc3853";

function fixture(): { store: Store; stores: Map<string, Store> } {
  const store = openStore(":memory:");
  store.upsertRepo({ key: repo, rootPath: "/repo", name: "repo" });
  store.insertSession({ id: sessionId, repoKey: repo, name: "repo-001", client: "claude", traceId: "a".repeat(32), startedAt });
  return { store, stores: new Map([[repo, store]]) };
}

test("parseSay は body を検べる", () => {
  assert.throws(() => parseSay(null), TypeError);
  assert.throws(() => parseSay([]), TypeError);
  assert.throws(() => parseSay({ repo: "", sessionId, text: "x" }), /Invalid repo/);
  assert.throws(() => parseSay({ repo, sessionId: "", text: "x" }), /Invalid sessionId/);
  assert.throws(() => parseSay({ repo, sessionId, text: 1 }), /Invalid text/);
  assert.deepEqual(parseSay({ repo, sessionId, text: "hi" }), { repo, sessionId, text: "hi" });
});

test("空・/ 始まり・長すぎる本文は送らず ok: false", async (t) => {
  const { store, stores } = fixture();
  t.after(() => store.close());
  const base = { repo, sessionId };
  assert.equal((await sayToSession({ ...base, text: "   " }, stores)).ok, false);
  assert.match((await sayToSession({ ...base, text: "/exit" }, stores)).message, /\/ の本文/);
  assert.equal((await sayToSession({ ...base, text: "x".repeat(4001) }, stores)).ok, false);
  // 未知の repo は NotFoundError
  await assert.rejects(sayToSession({ repo: "other-0", sessionId, text: "x" }, new Map()), NotFoundError);
});

test("claude 以外・ended のセッションには送らない", async (t) => {
  const { store, stores } = fixture();
  t.after(() => store.close());
  // ended なら ok: false
  store.endSession(sessionId, new Date().toISOString(), "explicit");
  const result = await sayToSession({ repo, sessionId, text: "hi" }, stores);
  assert.equal(result.ok, false);
  assert.match(result.message, /終了済み/);
  // 未知の対象は NotFoundError
  await assert.rejects(sayToSession({ repo, sessionId: "nope", text: "hi" }, stores), NotFoundError);
  await assert.rejects(sayToSession({ repo: "other-0", sessionId, text: "hi" }, stores), NotFoundError);
});

test("Codex も Herdr に対象が無ければ送らない", async (t) => {
  const { store, stores } = fixture();
  t.after(() => store.close());
  store.insertSession({ id: "sx", repoKey: repo, name: "repo-002", client: "codex", traceId: "b".repeat(32), startedAt });
  const result = await sayToSession({ repo, sessionId: "sx", text: "hi" }, stores, { list: async () => "{}", prompt: async () => {} });
  assert.equal(result.ok, false);
  assert.match(result.message, /見つかりません/);
});

test("pane が無ければ ok: false、あれば herdr prompt で送る", async (t) => {
  const { store, stores } = fixture();
  t.after(() => store.close());
  const listJson = JSON.stringify({ result: { agents: [{ pane_id: "w1:p1", agent_session: { agent: "claude", value: sessionId } }] } });
  let sent = "";
  const client: Herdr = {
    list: async () => listJson,
    prompt: async (paneId, text) => { sent = `${paneId}|${text}`; },
  };
  const missing = await sayToSession({ repo, sessionId, text: "hi" }, stores, { list: async () => "{}", prompt: async () => {} });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /見つかりません/);
  const ok = await sayToSession({ repo, sessionId, text: "hi there" }, stores, client);
  assert.equal(ok.ok, true);
  assert.equal(sent, "w1:p1|hi there");
  // 改行は 1 行に潰す。list が壊れた JSON なら pane 無し扱い
  const broken = await sayToSession({ repo, sessionId, text: "a\nb" }, stores, { list: async () => "not json", prompt: async () => {} });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /見つかりません/);
  // prompt が失敗すれば ok: false
  const fail = await sayToSession({ repo, sessionId, text: "hi" }, stores, { list: async () => listJson, prompt: async () => { throw new Error("boom"); } });
  assert.equal(fail.ok, false);
  assert.match(fail.message, /失敗/);
});
