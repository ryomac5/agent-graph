import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../../core/src/store/store.ts";
import { buildGraph } from "../src/http/graph.ts";
import { startHttpServer } from "../src/http/server.ts";

const startedAt = "2026-09-25T00:00:00.000Z";

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
    { from: "session", to: "first", fromFamily: null, toFamily: "openai" },
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
  writeFileSync(join(directory, "index.html"), "hello");
  let server;
  try {
    server = await startHttpServer({ port: 0, openStores: new Map([["repo", store]]),
      listRepos: () => [{ key: "repo", rootPath: directory, name: "repo" }], staticDir: directory });
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
  assert.deepEqual(graph.edges, [{ from: "session", to: "first", fromFamily: null, toFamily: "openai" }]);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.notEqual((await fetch(`${base}/%2e%2e%2fsecret`)).status, 200);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/events?repo=repo`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const firstChunk = await reader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: snapshot/);
  const began = performance.now();
  store.insertDelegation({ id: "second", repoKey: "repo", sessionId: "session", parentId: "first",
    role: "review", title: "second", status: "running" });
  const next = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 2000)),
  ]);
  assert.match(new TextDecoder().decode(next.value), /event: delegation/);
  assert.ok(performance.now() - began < 2000);
  controller.abort();
});
