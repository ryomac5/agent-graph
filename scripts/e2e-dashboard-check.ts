// ダッシュボード e2e の検証。overview/project の契約を全フィールド検べ、HTTP の Approve を送る。
import assert from "node:assert/strict";
import { repoKey } from "../packages/core/src/paths.ts";

const [mode, url, ...rest] = process.argv.slice(2);

function expectShape(value: unknown, keys: readonly string[]): void {
  assert.ok(value !== null && typeof value === "object", "expected object");
  for (const key of keys) assert.ok(key in (value as Record<string, unknown>), `missing key ${key}`);
}

if (mode === "overview") {
  const response = await fetch(`${url}api/overview`);
  assert.equal(response.status, 200);
  const overview = await response.json();
  expectShape(overview, ["projects", "usage", "updatedAt"]);
  assert.ok(Array.isArray(overview.projects));
  assert.ok(Array.isArray(overview.usage.windows));
  assert.equal(typeof overview.updatedAt, "string");
  for (const project of overview.projects) {
    expectShape(project, ["key", "name", "rootPath", "counts", "liveSessions", "status"]);
    expectShape(project.counts, ["running", "waiting", "failed", "done"]);
  }
  for (const window of overview.usage.windows) {
    expectShape(window, ["key", "label", "provider", "percent"]);
    assert.ok(["anthropic", "openai"].includes(window.provider));
  }
  console.log("overview contract ok");
} else if (mode === "project") {
  const key = repoKey(process.cwd());
  const response = await fetch(`${url}api/project?repo=${encodeURIComponent(key)}`);
  assert.equal(response.status, 200);
  const view = await response.json();
  expectShape(view, ["project", "sessions", "graphs", "usage", "updatedAt"]);
  expectShape(view.project, ["key", "name", "rootPath"]);
  assert.ok(Array.isArray(view.sessions));
  assert.ok(Array.isArray(view.graphs));
  assert.ok(Array.isArray(view.usage.windows));
  assert.equal(typeof view.updatedAt, "string");
  const statuses = new Set(["planned", "running", "waiting", "waiting_human", "conflict", "done", "failed", "rejected", "lost", "timeout", "denied", "ended"]);
  for (const session of view.sessions) {
    expectShape(session, ["id", "name", "status", "startedAt", "turns", "nodes", "edges"]);
    assert.ok(statuses.has(session.status));
    assert.ok(Array.isArray(session.turns));
    assert.ok(Array.isArray(session.nodes));
    assert.ok(Array.isArray(session.edges));
    for (const node of session.nodes) {
      expectShape(node, ["id", "kind", "title", "status"]);
      assert.ok(statuses.has(node.status));
    }
    for (const edge of session.edges) {
      expectShape(edge, ["id", "from", "to", "kind"]);
      assert.ok(["delegate", "return", "depends"].includes(edge.kind));
    }
  }
  for (const graph of view.graphs) {
    expectShape(graph, ["id", "goal", "nodes", "edges"]);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(Array.isArray(graph.edges));
  }
  console.log("project contract ok");
} else if (mode === "approve") {
  const key = repoKey(process.cwd());
  const graphId = rest[0];
  const taskId = rest[1];
  const token = rest[2];
  const response = await fetch(`${url}api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-graph-token": token },
    body: JSON.stringify({ action: "approve", repo: key, graphId, taskId }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  console.log("approve sent ok");
} else {
  throw new Error(`unknown mode: ${mode}`);
}
