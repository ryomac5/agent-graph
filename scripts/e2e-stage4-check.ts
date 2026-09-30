import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { repoKey, stateDbPath } from "../packages/core/src/paths.ts";
import type { EdgeDetail, NodeDetail, ProjectView } from "../packages/daemon/src/http/contract.ts";
import { openStore } from "../packages/core/src/store/store.ts";

const [mode, url, file] = process.argv.slice(2);
const key = repoKey(process.cwd());
const MAX_DELAY_MS = 2000;

// ProjectView の各セッションの委譲の node を集める。根は委譲ではないので数えない
function delegationNodes(view: ProjectView): NodeDetail[] {
  return view.sessions.flatMap((session) => session.nodes.filter((node) => node.kind !== "root"));
}

function sessionEdges(view: ProjectView): EdgeDetail[] {
  return view.sessions.flatMap((session) => session.edges);
}

if (mode === "listen") {
  const response = await fetch(`${url}api/events?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  writeFileSync(file, "");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ready = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("SSE stream ended before verification completed");
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = message.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const received = Date.now();
      const event = message.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
      // 契約では repo を付けた購読は project の全体だけを送る
      if (event !== "project") throw new Error(`Unexpected event: ${event}`);
      const payload = JSON.parse(data.slice(6)) as ProjectView;
      assert.ok(Array.isArray(payload.sessions) && Array.isArray(payload.graphs), "project payload must follow ProjectView");
      if (!ready) { writeFileSync(file + ".ready", "ready\n"); ready = true; }
      appendFileSync(file, JSON.stringify({ event, received, ids: delegationNodes(payload).map((node) => node.id) }) + "\n");
    }
  }
} else if (mode === "has-reverse") {
  const response = await fetch(`${url}api/graph?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  const graph = await response.json();
  process.exitCode = graph.edges.some((edge: { fromFamily: string; toFamily: string }) =>
    edge.fromFamily === "openai" && edge.toFamily === "anthropic") ? 0 : 2;
} else if (mode === "verify") {
  const response = await fetch(`${url}api/project?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  const view = await response.json() as ProjectView;
  const edges = sessionEdges(view);
  for (const [from, to] of [["anthropic", "openai"], ["openai", "anthropic"]]) {
    assert.ok(edges.some((edge) => edge.kind === "delegate" && edge.fromFamily === from && edge.toFamily === to), `${from} -> ${to} edge missing`);
  }
  // 各委譲が SSE の project に初めて現れた時刻
  const arrivals = new Map<string, number>();
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    if (!line) continue;
    const item = JSON.parse(line) as { received: number; ids: string[] };
    for (const id of item.ids) if (!arrivals.has(id)) arrivals.set(id, item.received);
  }
  const shown = new Set(delegationNodes(view).map((node) => node.id));
  for (const id of shown) assert.ok(arrivals.has(id), `Delegation ${id} never arrived over SSE`);
  const store = openStore(stateDbPath(key));
  try {
    const rows = store.db.prepare(`SELECT d.id, d.status, e.ts FROM delegations d LEFT JOIN events e
      ON e.kind = 'delegation.requested' AND json_extract(e.payload, '$.delegationId') = d.id`).all();
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.status, "done", `Delegation ${row.id} did not complete`);
      assert.ok(row.ts, `Missing creation event for ${row.id}`);
      // ULID の時刻は行の INSERT 直前。後続イベントの時刻より厳しい起点にする。
      const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
      const createdAt = [...String(row.id).slice(0, 10)].reduce((time, char) => time * 32 + alphabet.indexOf(char), 0);
      const elapsed = arrivals.get(String(row.id))! - Math.min(createdAt, Date.parse(String(row.ts)));
      assert.ok(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= MAX_DELAY_MS,
        `SSE ${row.id}: ${elapsed} ms`);
    }
  } finally { store.close(); }
  const html = await fetch(url);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<html/);
  const app = await fetch(`${url}app.js`);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /ui\/project\.js/);
  console.log("PASS: graph directions, SSE <= 2000 ms, index.html and app.js");
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
