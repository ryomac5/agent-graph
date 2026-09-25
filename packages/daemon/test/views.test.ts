import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, type Store } from "../../core/src/store/store.ts";
import type { Overview, ProjectView } from "../src/http/contract.ts";
import { startHttpServer } from "../src/http/server.ts";
import { buildOverview, buildProjectView, buildUsage, summarize, TURN_LIMIT } from "../src/http/views.ts";

const ts = "2026-09-25T00:00:00.000Z";
const later = "2026-09-25T01:00:00.000Z";
const now = new Date("2026-09-25T02:00:00.000Z");
const trace = "a".repeat(32);

function withStore(t: { after: (fn: () => void) => void }): Store {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: "/work/repo", name: "repo" });
  return store;
}

function event(store: Store, kind: string, at: string, payload: Record<string, unknown>, session = "s1"): void {
  store.appendEvent({ id: `${kind}-${at}-${Math.random()}`, ts: at, kind: kind as never, repo: "r", session,
    trace: { traceId: trace, spanId: "b".repeat(16) }, payload: payload as never });
}

function project(store: Store): ProjectView {
  const view = buildProjectView(store, "r", now);
  assert.ok(view);
  return view;
}

test("SessionView はセッションの状態と直近 50 件の turn を持つ", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts, model: "opus" });
  store.insertSession({ id: "s2", repoKey: "r", name: "repo-002", client: "codex", traceId: trace, startedAt: ts });
  store.insertSession({ id: "p1", repoKey: "r", name: "p1", client: "planner", traceId: trace, startedAt: later });
  store.setSessionGoalIfEmpty("s1", "契約を固定する");
  store.setSessionWaiting("s1", "permission", later);
  store.endSession("s2", later);
  for (let index = 0; index < TURN_LIMIT + 5; index++) {
    store.insertTurn({ id: `t${index}`, sessionId: "s1", at: `2026-09-25T00:${String(index).padStart(2, "0")}:00.000Z`, prompt: `p${index}` });
  }
  store.setTurnHidden("t54", true);
  const view = project(store);
  assert.deepEqual(view.project, { key: "r", name: "repo", rootPath: "/work/repo" });
  assert.equal(view.updatedAt, now.toISOString());
  const [first, second, planner] = view.sessions;
  assert.equal(first.id, "s1");
  assert.equal(first.name, "repo-001");
  assert.equal(first.client, "claude");
  assert.equal(first.status, "waiting");
  assert.equal(first.waitingReason, "permission");
  assert.equal(first.startedAt, ts);
  assert.equal(first.endedAt, undefined);
  assert.equal(first.goal, "契約を固定する");
  assert.equal(first.model, "opus");
  assert.equal(first.turns.length, TURN_LIMIT);
  assert.equal(first.turns[0].id, "t5");
  assert.deepEqual(first.turns.at(-1), { id: "t54", at: "2026-09-25T00:54:00.000Z", prompt: "p54", hidden: true });
  assert.deepEqual(first.nodes, [{ id: "s1", kind: "root", title: "repo-001", role: "root", status: "waiting",
    executor: "claude", startedAt: ts, family: "anthropic", model: "opus", task: "契約を固定する" }]);
  assert.deepEqual(first.edges, []);
  assert.equal(second.status, "ended");
  assert.equal(second.endedAt, later);
  assert.equal(second.nodes[0].family, "openai");
  assert.equal(second.waitingReason, undefined);
  assert.equal(planner.client, "planner");
  assert.equal(planner.nodes[0].family, undefined);
});

