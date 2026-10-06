import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../../core/src/store/store.ts";
import { readFileSync } from "node:fs";
import { allocateKitName, kitCounterPath, kitNamesPath, nameAtFirstPrompt, readKitNames, syncKitNames } from "../src/kit-names.ts";
import { UNNAMED } from "../../core/src/store/store.ts";

test("キットの番号と違う名前を付け替え、同じなら触らず、形の違う値と壊れた JSON は無視する", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ag-kit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents", "state"), { recursive: true });
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: root, name: "repo" });
  const at = "2026-10-07T00:00:00.000Z";
  store.insertSession({ id: "a", repoKey: "r", name: "repo-024", client: "claude", traceId: "t".repeat(32), startedAt: at });
  store.insertSession({ id: "b", repoKey: "r", name: "repo-001", client: "claude", traceId: "t".repeat(32), startedAt: at });
  store.insertSession({ id: "c", repoKey: "r", name: "repo-030", client: "codex", traceId: "t".repeat(32), startedAt: at });
  store.insertTurn({ id: "tc", sessionId: "c", at, prompt: "直して" });
  writeFileSync(kitNamesPath(root), JSON.stringify({ a: "repo-014", b: "repo-001", c: "<script>", d: "repo-099" }));
  assert.equal(syncKitNames(store, new Date(at), () => "repo-031"), 2);
  assert.equal(store.getSession("a")!.name, "repo-014");
  assert.equal(store.getSession("b")!.name, "repo-001");
  assert.equal(store.getSession("c")!.name, "repo-031", "名前の形でない値は使わず、自前の番号はキットの counter から取り直す");
  const named = store.db.prepare("SELECT payload FROM events WHERE kind = 'session.named'").all().map((row) => JSON.parse(String(row.payload)));
  assert.deepEqual(named, [{ sessionId: "a", name: "repo-014", reason: "kit" }, { sessionId: "c", name: "repo-031", reason: "kit" }]);
  assert.equal(syncKitNames(store, new Date(at), () => { throw new Error("取り直さない"); }), 0, "そろったあとは何もしない");
  writeFileSync(kitNamesPath(root), "{ broken");
  assert.equal(readKitNames(root).get("a"), "repo-014", "書きかけの JSON は前に読んだ値を使う");
  assert.equal(readKitNames(join(root, "missing")).size, 0);
});

function kitRepo(t: { after: (fn: () => void) => void }, counter: number) {
  const root = mkdtempSync(join(tmpdir(), "ag-kitc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".agents", "state"), { recursive: true });
  writeFileSync(kitCounterPath(root), String(counter));
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: root, name: root.split("/").pop()! });
  return { root, store, name: root.split("/").pop()! };
}

test("キットの counter をキットと同じ手順で 1 つ進め、キットと同じ形の名前を返す", (t) => {
  const { root, name } = kitRepo(t, 14);
  assert.equal(allocateKitName(root), `${name}-015`);
  assert.equal(readFileSync(kitCounterPath(root), "utf8"), "15");
});

test("キットのあるリポジトリでは Claude の会話はキットの番号を待ち、Codex の会話はキットの counter から取る", (t) => {
  const { root, store, name } = kitRepo(t, 14);
  const at = "2026-10-07T00:00:00.000Z";
  store.insertUnnamedSession({ id: "cl", repoKey: "r", client: "claude", traceId: "t".repeat(32), startedAt: at });
  store.insertUnnamedSession({ id: "cx", repoKey: "r", client: "codex", traceId: "t".repeat(32), startedAt: at });
  nameAtFirstPrompt(store, "cl", at);
  assert.equal(store.getSession("cl")!.name, UNNAMED, "Claude はキットの hook が付けるまで待つ");
  nameAtFirstPrompt(store, "cx", at);
  assert.equal(store.getSession("cx")!.name, `${name}-015`);
  writeFileSync(kitNamesPath(root), JSON.stringify({ cl: `${name}-016` }));
  writeFileSync(kitCounterPath(root), "16");
  syncKitNames(store, new Date("2026-10-07T00:00:05.000Z"));
  assert.equal(store.getSession("cl")!.name, `${name}-016`, "キットが書いた番号を使う。番号は取り合わない");
  assert.equal(readFileSync(kitCounterPath(root), "utf8"), "16");
});

