import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Fact, FactInput } from "../../src/ledger/facts.ts";
import { applyIncremental, openLedger, PROJECTION_TABLES, rebuild } from "../../src/ledger/index.ts";
import { projectDelegations } from "../../src/ledger/projections/delegations.ts";
import { projectConversations } from "../../src/ledger/projections/conversations.ts";
import { repoKey } from "../../src/paths.ts";

const TS = "2026-10-07T00:00:00Z";
let order = 0;
function fact(input: FactInput): Fact {
  order += 1;
  return { ...input, seq: order, fact_id: `${input.source}:${input.source_event_id}`, payload_hash: "hash", observed_ts: TS,
    schema_version: 1, cursor: null, supersedes: null } as Fact;
}
const project = (id: string, root: string, prefix = root.split("/").at(-1)!): FactInput => ({ source: "legacy", source_event_id: `project:${id}`,
  kind: "project.created", subject: `project:${id}`, source_ts: "1970-01-01T00:00:00.000Z", confidence: "confirmed",
  payload: { repository_id: id, root_path: root, display_name: prefix, name_prefix: prefix, state: "registered" } });
const delegation = (id: string, extra: Record<string, unknown> = {}): FactInput => ({ source: "intake", source_event_id: `delegation:${id}`,
  kind: "delegation.created", subject: `delegation:${id}`, source_ts: TS, confidence: "confirmed",
  payload: { request_id: id, role: "implement", title: id, attempt: 0, state: "received", ...extra } as never });
const PROJECTS = [project("alpha-id", "/work/alpha"), project("beta-id", "/work/beta"), project("nested-id", "/work/alpha/packages/nested")];

test("委譲は試行の実行のリポジトリでプロジェクトに結び、実行が無ければ依頼の場所で結ぶ", () => {
  const facts = [...PROJECTS, delegation("by-run", { cwd: "/work/beta" }),
    { source: "intake", source_event_id: "attempt", kind: "delegation.attempt_created", subject: "delegation:by-run", source_ts: TS,
      confidence: "confirmed", payload: { attempt: 1, run_id: "run-1", assignment: { executor: "codex", model: "gpt-test" } } } as FactInput,
    { source: "host-codex", source_event_id: "run", kind: "run.created", subject: "run:run-1", source_ts: TS, confidence: "confirmed",
      payload: { conversation_id: "child", generation: 1, state: "running", repository_id: "alpha-id" } } as FactInput,
    delegation("by-cwd", { cwd: "/work/alpha/packages/nested/src" }),
    delegation("by-worktree", { cwd: `/home/me/.cache/agent-graph/worktrees/${repoKey("/work/beta")}/session/S1` }),
    delegation("outside", { cwd: "/elsewhere" }),
  ].map(fact);
  const byId = new Map(projectDelegations(facts).map((row) => [row.id, row]));
  // 試行の実行は依頼の場所より優先する。モデルと実行者は最後の割り当てから取る。
  assert.equal(byId.get("by-run")?.repository_id, "alpha-id");
  assert.deepEqual([byId.get("by-run")?.provider, byId.get("by-run")?.model], ["codex", "gpt-test"]);
  // 入れ子のプロジェクトは最も深い本体の場所に結ぶ。
  assert.equal(byId.get("by-cwd")?.repository_id, "nested-id");
  // planner の作業ツリーは <cache>/agent-graph/worktrees/<repoKey>/ にあり、その鍵で本体に結ぶ。
  assert.equal(byId.get("by-worktree")?.repository_id, "beta-id");
  assert.equal(byId.get("outside")?.repository_id, undefined);
});

test("キットの委譲は記録のファイルの場所で結び、無ければ会話名の前置きで結ぶ。旧い委譲は親の実行で結ぶ", () => {
  const facts = [...PROJECTS,
    { source: "kit", source_event_id: "kit-file", kind: "delegation.created", subject: "delegation:kit-file", source_ts: TS, confidence: "confirmed",
      payload: { request_id: "kit-file", role: "implement", title: "t", attempt: 1, state: "running",
        kit: { file: "/work/beta/.agents/state/events.jsonl", session: "alpha-3", model: "gpt-kit" } } } as FactInput,
    { source: "kit", source_event_id: "kit-session", kind: "delegation.created", subject: "delegation:kit-session", source_ts: TS, confidence: "unknown",
      payload: { request_id: "kit-session", role: "implement", title: "t", attempt: 1, state: "failed", kit: { session: "alpha-12" } } } as FactInput,
    { source: "legacy", source_event_id: "parent-run", kind: "run.created", subject: "run:legacy-parent", source_ts: TS, confidence: "confirmed",
      payload: { conversation_id: "legacy-conversation", generation: 0, state: "starting", repository_id: "beta-id" } } as FactInput,
    delegation("legacy", { parent_run_id: "legacy-parent" }),
  ].map(fact);
  const byId = new Map(projectDelegations(facts).map((row) => [row.id, row]));
  assert.equal(byId.get("kit-file")?.repository_id, "beta-id");
  assert.deepEqual([byId.get("kit-file")?.provider, byId.get("kit-file")?.model], ["codex", "gpt-kit"]);
  assert.equal(byId.get("kit-session")?.repository_id, "alpha-id");
  assert.equal(byId.get("legacy")?.repository_id, "beta-id");
});

test("観測した会話の場所の事実は、会話の投影に場所とリポジトリとして残る", () => {
  const facts = [
    { source: "transcript-claude", source_event_id: "c", kind: "conversation.created", subject: 'conversation:["claude","s"]', source_ts: TS,
      confidence: "confirmed", payload: { provider: "claude", native_id: "s", origin: "observed", type: "interactive", history_format: "jsonl" } } as FactInput,
    { source: "transcript-claude", source_event_id: 'conversation:["claude","s"]:location', kind: "conversation.updated", subject: 'conversation:["claude","s"]',
      source_ts: TS, confidence: "confirmed", payload: { cwd: "/work/alpha-feature", repository_id: "alpha-id" } } as FactInput,
  ].map(fact);
  const [conversation] = projectConversations(facts).conversations;
  assert.equal(conversation.cwd, "/work/alpha-feature");
  assert.equal(conversation.repository_id, "alpha-id");
});

function openTestLedger(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ledger-links-"));
  const path = join(directory, "ledger.sqlite");
  const writer = openLedger(path);
  const database = new DatabaseSync(path);
  t.after(() => { database.close(); writer.close(); rmSync(directory, { recursive: true }); });
  return { writer, database };
}
function readTables(database: DatabaseSync) {
  return Object.fromEntries(PROJECTION_TABLES.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }))]));
}

test("後から登録したプロジェクトも、差分反映と再構築で同じ結び付きを委譲に付ける", (t) => {
  const { writer, database } = openTestLedger(t);
  writer.append(delegation("late", { cwd: "/work/alpha/src" }));
  writer.append({ ...delegation("other", { cwd: "/elsewhere" }), source_event_id: "delegation:other" });
  let state = rebuild(database);
  assert.equal(database.prepare("SELECT repository_id FROM delegations WHERE id = 'late'").get()!.repository_id, null);
  writer.append(PROJECTS[0]);
  state = applyIncremental(database, state.last_seq);
  assert.equal(database.prepare("SELECT repository_id FROM delegations WHERE id = 'late'").get()!.repository_id, "alpha-id");
  const incremental = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), incremental);
  // 委譲の試行の列は正しい JSON で保存する。
  for (const row of database.prepare("SELECT attempts FROM delegations").all()) assert.doesNotThrow(() => JSON.parse(String(row.attempts)));
});
