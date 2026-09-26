import type { Role, Tier } from "../../core/src/delegate/types.ts";
import type { Event } from "../../core/src/events.ts";
import type { Store } from "../../core/src/store/store.ts";
import { newSpanId } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";
import { observe as ingest, observers as turnObservers, summarize, type Observer } from "./sessions.ts";

// Claude Code のネイティブのサブエージェントの観測。hook の PreToolUse, PostToolUse, SubagentStart, SubagentStop から届く。
// 行は delegations の kind subagent。往復は events に subagent.* で積む。
//   delegation.requested   { delegationId, task }                        request の往復
//   subagent.dispatched    { delegationId, toolUseId, agentType, name?, parentAgentId? }
//   subagent.started       { delegationId, agentId, agentType }          最後の値が束縛。agentId が空なら未束縛に戻す
//   subagent.reinstructed  { delegationId, agentId, toolUseId, text }   reinstruct の往復
//   subagent.reported      { delegationId, agentId?, output, summary }  report の往復
//   delegation.finished    { delegationId, status: "done" | "failed" }
const TASK_LIMIT = 20_000;
const REPORT_LIMIT = 20_000;
const MESSAGE_LIMIT = 20_000;
const TITLE_LIMIT = 200;
const AGENT_TYPE_LIMIT = 100;
const TASK_MATCH_PREFIX = 200;
const DEFAULT_AGENT_TYPE = "general-purpose";

interface SessionRef { id: string; repoKey: string; traceId: string; model?: string }

interface SubagentRow {
  id: string;
  status: string;
  task: string;
  toolUseId?: string;
  agentType: string;
  name?: string;
  agentId?: string;
  lastReport?: string;
}

interface SubagentIndex {
  rows: SubagentRow[];
  reinstructToolUseIds: Set<string>;
}

function optionalString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

// 役割は subagent_type を優先し、無ければ description の語から推定する。
export function inferRole(description: string, agentType: string): Role {
  const type = agentType.toLowerCase();
  if (/review/.test(type)) return "review";
  if (/^doc-|document/.test(type)) return "document";
  if (/explore|plan|research|guide/.test(type)) return "research";
  const text = description.toLowerCase();
  if (/review|レビュー|verdict|査読/.test(text)) return "review";
  if (/research|investigat|explore|search|analy|survey|調査|探索|確認|調べ|検索|分析|計画|把握/.test(text)) return "research";
  if (/\bdocs?\b|document|readme|guide|文書|ドキュメント|説明書|手順書|解説/.test(text)) return "document";
  return "implement";
}

export function tierOf(model: string): Tier {
  const name = model.toLowerCase();
  if (/opus|fable/.test(name)) return "high";
  if (/haiku/.test(name)) return "low";
  return "mid";
}

// 委譲文の突き合わせ。前後の空白を除いた完全一致か、先頭 200 字の一致。
export function sameTask(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  return left === right || left.slice(0, TASK_MATCH_PREFIX) === right.slice(0, TASK_MATCH_PREFIX);
}

function findSession(store: Store, id: string): SessionRef {
  const row = store.db.prepare("SELECT id, repo_key, trace_id, model FROM sessions WHERE id = ?").get(id);
  if (!row) throw new Error(`Session not found: ${id}`);
  return { id: String(row.id), repoKey: String(row.repo_key), traceId: String(row.trace_id),
    ...(row.model === null || row.model === undefined ? {} : { model: String(row.model) }) };
}

// サブエージェント由来の観測は根の待ちを解かない。last_seen_at だけを進める。
function seen(store: Store, sessionId: string, at: string): void {
  store.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND status != 'ended'").run(at, sessionId);
}

function record(store: Store, session: SessionRef, kind: string, at: string, payload: Record<string, unknown>): void {
  store.appendEvent({ id: ulid(), ts: at, kind, repo: session.repoKey, session: session.id,
    trace: { traceId: session.traceId, spanId: newSpanId() }, payload } as unknown as Event);
}

