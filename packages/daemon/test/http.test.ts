import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../../core/src/store/store.ts";
import { applySnapshot, applyDelegation } from "../../dashboard/public/model.js";
import { buildGraph, diffGraph } from "../src/http/graph.ts";
import { startHttpServer } from "../src/http/server.ts";

const startedAt = "2026-09-25T00:00:00.000Z";

function getRawPath(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = request({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    client.on("error", reject);
    client.end();
  });
}

test("グラフは親子の向きとモデル系統を保持する", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "repo", rootPath: "/repo", name: "repo" });
  store.insertSession({ id: "session", repoKey: "repo", name: "repo-1", client: "claude",
    traceId: "a".repeat(32), startedAt });
  store.insertDelegation({ id: "first", repoKey: "repo", sessionId: "session",
    role: "implement", title: "first", status: "running" });
  store.insertAssignment("first", { executor: "codex", model: "gpt", family: "openai",
    tier: "mid", reason: [], policyVersion: "1" });
  store.insertDelegation({ id: "second", repoKey: "repo", sessionId: "session", parentId: "first",
    role: "review", title: "second", status: "done" });
  store.insertAssignment("second", { executor: "claude", model: "opus", family: "anthropic",
    tier: "high", reason: [], policyVersion: "1" });
  const graph = buildGraph(store.db, { session: "session" });
  assert.deepEqual(graph.edges, [
    { from: "session", to: "first", fromFamily: "anthropic", toFamily: "openai" },
    { from: "first", to: "second", fromFamily: "openai", toFamily: "anthropic" },
  ]);
  assert.equal(graph.nodes[2].model, "opus");
});

test("HTTP graph と SSE は委譲を配信し、静的ファイルを制限する", async (t) => {
  const store = openStore(":memory:");
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-http-"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.upsertRepo({ key: "repo", rootPath: directory, name: "repo" });
  store.insertSession({ id: "session", repoKey: "repo", name: "repo-1", client: "claude",
    traceId: "a".repeat(32), startedAt });
  store.insertDelegation({ id: "first", repoKey: "repo", sessionId: "session", role: "implement",
    title: "first", status: "running" });
  store.insertAssignment("first", { executor: "codex", model: "gpt", family: "openai", tier: "mid",
    reason: [], policyVersion: "1" });
  const staticDir = join(directory, "public");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "hello");
  writeFileSync(join(directory, "secret"), "private content");
  let server;
  try {
    server = await startHttpServer({ port: 0, openStores: new Map([["repo", store]]),
      listRepos: () => [{ key: "repo", rootPath: directory, name: "repo" }], staticDir });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  const graph = await (await fetch(`${base}/api/graph?repo=repo&session=session`)).json();
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, [{ from: "session", to: "first", fromFamily: "anthropic", toFamily: "openai" }]);
  assert.equal((await fetch(`${base}/`)).status, 200);
  for (const path of ["/%2e%2e%2fsecret", "/../secret"]) {
    const result = await getRawPath(address.port, path);
    assert.equal(result.status, 403);
    assert.doesNotMatch(result.body, /private content/);
  }

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/events?repo=repo`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const firstChunk = await reader.read();
  const snapshot = new TextDecoder().decode(firstChunk.value);
  assert.match(snapshot, /event: snapshot/);
  let state = applySnapshot({ nodes: [], edges: [] }, JSON.parse(snapshot.split("data: ")[1]));
  const began = performance.now();
  store.insertDelegation({ id: "second", repoKey: "repo", sessionId: "session", parentId: "first",
    role: "review", title: "second", status: "running" });
  const next = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 2000)),
  ]);
  const message = new TextDecoder().decode(next.value);
  assert.match(message, /event: delegation/);
  const change = JSON.parse(message.split("data: ")[1]);
  assert.equal(change.node.id, "second");
  assert.equal(change.edge.from, "first");
  assert.equal(change.nodes, undefined);
  state = applyDelegation(state, change);
  assert.equal(state.nodes.find((node) => node.id === "second")?.status, "running");
  store.insertAssignment("second", { executor: "claude", model: "haiku", family: "anthropic", tier: "low", reason: [], policyVersion: "1" });
  const assigned = await reader.read();
  state = applyDelegation(state, JSON.parse(new TextDecoder().decode(assigned.value).split("data: ")[1]));
  assert.equal(state.edges.find((edge) => edge.to === "second")?.toFamily, "anthropic");
  assert.ok(performance.now() - began < 2000);
  controller.abort();
});

test("SSE 差分を画面のモデルで反映し、新規の根・双方向・辺だけの変更を保持する", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "repo", rootPath: "/repo", name: "repo" });
  let previous = buildGraph(store.db);
  let state = applySnapshot({ nodes: [], edges: [] }, previous);
  const sync = () => {
    const next = buildGraph(store.db);
    const changes = diffGraph(previous, next);
    for (const change of changes) state = applyDelegation(state, change);
    assert.deepEqual(state, applySnapshot({ nodes: [], edges: [] }, next));
    previous = next;
    return changes;
  };
  for (const [client, executor, family] of [["claude", "codex", "openai"], ["codex", "claude", "anthropic"]] as const) {
    store.insertSession({ id: client, repoKey: "repo", name: client, client,
      traceId: "a".repeat(32), startedAt });
    assert.equal(sync()[0].node.id, client);
    store.insertDelegation({ id: `${client}-child`, repoKey: "repo", sessionId: client,
      role: "document", title: "child", status: "requested" });
    const added = sync();
    assert.equal(added.length, 1);
    assert.equal(added[0].edge?.from, client);
    store.insertAssignment(`${client}-child`, { executor, family, model: "cheap", tier: "low", reason: [], policyVersion: "1" });
    assert.equal(sync()[0].edge?.toFamily, family);
    store.finishDelegation(`${client}-child`, "done");
    assert.equal(sync()[0].node.status, "done");
  }
  assert.ok(state.edges.some((edge) => edge.fromFamily === "openai" && edge.toFamily === "anthropic"));
  assert.ok(state.edges.some((edge) => edge.fromFamily === "anthropic" && edge.toFamily === "openai"));
  store.updateSessionClient("claude", "codex");
  const changes = sync();
  assert.equal(changes.length, 2);
  assert.equal(changes.find((change) => change.edge)?.edge?.fromFamily, "openai");
  assert.deepEqual(sync(), []);
});

test("planner の根と辺はモデル系統を持たない", (t) => {
  const store = openStore(":memory:"); t.after(() => store.close());
  store.upsertRepo({ key: "repo", rootPath: "/repo", name: "repo" });
  store.insertSession({ id: "planner", repoKey: "repo", name: "planner", client: "planner", traceId: "a".repeat(32), startedAt });
  store.insertDelegation({ id: "child", repoKey: "repo", sessionId: "planner", role: "implement", title: "child", status: "done" });
  const graph = buildGraph(store.db);
  assert.equal(graph.nodes[0].executor, "planner");
  assert.equal(graph.nodes[0].family, null);
  assert.equal(graph.edges[0].fromFamily, null);
});