test("委譲の NodeDetail は詳細の全項目を持ち、完了した委譲にだけ return の辺を引く", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "実装", status: "failed" });
  store.insertAssignment("d1", { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "high",
    reason: ["implement は codex", "利用枠に余裕"], policyVersion: "v1" });
  store.insertAcceptance("d1", { passed: true, results: [{ command: "npm test", exitCode: 0, output: "ok", durationMs: 5 }], scopeViolations: [] });
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", parentId: "d1", role: "review", title: "Review: 実装", status: "done" });
  store.insertAssignment("d2", { executor: "claude", model: "fable", family: "anthropic", tier: "high", reason: [], policyVersion: "v1" });
  store.insertReview("d1", "d2", "request_changes", "テストが足りない\n二行目\nVERDICT: request_changes");
  store.insertTokenUsage("d1", { inputTokens: 10, outputTokens: 5 }, "gpt-6-sol");
  store.db.prepare("UPDATE delegations SET round_trips = 1 WHERE id = 'd1'").run();
  event(store, "delegation.requested", ts, { delegationId: "d1", task: "実装して" });
  event(store, "delegation.finished", later, { delegationId: "d1", status: "failed" });
  event(store, "delegation.requested", ts, { delegationId: "d2", task: "レビューして" });
  event(store, "delegation.finished", later, { delegationId: "d2", status: "done" });
  store.insertDelegation({ id: "d3", repoKey: "r", sessionId: "s1", role: "research", title: "調査", status: "requested", kind: "subagent" });
  store.insertDelegation({ id: "d4", repoKey: "r", sessionId: "s1", role: "document", title: "却下", status: "denied" });

  const [session] = project(store).sessions;
  const byId = new Map(session.nodes.map((node) => [node.id, node]));
  assert.deepEqual([...byId.keys()], ["s1", "d1", "d2", "d3", "d4"]);
  const first = byId.get("d1")!;
  assert.equal(first.kind, "delegation");
  assert.equal(first.status, "failed");
  assert.equal(first.parentId, "s1");
  assert.equal(first.executor, "codex");
  assert.equal(first.model, "gpt-6-sol");
  assert.equal(first.family, "openai");
  assert.equal(first.startedAt, ts);
  assert.equal(first.endedAt, later);
  assert.equal(first.roundTrips, 1);
  assert.equal(first.task, "実装して");
  assert.equal(first.output, undefined);
  assert.equal(first.feedback, "レビューの修正依頼:\nテストが足りない\n二行目\nVERDICT: request_changes");
  assert.deepEqual(first.acceptance, { passed: true, results: [{ command: "npm test", exitCode: 0, output: "ok", durationMs: 5 }], scopeViolations: [] });
  assert.deepEqual(first.review, { verdict: "request_changes", comment: "テストが足りない\n二行目\nVERDICT: request_changes",
    reviewer: { executor: "claude", model: "fable" } });
  assert.deepEqual(first.tokens, { input: 10, output: 5 });
  assert.deepEqual(first.assignment, { reason: ["implement は codex", "利用枠に余裕"], policyVersion: "v1" });
  assert.deepEqual(first.rounds, [{ kind: "request", text: "実装して", at: ts }]);
  const reviewer = byId.get("d2")!;
  assert.equal(reviewer.parentId, "d1");
  assert.equal(reviewer.output, "テストが足りない\n二行目\nVERDICT: request_changes");
  assert.deepEqual(reviewer.rounds, [{ kind: "request", text: "レビューして", at: ts },
    { kind: "report", text: "テストが足りない\n二行目\nVERDICT: request_changes", at: later }]);
  assert.equal(byId.get("d3")!.kind, "subagent");
  assert.equal(byId.get("d3")!.status, "planned");
  assert.equal(byId.get("d4")!.status, "denied");

  assert.deepEqual(session.edges, [
    { id: "s1->d1", from: "s1", to: "d1", kind: "delegate", label: "実装", fromFamily: "anthropic", toFamily: "openai" },
    { id: "d1->s1#return", from: "d1", to: "s1", kind: "return", fromFamily: "openai", toFamily: "anthropic" },
    { id: "d1->d2", from: "d1", to: "d2", kind: "delegate", label: "Review: 実装", fromFamily: "openai", toFamily: "anthropic" },
    { id: "d2->d1#return", from: "d2", to: "d1", kind: "return", label: "テストが足りない", fromFamily: "anthropic", toFamily: "openai" },
    { id: "s1->d3", from: "s1", to: "d3", kind: "delegate", label: "調査", fromFamily: "anthropic" },
    { id: "s1->d4", from: "s1", to: "d4", kind: "delegate", label: "却下", fromFamily: "anthropic" },
  ]);
});

