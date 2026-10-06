import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createRequestId, fingerprintRequest, validateRequest, type IntakeRequest } from "../../../../core/src/intake/index.ts";
import type { AppendResult, Confidence, Fact, FactInput, JsonValue, Ledger } from "../../../../core/src/ledger/index.ts";
import { projectConversations, projectNames, projectProjects, searchNames } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile, type FileCursor } from "../files.ts";

type Row = { [key: string]: JsonValue };
class KitConflict extends Error {}
function identifyRow(row: Row): string {
  return JSON.stringify([row.session, row.node_id, row.ts, row.event]);
}
interface Start {
  requestId: string;
}
function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function parseRow(text: string): Row {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {};
  }
}
export function kitEventsPath(rootPath: string): string {
  return join(rootPath, ".agents", "state", "events.jsonl");
}

/** 終了済みの記録を観測として受け付ける。実行の受付 submit は呼ばない。 */
export function observeKitDelegationsFile(ledger: Ledger, path: string): AppendResult[] {
  path = resolve(path);
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const cursors = facts.filter((fact) => fact.source === "kit" && fact.cursor)
    .map((fact) => JSON.parse(fact.cursor!) as FileCursor).filter((cursor) => cursor.path === path);
  const previous = cursors.at(-1);
  const starts = new Map<string, Start>();
  const records = new Map<string, { eventId: string; position: number }>();
  const occupied = new Set(facts.filter((fact) => fact.source === "kit").map((fact) => fact.source_event_id));
  for (const fact of facts) {
    if (fact.source !== "kit" || !fact.payload) continue;
    const evidence = (fact.payload as unknown as Row).kit as Row | undefined;
    if (evidence?.file !== path || typeof evidence.position !== "number") continue;
    const event = fact.kind === "delegation.created" ? evidence.missing_start ? "codex_done" : "codex_start"
      : fact.kind === "delegation.state_changed" ? "codex_done" : undefined;
    if (event) records.set(identifyRow({ ...evidence, ts: fact.source_ts, event }), {
      eventId: fact.source_event_id.replace(/:(request|done)$/, ""), position: evidence.position,
    });
  }
  for (const fact of facts) {
    if (fact.source !== "kit" || fact.kind !== "delegation.created" || !fact.payload) continue;
    const evidence = (fact.payload as unknown as Row).kit as Row | undefined;
    if (evidence?.file !== path) continue;
    const session = readText(evidence.session);
    const nodeId = readText(evidence.node_id);
    if (session && nodeId && fact.payload.request_id) starts.set(JSON.stringify([session, nodeId]), {
      requestId: fact.payload.request_id,
    });
  }
  let file;
  try { file = readAppendOnlyFile(path, previous); }
  catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) return [];
    throw error;
  }
  if (file.reset) starts.clear();
  const results: AppendResult[] = [];
  function append(fact: Omit<FactInput, "payload"> & { payload: object }): void {
    const result = ledger.append(fact as FactInput);
    if (result.status === "conflict") throw new KitConflict(`Conflicting kit event: ${fact.source_event_id}`);
    results.push(result);
  }
  let position = file.reset ? 0 : previous?.offset ?? 0;
  for (const line of file.lines) {
    const row = parseRow(line.text);
    const startPosition = position;
    position = line.cursor.offset;
    const session = readText(row.session);
    const nodeId = readText(row.node_id);
    if (!session || !nodeId || !["codex_start", "codex_done"].includes(String(row.event))
      || !readText(row.ts) || !Number.isFinite(Date.parse(String(row.ts)))) continue;
    const key = JSON.stringify([session, nodeId]);
    const base = { source: "kit" as const, source_ts: String(row.ts), confidence: "confirmed" as const };
    const identity = identifyRow(row);
    const known = records.get(identity);
    const eventId = known?.eventId ?? createRequestId({ source: "kit", file: path, position: startPosition });
    const originalPosition = known?.position ?? startPosition;
    const checkpointId = createHash("sha256").update(JSON.stringify(line.cursor)).digest("hex");
    try {
      // 移動済みの行は元の ID を使い、新規行の位置衝突は未対応として残す。
      const suffix = row.event === "codex_start" ? "request" : "done";
      if (!known && occupied.has(`${eventId}:${suffix}`)) {
        throw new KitConflict(`Conflicting kit event: ${eventId}`);
      }
      if (row.event === "codex_start") {
        const request: IntakeRequest = {
          requestId: eventId, source: "kit", role: "implement", title: readText(row.description) ?? nodeId,
          task: readText(row.task) ?? readText(row.description) ?? nodeId,
          accept: Array.isArray(row.accept) ? row.accept.filter((item): item is string => typeof item === "string") : [],
          ...(readText(row.parent_native_id) && (row.parent_provider === "claude" || row.parent_provider === "codex")
            ? { origin: { provider: row.parent_provider, nativeId: String(row.parent_native_id) } } : {}),
        };
        validateRequest(request);
        append({ ...base, source_event_id: `${eventId}:request`, kind: "delegation.created", subject: `delegation:${eventId}`,
          payload: { request_id: eventId, role: request.role, title: request.title, task: request.task, accept: request.accept,
            request, request_hash: fingerprintRequest(request), state: "running", attempt: 1,
            origin: request.origin && { provider: request.origin.provider, native_id: request.origin.nativeId },
            kit: { file: path, position: originalPosition, session, node_id: nodeId, parent: row.parent ?? null,
              parent_native_id: row.parent_native_id ?? null, parent_provider: row.parent_provider ?? null,
              child_native_id: row.native_id ?? null, model: row.model ?? null } } });
        // 観測の試行 ID を持たせ、runner の復旧が未起動の依頼として起動しないようにする。
        append({ ...base, source_event_id: `${eventId}:attempt`, kind: "delegation.attempt_created", subject: `delegation:${eventId}`,
          payload: { attempt: 1, run_id: `kit:${eventId}` } });
        starts.set(key, { requestId: eventId });
        appendParent(append, facts, row, eventId, base);
      } else {
        const start = starts.get(key);
        // 開始が欠けた終了にも位置由来の ID を付け、欠落を隠さず残す。
        const requestId = start?.requestId ?? eventId;
        const state = ["done", "failed", "interrupted", "denied"].includes(String(row.status))
          ? row.status as "done" | "failed" | "interrupted" | "denied" : "failed";
        if (!start) append({ ...base, confidence: "unknown", source_event_id: `${eventId}:request`,
          kind: "delegation.created", subject: `delegation:${requestId}`,
          payload: { request_id: requestId, role: "implement", title: nodeId, attempt: 1, state,
            kit: { file: path, position: originalPosition, session, node_id: nodeId, missing_start: true } } });
        append({ ...base, source_event_id: `${eventId}:done`, kind: "delegation.state_changed", subject: `delegation:${requestId}`,
          payload: { attempt: 1, state, result: { status: row.status ?? null, exit_code: row.exit_code ?? null,
            verify: row.verify ?? null }, kit: { file: path, position: originalPosition, session, node_id: nodeId } } });
      }
      records.set(identity, { eventId, position: originalPosition });
      occupied.add(`${eventId}:${suffix}`);
    } catch (error) {
      if (!(error instanceof KitConflict)) throw error;
      append({ ...base, confidence: "unknown", source_event_id: `kit:unsupported:${checkpointId}`,
        kind: "observation.unsupported", subject: `observation:kit:${checkpointId}`,
        cursor: JSON.stringify(line.cursor), payload: { source_kind: "kit", file_path: path,
          format_name: "kit-jsonl", format_version: "structural", reason: error.message,
          record_type: String(row.event), count: 1 } });
      continue;
    }
    // 行の全事実が耐久化した後だけ cursor を進める。置換後の位置も別の事実にする。
    append({ ...base, source_event_id: `kit:cursor:${checkpointId}`, kind: "delegation.updated", subject: `delegation:${starts.get(key)?.requestId ?? eventId}`,
      cursor: JSON.stringify(line.cursor), payload: {} });
  }
  return results;
}