function listSubagents(store: Store, sessionId: string): SubagentIndex {
  const rows = new Map<string, SubagentRow>();
  for (const row of store.db.prepare("SELECT id, status FROM delegations WHERE session_id = ? AND kind = 'subagent' ORDER BY rowid").all(sessionId)) {
    rows.set(String(row.id), { id: String(row.id), status: String(row.status), task: "", agentType: "" });
  }
  const reinstructToolUseIds = new Set<string>();
  const events = store.db.prepare(`SELECT kind, payload FROM events WHERE session_id = ?
    AND (kind LIKE 'subagent.%' OR kind = 'delegation.requested') ORDER BY ts, rowid`).all(sessionId);
  for (const event of events) {
    const payload = JSON.parse(String(event.payload)) as Record<string, unknown>;
    const row = rows.get(String(payload.delegationId));
    if (!row) continue;
    if (event.kind === "delegation.requested") {
      row.task = typeof payload.task === "string" ? payload.task : "";
    } else if (event.kind === "subagent.dispatched") {
      if (typeof payload.toolUseId === "string" && payload.toolUseId) row.toolUseId = payload.toolUseId;
      row.agentType = typeof payload.agentType === "string" ? payload.agentType : "";
      if (typeof payload.name === "string" && payload.name) row.name = payload.name;
    } else if (event.kind === "subagent.started") {
      row.agentId = typeof payload.agentId === "string" && payload.agentId ? payload.agentId : undefined;
      if (!row.agentType && typeof payload.agentType === "string") row.agentType = payload.agentType;
    } else if (event.kind === "subagent.reinstructed") {
      if (typeof payload.toolUseId === "string" && payload.toolUseId) reinstructToolUseIds.add(payload.toolUseId);
    } else if (event.kind === "subagent.reported") {
      row.lastReport = typeof payload.output === "string" ? payload.output : "";
    }
  }
  return { rows: [...rows.values()], reinstructToolUseIds };
}

function createSubagent(store: Store, session: SessionRef, at: string, input: {
  title: string; task: string; agentType: string; model?: string; name?: string; toolUseId?: string; parentId?: string; parentAgentId?: string;
}): string {
  const id = ulid();
  const model = input.model || session.model || "";
  store.insertDelegation({ id, repoKey: session.repoKey, sessionId: session.id, parentId: input.parentId,
    role: inferRole(input.title, input.agentType), title: input.title, status: "running", kind: "subagent" });
  store.insertAssignment(id, { executor: "claude", model, family: "anthropic", tier: tierOf(model),
    reason: [`Claude Code の Agent ツール ${input.agentType}`], policyVersion: "" });
  record(store, session, "delegation.requested", at, { delegationId: id, task: input.task });
  store.insertDelegationRound(id, "request", input.task, at);
  record(store, session, "subagent.dispatched", at, { delegationId: id, toolUseId: input.toolUseId ?? "",
    agentType: input.agentType, ...(input.name ? { name: input.name } : {}),
    ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}) });
  return id;
}

// agent_id が未束縛の実行中の行のうち、同じ agent_type の最も古いもの。agent_type が無ければ結ばない。
function oldestUnbound(index: SubagentIndex, agentType: string): SubagentRow | undefined {
  if (!agentType) return undefined;
  return index.rows.find((row) => !row.agentId && row.status === "running" && row.agentType === agentType);
}

function bind(store: Store, session: SessionRef, at: string, row: SubagentRow, agentId: string | undefined, agentType: string): void {
  record(store, session, "subagent.started", at, { delegationId: row.id, agentId: agentId ?? "", agentType });
  if (agentId) record(store, session, "execution.started", at, { delegationId: row.id });
  row.agentId = agentId;
}

function finish(store: Store, session: SessionRef, at: string, row: SubagentRow, status: "done" | "failed"): void {
  store.finishDelegation(row.id, status);
  record(store, session, "delegation.finished", at, { delegationId: row.id, status });
  row.status = status;
}