test("受け入れ失敗の feedback と return の label は 80 字で切る", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "codex", traceId: trace, startedAt: ts });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "実装", status: "done" });
  store.insertAcceptance("d1", { passed: false, results: [{ command: "npm test", exitCode: 1, output: "x", durationMs: 5 },
    { command: "lint", exitCode: 0, output: "", durationMs: 1 }], scopeViolations: ["README.md"] });
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", parentId: "d1", role: "review", title: "Review", status: "done" });
  store.insertReview("d1", "d2", "approve", `${"あ".repeat(100)}\nVERDICT: approve`);
  const [session] = project(store).sessions;
  assert.equal(session.nodes[1].feedback, "受け入れ失敗\nexit 1: npm test\nscope 外: README.md");
  const back = session.edges.find((edge) => edge.id === "d2->d1#return")!;
  assert.equal(back.label!.length, 80);
  assert.ok(back.label!.endsWith("…"));
});

test("GraphView は planner のタスクと依存の辺を持ち、委譲の結果で NodeDetail を埋める", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "p1", repoKey: "r", name: "agent-graph-001-s10", client: "planner", traceId: trace, startedAt: ts });
  const graph = { id: "g1", repoKey: "r", sessionId: "p1", goal: "作り直す", fingerprint: "f", createdAt: ts };
  store.insertGraph(graph, [
    { graphId: "g1", id: "A", title: "土台", role: "implement", dependsOn: [], state: "done", attempts: 1 },
    { graphId: "g1", id: "B", title: "画面", role: "document", dependsOn: ["A"], state: "reviewing", attempts: 2 },
    { graphId: "g1", id: "G", title: "確認", role: "human", dependsOn: ["A", "B"], state: "waiting_human", attempts: 0 },
    { graphId: "g1", id: "PR", title: "PR", role: "pr", dependsOn: ["G"], state: "done", attempts: 1 },
  ]);
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "p1", role: "implement", title: "土台", status: "done" });
  store.insertAssignment("d1", { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "high", reason: ["r"], policyVersion: "v1" });
  store.insertAcceptance("d1", { passed: true, results: [], scopeViolations: [] });
  store.insertTokenUsage("d1", { inputTokens: 3, outputTokens: 4 }, "gpt-6-sol");
  store.db.prepare("UPDATE delegations SET task_id = 'A' WHERE id = 'd1'").run();
  event(store, "delegation.requested", ts, { delegationId: "d1", task: "土台を作る" }, "p1");
  event(store, "delegation.finished", later, { delegationId: "d1", status: "done" }, "p1");
  store.appendGraphEvent(graph, "task.result", { taskId: "A", delegationId: "d1", status: "done", output: "土台の報告\n詳細" });
  store.appendGraphEvent(graph, "task.integrated", { taskId: "A", conflict: false, files: ["a.ts", "b.ts", "c.ts", "d.ts"] });
  store.appendGraphEvent(graph, "task.failed", { taskId: "B", reason: "統合範囲外のコミット" });
  store.appendGraphEvent(graph, "pr.created", { taskId: "PR", output: "Creating pull request\nhttps://github.com/x/y/pull/12\n" });

  const [view] = project(store).graphs;
  assert.equal(view.id, "g1");
  assert.equal(view.sessionId, "p1");
  assert.equal(view.goal, "作り直す");
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const a = byId.get("A")!;
  assert.equal(a.kind, "task");
  assert.equal(a.status, "done");
  assert.equal(a.attempts, 1);
  assert.deepEqual(a.dependsOn, []);
  assert.equal(a.executor, "codex");
  assert.equal(a.family, "openai");
  assert.equal(a.task, "土台を作る");
  assert.equal(a.output, "土台の報告\n詳細");
  assert.equal(a.branch, "agent-graph/p1-g1/A");
  assert.deepEqual(a.tokens, { input: 3, output: 4 });
  assert.deepEqual(a.rounds, [{ kind: "request", text: "土台を作る", at: ts }, { kind: "report", text: "土台の報告\n詳細", at: later }]);
  const b = byId.get("B")!;
  assert.equal(b.status, "running");
  assert.equal(b.feedback, "統合範囲外のコミット");
  assert.equal(b.executor, undefined);
  assert.equal(byId.get("G")!.status, "waiting_human");
  assert.equal(byId.get("PR")!.prUrl, "https://github.com/x/y/pull/12");
  assert.deepEqual(view.edges, [
    { id: "A->B", from: "A", to: "B", kind: "depends", label: "a.ts, b.ts, c.ts…" },
    { id: "A->G", from: "A", to: "G", kind: "depends", label: "a.ts, b.ts, c.ts…" },
    { id: "B->G", from: "B", to: "G", kind: "depends" },
    { id: "G->PR", from: "G", to: "PR", kind: "depends" },
  ]);
  // planner のセッション側にも委譲の node が出て、task の出力が return の辺の label になる
  const [session] = project(store).sessions;
  assert.equal(session.nodes[1].output, "土台の報告\n詳細");
  assert.equal(session.edges.find((edge) => edge.kind === "return")?.label, "土台の報告");
});

