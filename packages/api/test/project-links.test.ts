import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createNativeId, openLedger, project, type FactInput, type Ledger } from "../../core/src/ledger/index.ts";
import { resolveProjectLocation } from "../../core/src/ledger/repository.ts";
import { observeClaudeFile } from "../src/observe/claude/index.ts";
import { claudeLocationEventId, observeClaudeContext } from "../src/observe/claude/context.ts";
import { observeCodexFile, observeCodexLocations } from "../src/observe/codex/index.ts";
import { createLocationResolver } from "../src/observe/location.ts";
import { createHookFacts } from "../src/hook/index.ts";
import { openObservationService } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";

const TS = "2026-10-07T01:00:00.000Z";
function createRepository(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-graph-links-")));
  const main = join(directory, "main");
  const worktree = join(directory, "feature");
  mkdirSync(main);
  execFileSync("git", ["init", "--quiet", main]);
  execFileSync("git", ["-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--allow-empty", "--quiet", "-m", "fixture"]);
  execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "--detach", worktree]);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, main, worktree, repositoryId: resolveProjectLocation(main, { temporaryRoots: [] }).repository_id };
}
function row(type: "user" | "assistant", uuid: string, timestamp: string, content: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type, uuid, timestamp, sessionId: "session", cwd: extra.cwd ?? "/repo", version: "2.1.291",
    message: { role: type, content, ...(type === "assistant" ? { model: "claude-test", stop_reason: extra.stop ?? "end_turn" } : {}) } }) + "\n";
}
function facts(ledger: Ledger) { return ledger.readSince(0, Number.MAX_SAFE_INTEGER); }
function observe(ledger: Ledger, path: string, locate = createLocationResolver()) {
  const observation = observeClaudeFile(ledger, path);
  return observeClaudeContext(ledger, path, { lines: observation.lines, fromStart: true, locate });
}

test("Claude の会話の記録から、作業ツリーの場所を本体のリポジトリに結び、ターンの根拠で状態を決める", (t) => {
  const { directory, worktree, repositoryId } = createRepository(t);
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const path = join(directory, "session.jsonl");
  writeFileSync(path, row("user", "u1", "2026-10-07T01:00:00Z", "Build it", { cwd: worktree })
    + row("assistant", "a1", "2026-10-07T01:00:05Z", [{ type: "tool_use", id: "t", name: "Bash", input: {} }], { cwd: worktree, stop: "tool_use" })
    + row("user", "u2", "2026-10-07T01:00:06Z", [{ type: "tool_result", tool_use_id: "t", content: "ok" }], { cwd: worktree }));
  observe(ledger, path);
  let view = project(facts(ledger));
  const id = createNativeId("claude", "session");
  const conversation = view.conversations.find((row) => row.id === id)!;
  assert.equal(conversation.cwd, worktree);
  assert.equal(conversation.repository_id, repositoryId);
  assert.equal(view.runs.length, 1);
  assert.equal(view.runs[0].state, "running");
  assert.equal(view.runs[0].last_evidence_ts, "2026-10-07T01:00:00Z");
  assert.equal(view.runs[0].repository_id, repositoryId);
  // 道具の呼び出しと結果はターンの途中なので、状態の事実を増やさない。
  assert.equal(facts(ledger).filter((fact) => fact.kind === "run.state_changed").length, 1);
  const cursor = observeClaudeFile(ledger, path).cursor;
  appendFileSync(path, row("assistant", "a2", "2026-10-07T01:01:00Z", [{ type: "text", text: "Done." }], { cwd: worktree }));
  // 続きの行だけを渡しても、直前の状態は台帳から引き継ぐ。
  const added = observeClaudeFile(ledger, path, { cursor });
  assert.equal(added.lines.length, 1);
  observeClaudeContext(ledger, path, { lines: added.lines, fromStart: false });
  view = project(facts(ledger));
  assert.equal(view.runs[0].state, "idle");
  assert.equal(view.runs[0].model, "claude-test");
  // 再読しても事実は増えない。
  const before = facts(ledger).length;
  observeClaudeContext(ledger, path, {});
  assert.equal(facts(ledger).length, before);
});