// SubagentStop の子の委譲文で行を選ぶ。agent_id で結ばれた行の委譲文が合わなければ、合う行に結び直す。
function resolveStopTarget(store: Store, session: SessionRef, at: string, index: SubagentIndex,
  agentId: string | undefined, agentType: string, task: string | undefined): SubagentRow | undefined {
  const bound = agentId ? index.rows.find((row) => row.agentId === agentId) : undefined;
  if (bound && (!task || sameTask(bound.task, task))) return bound;
  const matched = task
    ? index.rows.find((row) => row.status === "running" && !row.agentId && sameTask(row.task, task))
      ?? index.rows.find((row) => row.status === "running" && sameTask(row.task, task))
    : undefined;
  if (!matched) return bound ?? oldestUnbound(index, agentType);
  if (bound && bound.id !== matched.id) {
    // 並列の同じ種別を取り違えていた。束縛を入れ替える
    const other = matched.agentId;
    bind(store, session, at, matched, agentId, agentType);
    bind(store, session, at, bound, other, bound.agentType);
    return matched;
  }
  if (!matched.agentId) bind(store, session, at, matched, agentId, agentType);
  return matched;
}

export const subagentObservers: Record<string, Observer> = {
  // PreToolUse の Agent。description を title、prompt を task にして kind subagent の行を作る。
  subagent_request: (store, { sessionId, at, body }) => {
    const session = findSession(store, sessionId);
    const toolUseId = optionalString(body.toolUseId, 200);
    const index = listSubagents(store, sessionId);
    if (toolUseId && index.rows.some((row) => row.toolUseId === toolUseId)) return;
    const task = optionalString(body.task, TASK_LIMIT) ?? "";
    const agentType = optionalString(body.subagentType, AGENT_TYPE_LIMIT)?.trim() || DEFAULT_AGENT_TYPE;
    const title = optionalString(body.title, TITLE_LIMIT)?.trim() || firstLine(task).slice(0, TITLE_LIMIT) || agentType;
    const parentAgentId = optionalString(body.parentAgentId, 200);
    const parentId = parentAgentId ? index.rows.find((row) => row.agentId === parentAgentId)?.id : undefined;
    seen(store, sessionId, at);
    createSubagent(store, session, at, { title, task, agentType, model: optionalString(body.model, 100),
      name: optionalString(body.name, 200)?.trim() || undefined, toolUseId, parentId, parentAgentId });
  },
  // PostToolUse と PostToolUseFailure の Agent。起動しなかった行を failed で閉じ、tool_response の agentId があれば結ぶ。
  subagent_done: (store, { sessionId, at, body }) => {
    const toolUseId = optionalString(body.toolUseId, 200);
    if (!toolUseId) return;
    const session = findSession(store, sessionId);
    const index = listSubagents(store, sessionId);
    const row = index.rows.find((item) => item.toolUseId === toolUseId);
    if (!row || row.status !== "running") return;
    seen(store, sessionId, at);
    const agentId = optionalString(body.agentId, 200);
    if (body.failed === true) { finish(store, session, at, row, "failed"); return; }
    if (row.agentId) return;
    if (agentId) {
      if (!index.rows.some((item) => item.agentId === agentId)) bind(store, session, at, row, agentId, row.agentType);
      return;
    }
    finish(store, session, at, row, "failed");
  },
  // SubagentStart。agent_id を、同じ agent_type の未束縛の行に古い順で結ぶ。
  subagent_start: (store, { sessionId, at, body }) => {
    const agentId = optionalString(body.agentId, 200);
    if (!agentId) return;
    const session = findSession(store, sessionId);
    const agentType = optionalString(body.agentType, AGENT_TYPE_LIMIT)?.trim() ?? "";
    const toolUseId = optionalString(body.toolUseId, 200);
    const index = listSubagents(store, sessionId);
    const existing = index.rows.find((row) => row.agentId === agentId);
    if (existing) {
      // SendMessage で再開した子。行と辺はそのまま running に戻す
      seen(store, sessionId, at);
      if (existing.status !== "running") {
        store.finishDelegation(existing.id, "running");
        record(store, session, "execution.started", at, { delegationId: existing.id });
      }
      return;
    }
    let target = toolUseId ? index.rows.find((row) => row.toolUseId === toolUseId && !row.agentId && row.status === "running") : undefined;
    target ??= oldestUnbound(index, agentType);
    if (!target) {
      // 委譲の記録も種別も無いものは Claude Code 内部のエージェント。描かない
      if (!agentType) return;
      const id = createSubagent(store, session, at, { title: agentType, task: "", agentType, toolUseId });
      target = { id, status: "running", task: "", agentType };
    }
    seen(store, sessionId, at);
    bind(store, session, at, target, agentId, agentType);
  },
  // PreToolUse の SendMessage。宛先の子への再指示を往復に足す。
  subagent_message: (store, { sessionId, at, body }) => {
    const to = optionalString(body.to, 200)?.trim();
    if (!to) return;
    const session = findSession(store, sessionId);
    const toolUseId = optionalString(body.toolUseId, 200);
    const index = listSubagents(store, sessionId);
    if (toolUseId && index.reinstructToolUseIds.has(toolUseId)) return;
    // 宛先は agent_id か、Agent の name か、行の id。名前は後に起こした子を優先する
    const target = index.rows.find((row) => row.agentId === to) ?? index.rows.findLast((row) => row.name === to)
      ?? index.rows.find((row) => row.id === to);
    if (!target) return;
    seen(store, sessionId, at);
    store.db.prepare("UPDATE delegations SET round_trips = round_trips + 1 WHERE id = ?").run(target.id);
    const text = optionalString(body.text, MESSAGE_LIMIT) ?? "";
    record(store, session, "subagent.reinstructed", at, { delegationId: target.id, agentId: target.agentId ?? to,
      toolUseId: toolUseId ?? "", text });
    store.insertDelegationRound(target.id, "reinstruct", text, at);
  },
  // SubagentStop。報告を積んで done にする。記録も種別も無い停止は捨てる。
  subagent_stop: (store, { sessionId, at, body }) => {
    const session = findSession(store, sessionId);
    const agentId = optionalString(body.agentId, 200);
    const agentType = optionalString(body.agentType, AGENT_TYPE_LIMIT)?.trim() ?? "";
    const output = optionalString(body.report, REPORT_LIMIT) ?? "";
    const summary = optionalString(body.summary, REPORT_LIMIT) ?? summarize(output);
    const task = optionalString(body.task, TASK_LIMIT);
    const index = listSubagents(store, sessionId);
    const target = resolveStopTarget(store, session, at, index, agentId, agentType, task);
    if (!target) return;
    if (target.status === "done" && target.lastReport === output) return;
    seen(store, sessionId, at);
    record(store, session, "subagent.reported", at, { delegationId: target.id, output, summary,
      ...(agentId ? { agentId } : {}), ...(task ? { task } : {}) });
    store.insertDelegationRound(target.id, "report", output, at);
    record(store, session, "execution.finished", at, { delegationId: target.id, exitCode: 0 });
    finish(store, session, at, target, "done");
  },
  // PostToolUse の AskUserQuestion。人が選び終えたので待ちを解除する。
  resumed: (store, { sessionId, at }) => {
    store.touchSession(sessionId, at);
  },
};

// 観測の種類の表。turn の 3 種は sessions.ts のまま、サブエージェントの種類をここで足す。
export const observers: Record<string, Observer> = { ...turnObservers, ...subagentObservers };

// POST /api/observe の本文を取り込む。不正な body は TypeError、未知のセッションは NotFoundError。
export function observe(body: unknown, stores: Map<string, Store>, now = new Date()): void {
  ingest(body, stores, now, observers);
}