test("キットが待つ時間を過ぎても番号を書かなければ、キットの counter から取る", (t) => {
  const { store, name } = kitRepo(t, 3);
  const at = "2026-10-07T00:00:00.000Z";
  store.insertUnnamedSession({ id: "late", repoKey: "r", client: "claude", traceId: "t".repeat(32), startedAt: at });
  nameAtFirstPrompt(store, "late", at);
  syncKitNames(store, new Date("2026-10-07T00:01:00.000Z"));
  assert.equal(store.getSession("late")!.name, UNNAMED, "待つ時間のうちは付けない");
  syncKitNames(store, new Date("2026-10-07T00:03:00.000Z"));
  assert.equal(store.getSession("late")!.name, `${name}-004`);
});

test("キットの番号と重なった、キットが知らない会話は取り直し、fork で親の番号を継いだものは残す", (t) => {
  const { root, store, name } = kitRepo(t, 5);
  const at = "2026-10-07T00:00:00.000Z";
  const trace = "t".repeat(32);
  store.insertSession({ id: "kit3", repoKey: "r", name: `${name}-003`, client: "claude", traceId: trace, startedAt: at });
  store.insertSession({ id: "codex3", repoKey: "r", name: `${name}-003`, client: "codex", traceId: trace, startedAt: at });
  store.insertTurn({ id: "t3", sessionId: "codex3", at, prompt: "調べて" });
  store.insertSession({ id: "fork3", repoKey: "r", name: `${name}-003`, client: "claude", traceId: trace, startedAt: at });
  store.appendEvent({ id: "e1", ts: at, kind: "session.forked", repo: "r", session: "fork3", trace: { traceId: trace, spanId: "s".repeat(16) },
    payload: { sessionId: "fork3", parentSessionId: "kit3" } } as never);
  writeFileSync(kitNamesPath(root), JSON.stringify({ kit3: `${name}-003` }));
  assert.equal(syncKitNames(store, new Date(at)), 1);
  assert.equal(store.getSession("kit3")!.name, `${name}-003`);
  assert.equal(store.getSession("codex3")!.name, `${name}-006`, "重なった番号はキットの counter から取り直す");
  assert.equal(store.getSession("fork3")!.name, `${name}-003`, "fork は親の番号を継いだまま");
});

test("daemon が昔自分で付けた番号は重なっていなくても取り直し、取った番号が使用中なら次へ進む", (t) => {
  const { root, store, name } = kitRepo(t, 2);
  const at = "2026-10-07T00:00:00.000Z";
  const trace = "t".repeat(32);
  // 昔の daemon は人の指示が無い会話にも 003 から 005 を付けていた
  for (const [id, number] of [["old3", 3], ["old4", 4], ["old5", 5]] as const) {
    store.insertSession({ id, repoKey: "r", name: `${name}-00${number}`, client: "claude", traceId: trace, startedAt: at });
    store.insertTurn({ id: `t-${id}`, sessionId: id, at, prompt: "調べて" });
  }
  store.insertSession({ id: "empty", repoKey: "r", name: `${name}-009`, client: "codex", traceId: trace, startedAt: at });
  writeFileSync(kitNamesPath(root), JSON.stringify({}));
  syncKitNames(store, new Date(at));
  const names = ["old3", "old4", "old5"].map((id) => store.getSession(id)!.name);
  assert.equal(new Set(names).size, 3, "取り直したあとも重ならない");
  // counter は 2 なので 003 から取る。003 は old3 自身なので使え、004 と 005 も同じく自分の番号に戻る
  assert.deepEqual(names, [`${name}-003`, `${name}-004`, `${name}-005`]);
  assert.equal(readFileSync(kitCounterPath(root), "utf8"), "5", "キットの counter が 3 つの番号を予約した");
  assert.equal(store.getSession("empty")!.name, UNNAMED, "人の指示を受けていない会話は番号を予約せずに外す");
  for (const n of names) assert.ok(Number(n.slice(-3)) >= 3 && Number(n.slice(-3)) <= Number(readFileSync(kitCounterPath(root), "utf8")), "番号はキットの counter が予約した範囲にある");
  assert.equal(syncKitNames(store, new Date(at)), 0, "キットの counter から取った番号は二度と取り直さない");
});
