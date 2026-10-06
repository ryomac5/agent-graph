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
  writeFileSync(kitNamesPath(root), JSON.stringify({ a: "repo-014", b: "repo-001", c: "<script>", d: "repo-099" }));
  assert.equal(syncKitNames(store, new Date(at)), 1);
  assert.equal(store.getSession("a")!.name, "repo-014");
  assert.equal(store.getSession("b")!.name, "repo-001");
  assert.equal(store.getSession("c")!.name, "repo-030", "名前の形でない値は使わない");
  const named = store.db.prepare("SELECT payload FROM events WHERE kind = 'session.named'").all().map((row) => JSON.parse(String(row.payload)));
  assert.deepEqual(named, [{ sessionId: "a", name: "repo-014", reason: "kit" }]);
  assert.equal(syncKitNames(store), 0, "そろったあとは何もしない");
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
  store.insertSession({ id: "fork3", repoKey: "r", name: `${name}-003`, client: "claude", traceId: trace, startedAt: at });
  store.appendEvent({ id: "e1", ts: at, kind: "session.forked", repo: "r", session: "fork3", trace: { traceId: trace, spanId: "s".repeat(16) },
    payload: { sessionId: "fork3", parentSessionId: "kit3" } } as never);
  writeFileSync(kitNamesPath(root), JSON.stringify({ kit3: `${name}-003` }));
  assert.equal(syncKitNames(store, new Date(at)), 1);
  assert.equal(store.getSession("kit3")!.name, `${name}-003`);
  assert.equal(store.getSession("codex3")!.name, `${name}-006`, "重なった番号はキットの counter から取り直す");
  assert.equal(store.getSession("fork3")!.name, `${name}-003`, "fork は親の番号を継いだまま");
});