test("Usage は provider ごとの最新を人が読める名前で並べる", () => {
  const usage = buildUsage([
    { ts, provider: "openai", window: "10080m", percent: 12.6 },
    { ts: later, provider: "openai", window: "300m", percent: 7.2, resetsAt: later },
    { ts, provider: "anthropic", window: "7d", percent: 3, model: "Opus" },
    { ts, provider: "anthropic", window: "7d", percent: 30 },
    { ts, provider: "anthropic", window: "5h", percent: 42.4 },
  ]);
  assert.equal(usage.ts, later);
  assert.deepEqual(usage.windows, [
    { key: "anthropic:5h", label: "Claude 5h", provider: "anthropic", percent: 42 },
    { key: "anthropic:7d", label: "Claude Week", provider: "anthropic", percent: 30 },
    { key: "anthropic:7d:Opus", label: "Claude Week Opus", provider: "anthropic", percent: 3 },
    { key: "openai:300m", label: "Codex 5h", provider: "openai", percent: 7, resetsAt: later },
    { key: "openai:10080m", label: "Codex Week", provider: "openai", percent: 13 },
  ]);
  assert.deepEqual(buildUsage([{ ts, provider: "openai", window: "2880m", percent: 1 }]).windows[0].label, "Codex 2d");
  assert.deepEqual(buildUsage([]), { windows: [] });
});