test("場所の事実がない既存の会話は一度だけ先頭から読み、中断の印で idle にし、時間からは終わりにしない", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-backfill-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const path = join(directory, "old.jsonl");
  writeFileSync(path, row("user", "u1", "2026-10-01T00:00:00Z", "Investigate") + row("user", "u2", "2026-10-01T00:01:00Z", "[Request interrupted by user]"));
  // 以前の観測は発言だけを取り込み、場所とターンの根拠を持たない。
  const old = observeClaudeFile(ledger, path);
  assert.ok(old.cursor.offset > 0);
  const result = observeClaudeContext(ledger, path, { lines: [], fromStart: false, locate: (cwd) => ({ cwd }) });
  assert.ok(result.appended > 0);
  const view = project(facts(ledger));
  assert.equal(view.runs[0].state, "idle");
  assert.equal(view.runs[0].ended_ts, undefined);
  assert.ok(facts(ledger).some((fact) => fact.source_event_id === claudeLocationEventId(createNativeId("claude", "old"))));
  assert.equal(observeClaudeContext(ledger, path, { lines: [], fromStart: false }).appended, 0);
});

test("hook の実行がある会話は、会話の記録の根拠を同じ世代の実行に結ぶ。管理する会話は場所だけを読む", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-hook-turns-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  for (const fact of createHookFacts({ version: 1, session_id: "hooked", generation: 5, event_id: "start", hook_event_name: "SessionStart",
    source_ts: "2026-10-07T00:59:00.000Z", input: { cwd: "/repo" }, managed: false }, (cwd) => ({ cwd, repository_id: "repo" }))) ledger.append(fact);
  const path = join(directory, "hooked.jsonl");
  writeFileSync(path, row("user", "u1", "2026-10-07T01:00:00Z", "Go") + row("user", "u2", "2026-10-07T01:00:01Z", "[Request interrupted by user]"));
  observe(ledger, path, createLocationResolver(() => ({ status: 1, stdout: "" })));
  const runs = project(facts(ledger)).runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].generation, 5);
  assert.equal(runs[0].state, "idle");
  assert.equal(runs[0].repository_id, "repo");
  const managed = join(directory, "managed.jsonl");
  ledger.append({ source: "host-claude", source_event_id: "managed", kind: "conversation.created", subject: "conversation:runner-1",
    source_ts: TS, confidence: "confirmed", payload: { provider: "claude", native_id: "managed", origin: "managed", type: "interactive", history_format: "jsonl" } });
  writeFileSync(managed, row("user", "m1", TS, "Managed"));
  const history = facts(ledger).filter((fact) => fact.subject === "conversation:runner-1");
  const scoped: Ledger = { ...ledger, readSince: () => history };
  observeClaudeContext(scoped, managed, { locate: (cwd) => ({ cwd }) });
  assert.ok(!facts(ledger).some((fact) => fact.source === "transcript-claude" && fact.kind.startsWith("run.") && JSON.stringify(fact.payload).includes("managed")));
  assert.ok(facts(ledger).some((fact) => fact.source_event_id === claudeLocationEventId(createNativeId("claude", "managed"))));
});

