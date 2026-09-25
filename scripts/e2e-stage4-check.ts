import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { repoKey, stateDbPath } from "../packages/core/src/paths.ts";
import { applySnapshot, applyDelegation, type Graph } from "../packages/dashboard/public/model.js";
import { openStore } from "../packages/core/src/store/store.ts";

const [mode, url, file] = process.argv.slice(2);
const key = repoKey(process.cwd());
const MAX_DELAY_MS = 2000;

if (mode === "listen") {
  const response = await fetch(`${url}api/events?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  writeFileSync(file, "");
  let state: Graph = { nodes: [], edges: [] };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
      const payload = JSON.parse(data.slice(6));
      if (event === "snapshot") {
        state = applySnapshot({ nodes: [], edges: [] }, payload);
        writeFileSync(file + ".ready", "ready\n");
      } else if (event === "delegation") {
        state = applyDelegation(state, payload);
        assert.ok(state.nodes.some((node) => node.id === payload.node.id));
      } else {
        throw new Error(`Unexpected event: ${event}`);
      }
      appendFileSync(file, JSON.stringify({ event, received, payload }) + "\n");
    }
  }
} else if (mode === "has-reverse") {
  const response = await fetch(`${url}api/graph?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  const graph = await response.json();
  process.exitCode = graph.edges.some((edge: { fromFamily: string; toFamily: string }) =>
    edge.fromFamily === "openai" && edge.toFamily === "anthropic") ? 0 : 2;
} else if (mode === "verify") {
  const response = await fetch(`${url}api/graph?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  const graph = await response.json();
  for (const [from, to] of [["anthropic", "openai"], ["openai", "anthropic"]]) {
    assert.ok(graph.edges.some((edge: { fromFamily: string; toFamily: string }) =>
      edge.fromFamily === from && edge.toFamily === to), `${from} -> ${to} edge missing`);
  }
  const arrivals = new Map<string, number>();
  let state: Graph = { nodes: [], edges: [] };
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    if (!line) continue;
    const item = JSON.parse(line);
    if (item.event === "snapshot") state = applySnapshot({ nodes: [], edges: [] }, item.payload);
    else {
      state = applyDelegation(state, item.payload);
      const id = item.payload.node.id;
      assert.ok(state.nodes.some((node) => node.id === id));
      if (!arrivals.has(id)) arrivals.set(id, item.received);
    }
  }
  assert.deepEqual([...state.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)), "SSE state must match graph nodes");
  assert.deepEqual(state.edges, applySnapshot({ nodes: [], edges: [] }, graph).edges,
    "SSE state must match graph edges");
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
  assert.match(await app.text(), /drawGraph/);
  console.log("PASS: graph directions, SSE <= 2000 ms, index.html and app.js");
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