test("ProjectSummary の status は waiting, failed, running, done の順で、生きたセッションが無ければ quiet か idle", (t) => {
  const store = withStore(t);
  const empty = buildOverview(new Map([["r", store]]), now);
  assert.deepEqual(empty.projects, [{ key: "r", name: "repo", rootPath: "/work/repo",
    counts: { running: 0, waiting: 0, failed: 0, done: 0 }, liveSessions: 0, status: "quiet" }]);
  assert.equal(empty.updatedAt, now.toISOString());
  store.insertSession({ id: "old", repoKey: "r", name: "repo-000", client: "claude", traceId: trace, startedAt: "2026-09-20T00:00:00.000Z" });
  store.endSession("old", "2026-09-20T01:00:00.000Z");
  assert.equal(buildOverview(new Map([["r", store]]), now).projects[0].status, "quiet");
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  const idle = buildOverview(new Map([["r", store]]), now).projects[0];
  assert.equal(idle.status, "idle");
  assert.equal(idle.liveSessions, 1);
  assert.equal(idle.lastActivityAt, ts);
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "a", status: "done" });
  assert.equal(buildOverview(new Map([["r", store]]), now).projects[0].status, "done");
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", role: "implement", title: "b", status: "running" });
  assert.equal(buildOverview(new Map([["r", store]]), now).projects[0].status, "running");
  store.insertDelegation({ id: "d3", repoKey: "r", sessionId: "s1", role: "implement", title: "c", status: "timeout" });
  assert.equal(buildOverview(new Map([["r", store]]), now).projects[0].status, "failed");
  store.setSessionWaiting("s1", "question", later);
  const waiting = buildOverview(new Map([["r", store]]), now).projects[0];
  assert.equal(waiting.status, "waiting");
  assert.deepEqual(waiting.counts, { running: 1, waiting: 1, failed: 1, done: 1 });
  // 終了したセッションの委譲は数えない。planner のタスクは生きたセッションのものだけ数える
  store.endSession("s1", later);
  assert.equal(buildOverview(new Map([["r", store]]), now).projects[0].status, "idle");
  store.insertSession({ id: "p1", repoKey: "r", name: "p1", client: "planner", traceId: trace, startedAt: ts });
  store.insertGraph({ id: "g1", repoKey: "r", sessionId: "p1", goal: "g", fingerprint: "f", createdAt: ts },
    [{ graphId: "g1", id: "A", title: "a", role: "human", dependsOn: [], state: "conflict", attempts: 0 }]);
  const conflict = buildOverview(new Map([["r", store]]), now).projects[0];
  assert.equal(conflict.status, "waiting");
  assert.deepEqual(conflict.counts, { running: 0, waiting: 1, failed: 0, done: 0 });
  assert.equal(summarize(project(store), undefined, now).status, "waiting");
});

test("Overview は store をまたいで並べ、利用枠は最新を選ぶ", (t) => {
  const first = withStore(t);
  const second = openStore(":memory:");
  t.after(() => second.close());
  second.upsertRepo({ key: "b", rootPath: "/work/b", name: "b" });
  first.appendUsageSample({ ts, provider: "openai", window: "300m", percent: 10 });
  second.appendUsageSample({ ts: later, provider: "openai", window: "300m", percent: 20 });
  second.appendUsageSample({ ts, provider: "anthropic", window: "5h", percent: 5 });
  const overview: Overview = buildOverview(new Map([["r", first], ["b", second]]), now);
  assert.deepEqual(overview.projects.map((item) => item.key), ["b", "r"]);
  assert.deepEqual(overview.usage.windows.map((window) => [window.key, window.percent]), [["anthropic:5h", 5], ["openai:300m", 20]]);
  assert.equal(overview.usage.ts, later);
});

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<{ event: string; data: unknown }> {
  let buffer = "";
  const deadline = setTimeout(() => { void reader.cancel(); }, timeoutMs);
  try {
    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (block.startsWith(":")) continue;
        const event = block.match(/^event: (.*)$/m)?.[1] ?? "";
        const data = block.match(/^data: (.*)$/m)?.[1] ?? "null";
        return { event, data: JSON.parse(data) };
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended");
      buffer += new TextDecoder().decode(chunk.value);
    }
  } finally { clearTimeout(deadline); }
}

