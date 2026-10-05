import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
import { openStore } from "../../core/src/store/store.ts";
import { turnsRoute } from "../src/http/routes/turns.ts";
import type { RouteContext } from "../src/http/route.ts";

test("会話のページは時系列で取り、同時刻でも重複せず、他セッションの cursor は使えない", async (t) => {
  const store = openStore(":memory:"); t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: "/repo", name: "repo" });
  for (const id of ["s", "other"]) store.insertSession({ id, repoKey: "r", name: id, client: "claude", traceId: "a".repeat(32), startedAt: "2026-10-05" });
  // 履歴の補完で古い行が後から挿入された場合も、rowid だけでは並べない。
  for (let i = 100; i >= 0; i--) store.insertTurn({ id: `t${i}`, sessionId: "s", at: `2026-10-05T01:${String(Math.floor(i / 2)).padStart(2, "0")}:00.000Z`, prompt: `依頼${i}`, reply: `全文${i}` });
  store.insertTurn({ id: "foreign", sessionId: "other", at: "2026-10-04", prompt: "別のセッション" });
  const request = async (query: string) => {
    let status = 0; let value: { turns?: { id: string; reply?: string }[]; hasMore?: boolean } = {};
    const response = { writeHead: (code: number) => { status = code; }, end: (body: string) => { value = JSON.parse(body); } } as unknown as ServerResponse;
    await turnsRoute.handle({ options: { openStores: new Map([["r", store]]) }, url: new URL(`http://127.0.0.1/api/turns?repo=r&session=s${query}`), response } as RouteContext);
    return { status, value };
  };
  const first = await request(""); assert.equal(first.status, 200); assert.equal(first.value.turns!.length, 50); assert.equal(first.value.hasMore, true);
  const second = await request(`&before=${first.value.turns![0].id}`);
  const third = await request(`&before=${second.value.turns![0].id}`);
  const all = [...first.value.turns!, ...second.value.turns!, ...third.value.turns!];
  assert.equal(new Set(all.map((turn) => turn.id)).size, 101); assert.equal(third.value.hasMore, false);
  assert.ok(all.every((turn) => turn.reply?.startsWith("全文")));
  assert.equal((await request("&before=foreign")).status, 400);
});