function appendParent(append: (fact: Omit<FactInput, "payload"> & { payload: object }) => void, facts: Fact[], row: Row, requestId: string,
  base: { source: "kit"; source_ts: string; confidence: "confirmed" }): void {
  if (facts.some((fact) => fact.source === "kit" && fact.source_event_id === `${requestId}:parent`)) return;
  const conversations = projectConversations(facts).conversations;
  const nativeId = readText(row.parent_native_id);
  const provider = readText(row.parent_provider);
  const matches = nativeId ? conversations.filter((conversation) => conversation.native_id === nativeId
    && (!provider || conversation.provider === provider)) : [];
  const aliases = new Set(searchNames(projectNames(facts), String(row.session), "kit"));
  const candidates = conversations.filter((conversation) => aliases.has(conversation.id));
  const parent = nativeId ? (matches.length === 1 ? matches[0] : undefined)
    : candidates.length === 1 ? candidates[0] : undefined;
  const confidence: Confidence = parent ? nativeId ? "confirmed" : "inferred" : "unknown";
  const childId = readText(row.native_id);
  const children = childId ? conversations.filter((conversation) => conversation.provider === "codex" && conversation.native_id === childId) : [];
  append({ ...base, confidence, source_event_id: `${requestId}:parent`, kind: "relation.created", subject: `relation:kit:${requestId}`,
    payload: { type: "delegated", from_id: parent?.id, to_id: children.length === 1 ? children[0].id : `kit:${requestId}`,
      active: true, confidence, evidence: { request_id: requestId, session: row.session,
        parent_native_id: nativeId ?? null, parent_provider: provider ?? null, child_native_id: childId ?? null } } });
}

export function createKitDelegationObserver(ledger: Ledger) {
  return {
    observe(): AppendResult[] {
      return projectProjects(ledger.readSince(0, Number.MAX_SAFE_INTEGER))
        .filter((project) => project.state === "registered" && project.root_path)
        .flatMap((project) => observeKitDelegationsFile(ledger, kitEventsPath(project.root_path!)));
    },
  };
}
