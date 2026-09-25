import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { repoKey, stateDbPath } from "../packages/core/src/paths.ts";
import { openStore } from "../packages/core/src/store/store.ts";

const [mode, url, file] = process.argv.slice(2);
const key = repoKey(process.cwd());

if (mode === "listen") {
  const response = await fetch(`${url}api/events?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  writeFileSync(file, "");
  process.stdout.write("ready\n");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = message.split("\n").find((line) => line.startsWith("data: "));
      if (!data) continue;
      const graph = JSON.parse(data.slice(6));
      for (const node of graph.nodes) {
        if (node.role !== "root") appendFileSync(file, `${JSON.stringify({ id: node.id, received: Date.now() })}\n`);
      }
    }
  }
} else if (mode === "seed-family") {
  const store = openStore(stateDbPath(key));
  try {
    store.insertAssignment(process.env.AGENT_GRAPH_DELEGATION!, {
      executor: process.env.AGENT_GRAPH_PARENT_EXECUTOR!, model: "e2e-parent",
      family: process.env.AGENT_GRAPH_PARENT_FAMILY! as "anthropic" | "openai", tier: "low",
      reason: [], policyVersion: "e2e",
    });
  } finally { store.close(); }
} else if (mode === "verify") {
  const response = await fetch(`${url}api/graph?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  const graph = await response.json();
  for (const [from, to] of [["anthropic", "openai"], ["openai", "anthropic"]]) {
    assert.ok(graph.edges.some((edge: { fromFamily: string; toFamily: string }) =>
      edge.fromFamily === from && edge.toFamily === to), `${from} -> ${to} edge missing`);
  }
  const arrivals = new Map<string, number>();
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    if (!line) continue;
    const item = JSON.parse(line);
    if (!arrivals.has(item.id)) arrivals.set(item.id, item.received);
  }
  const store = openStore(stateDbPath(key));
  try {
    const rows = store.db.prepare(`SELECT d.id, e.ts FROM delegations d JOIN events e
      ON e.kind = 'delegation.requested' AND json_extract(e.payload, '$.delegationId') = d.id
      WHERE d.role IN ('implement', 'document')`).all();
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      const elapsed = arrivals.get(String(row.id))! - Date.parse(String(row.ts));
      assert.ok(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 2000,
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