test("Codex の rollout のメタの場所で会話と実行を結び、ターンの設定のモデルを変わったときだけ記録する", (t) => {
  const { directory, worktree, repositoryId } = createRepository(t);
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const sessions = join(directory, "codex", "sessions");
  mkdirSync(sessions, { recursive: true });
  const id = "01a11651-17c5-7583-a946-0172ed2f1757";
  const path = join(sessions, `rollout-2026-10-07T01-00-00-${id}.jsonl`);
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  writeFileSync(path, line({ timestamp: TS, type: "session_meta", payload: { id, timestamp: TS, cwd: worktree, source: "cli", history_mode: "legacy" } })
    + line({ timestamp: TS, type: "turn_context", payload: { model: "gpt-test", effort: "high" } })
    + line({ timestamp: TS, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } })
    + line({ timestamp: "2026-10-07T01:00:01.000Z", type: "turn_context", payload: { model: "gpt-test", effort: "high" } })
    + line({ timestamp: "2026-10-07T01:00:02.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }));
  observeCodexFile(ledger, path, { codexHome: join(directory, "codex") });
  assert.equal(facts(ledger).filter((fact) => fact.kind === "run.updated" && (fact.payload as { model?: string })?.model).length, 1);
  observeCodexLocations(ledger, [path]);
  observeCodexLocations(ledger, [path]);
  const view = project(facts(ledger));
  const conversation = view.conversations.find((row) => row.id === createNativeId("codex", id))!;
  assert.equal(conversation.repository_id, repositoryId);
  assert.equal(conversation.cwd, worktree);
  assert.equal(view.runs[0].repository_id, repositoryId);
  assert.deepEqual([view.runs[0].state, view.runs[0].model, view.runs[0].effort], ["idle", "gpt-test", "high"]);
  assert.equal(facts(ledger).filter((fact) => fact.source_event_id.endsWith(":location")).length, 2);
});

test("取り込みは、変更のない既存の会話の記録にも一度だけ場所とターンの根拠を足す", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-links-service-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const projects = join(home, ".claude", "projects", "repo");
  mkdirSync(projects, { recursive: true });
  const path = join(projects, "existing.jsonl");
  writeFileSync(path, row("user", "e1", TS, "Existing request"));
  const env = { HOME: home, XDG_STATE_HOME: join(home, "state"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
  const dbPath = join(home, "state", "agent-graph", "agent-graph.db");
  mkdirSync(join(home, "state", "agent-graph"), { recursive: true });
  // 以前の版の取り込みと同じく、発言だけを台帳に入れて cursor を残す。
  const ledger = openLedger(dbPath);
  observeClaudeFile(ledger, path);
  ledger.close();
  const service = openObservationService({ env, home, dbPath });
  t.after(() => service.close());
  assert.equal(service.ingestOnce().appended, 3);
  assert.equal(service.ingestOnce().appended, 0);
  const view = project(openLedger(dbPath).readSince(0, Number.MAX_SAFE_INTEGER));
  assert.equal(view.runs[0].state, "running");
});

test("配信は会話と委譲を、場所から結んだ登録したプロジェクトに解決し、試行の要約を正しい JSON で配る", (t) => {
  const { directory, main, worktree, repositoryId } = createRepository(t);
  const service = openObservationService({ dbPath: join(directory, "ledger.db") });
  const append = (input: FactInput) => service.ledger.append(input);
  append({ source: "ui", source_event_id: "project", kind: "project.created", subject: `project:${repositoryId}`, source_ts: TS, confidence: "confirmed",
    payload: { repository_id: repositoryId, root_path: main, display_name: "main", name_prefix: "main", state: "registered" } });
  const conversation = createNativeId("claude", "external");
  append({ source: "transcript-claude", source_event_id: "conversation", kind: "conversation.created", subject: `conversation:${conversation}`, source_ts: TS,
    confidence: "confirmed", payload: { provider: "claude", native_id: "external", origin: "observed", type: "interactive", history_format: "jsonl" } });
  append({ source: "transcript-claude", source_event_id: claudeLocationEventId(conversation), kind: "conversation.updated", subject: `conversation:${conversation}`,
    source_ts: TS, confidence: "confirmed", payload: { cwd: worktree, repository_id: repositoryId } });
  append({ source: "intake", source_event_id: "delegation", kind: "delegation.created", subject: "delegation:d1", source_ts: TS, confidence: "confirmed",
    payload: { request_id: "d1", role: "implement", title: "Implement", task: "Do", cwd: join(worktree, "src"), attempt: 0, state: "received",
      origin: { provider: "claude", native_id: "external" } } });
  append({ source: "intake", source_event_id: "attempt", kind: "delegation.attempt_created", subject: "delegation:d1", source_ts: TS, confidence: "confirmed",
    payload: { attempt: 1, assignment: { executor: "codex", model: "gpt-test", reason: ["fixture"] }, verification: { output: "x".repeat(5000) } } });
  const feed = new ProjectionFeed(service.dbPath, service.catchUp);
  t.after(() => { feed.close(); service.close(); });
  const snapshot = feed.snapshot().projection;
  assert.equal(snapshot.conversations.find((row) => row.id === conversation)!.project, repositoryId);
  const delegation = snapshot.delegations.find((row) => row.id === "d1")!;
  assert.equal(delegation.project, repositoryId);
  assert.deepEqual([delegation.provider, delegation.model], ["codex", "gpt-test"]);
  assert.deepEqual(JSON.parse(String(delegation.attempts)), [
    { attempt: 0, state: "received", run_id: null, assignment: { model: null, effort: null, executor: null, provider: null } },
    { attempt: 1, state: null, run_id: null, assignment: { model: "gpt-test", effort: null, executor: "codex", provider: null } }]);
  assert.equal(JSON.parse(String(delegation.parent)).confidence, "confirmed");
  assert.ok(!JSON.stringify(delegation).includes("x".repeat(100)));
});