test("SSE は project と overview の全体を送り、変化から 1 秒以内に届く", async (t) => {
  const store = withStore(t);
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-views-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  const stores = new Map([["r", store]]);
  let server;
  try {
    server = await startHttpServer({ port: 0, openStores: stores, listRepos: () => [], tokenPath: join(directory, "dashboard.token") });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const overview = await fetch(`${base}/api/overview`);
  assert.equal(overview.status, 200);
  assert.equal(((await overview.json()) as Overview).projects[0].key, "r");
  const projectResponse = await fetch(`${base}/api/project?repo=r`);
  assert.equal(projectResponse.status, 200);
  assert.equal(((await projectResponse.json()) as ProjectView).sessions[0].name, "repo-001");
  assert.equal((await fetch(`${base}/api/project`)).status, 400);
  assert.equal((await fetch(`${base}/api/project?repo=missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/events?repo=missing`)).status, 404);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const projectStream = await fetch(`${base}/api/events?repo=r`, { signal: controller.signal });
  assert.equal(projectStream.status, 200);
  assert.match(projectStream.headers.get("content-type") ?? "", /text\/event-stream/);
  const projectReader = projectStream.body!.getReader();
  const overviewReader = (await fetch(`${base}/api/events`, { signal: controller.signal })).body!.getReader();
  const initial = await readEvent(projectReader, 2000);
  assert.equal(initial.event, "project");
  assert.equal((initial.data as ProjectView).sessions[0].nodes.length, 1);
  const initialOverview = await readEvent(overviewReader, 2000);
  assert.equal(initialOverview.event, "overview");
  assert.equal((initialOverview.data as Overview).projects[0].status, "idle");

  const began = performance.now();
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "実装", status: "running" });
  store.insertAssignment("d1", { executor: "codex", model: "gpt", family: "openai", tier: "mid", reason: [], policyVersion: "1" });
  const changed = await readEvent(projectReader, 1000);
  assert.ok(performance.now() - began < 1000);
  assert.equal(changed.event, "project");
  const view = changed.data as ProjectView;
  // 連続した変化は最後の状態だけ届く
  assert.equal(view.sessions[0].nodes[1].model, "gpt");
  assert.equal(view.sessions[0].edges[0].toFamily, "openai");
  const changedOverview = await readEvent(overviewReader, 1000);
  assert.equal(changedOverview.event, "overview");
  assert.equal((changedOverview.data as Overview).projects[0].status, "running");
  controller.abort();
});

test("NodeDetail は delegations の列と delegation_rounds から task, output, scope, outputs, worktree, rounds を埋める", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "実装", status: "requested",
    task: "実装して", scope: ["src/**"], outputs: ["docs/x.md"], worktree: "/work/tree" });
  store.insertDelegationRound("d1", "request", "実装して", ts);
  store.insertDelegationRound("d1", "report", "一度目の報告", later);
  store.insertDelegationRound("d1", "reinstruct", "前回の結果を踏まえて修正してください。\n受け入れ失敗", later);
  store.insertDelegationRound("d1", "report", "二度目の報告", "2026-09-25T02:00:00.000Z");
  store.finishDelegation("d1", "done", "二度目の報告");
  // events の依頼文は列があるときは使わない
  event(store, "delegation.requested", ts, { delegationId: "d1", task: "events の依頼文" });
  event(store, "delegation.finished", later, { delegationId: "d1", status: "done" });
  // 列の無い古い記録は events と reviews から従来どおり組む
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", parentId: "d1", role: "review", title: "Review", status: "done" });
  store.insertReview("d1", "d2", "approve", "VERDICT: approve");
  event(store, "delegation.requested", ts, { delegationId: "d2", task: "レビューして" });
  event(store, "delegation.finished", later, { delegationId: "d2", status: "done" });

  const [session] = project(store).sessions;
  const byId = new Map(session.nodes.map((node) => [node.id, node]));
  const first = byId.get("d1")!;
  assert.equal(first.task, "実装して");
  assert.equal(first.output, "二度目の報告");
  assert.deepEqual(first.scope, ["src/**"]);
  assert.deepEqual(first.outputs, ["docs/x.md"]);
  assert.equal(first.worktree, "/work/tree");
  assert.deepEqual(first.rounds, [
    { kind: "request", text: "実装して", at: ts },
    { kind: "report", text: "一度目の報告", at: later },
    { kind: "reinstruct", text: "前回の結果を踏まえて修正してください。\n受け入れ失敗", at: later },
    { kind: "report", text: "二度目の報告", at: "2026-09-25T02:00:00.000Z" },
  ]);
  assert.equal(session.edges.find((edge) => edge.id === "d1->s1#return")?.label, "二度目の報告");
  const reviewer = byId.get("d2")!;
  assert.equal(reviewer.task, "レビューして");
  assert.equal(reviewer.output, "VERDICT: approve");
  assert.equal(reviewer.scope, undefined);
  assert.equal(reviewer.worktree, undefined);
  assert.deepEqual(reviewer.rounds, [{ kind: "request", text: "レビューして", at: ts }, { kind: "report", text: "VERDICT: approve", at: later }]);
});
