import { homedir } from "node:os";
import { basename, join, normalize, sep } from "node:path";
import { createNativeId } from "../../../../core/src/ledger/projections/relations.ts";
import type { AppendResult, Fact, FactInput, JsonValue, Ledger, RunState } from "../../../../core/src/ledger/index.ts";
import { rolloutReader } from "./files.ts";
import type { RolloutLine, RolloutReader } from "./files.ts";

export interface CodexObservationOptions {
  codexHome?: string;
  reader?: RolloutReader;
  observedTs?: string;
  batch?: <T>(operation: () => T) => T;
  paths?: Set<string>;
}
type ObjectValue = { [key: string]: JsonValue };
function readObject(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function readTime(value: unknown, fallback: string): string {
  const text = readText(value);
  return text && Number.isFinite(Date.parse(text)) ? text : fallback;
}
function identifyConversation(id: string): string { return createNativeId("codex", id); }

const IGNORED_ITEMS = new Set([
  "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning",
  "commandExecution", "fileChange", "web_search_call", "tool_search_call", "tool_search_output", "compaction",
]);
const IGNORED_EVENTS = new Set([
  "token_count", "user_message", "agent_message", "agent_reasoning", "exec_command_begin", "exec_command_end",
  "exec_command_output_delta", "item_started", "item_completed", "context_compacted", "warning", "error",
  "thread_settings_applied",
]);
const IGNORED_RECORDS = new Set([
  "turn_context", "compacted", "token_usage_record", "world_state", "inter_agent_communication_metadata",
]);
const IGNORED_METHODS = new Set([
  "item/started", "item/agentMessage/delta", "thread/tokenUsage/updated", "serverRequest/resolved",
  "thread/started", "thread/settings/updated",
]);

interface RunBoundary {
  generation: number;
  offset: number;
  fileId?: string;
}
interface ObservationIndex {
  unsupported: Map<string, { factId: string; count: number; offset?: number; hash?: string; fileId?: string }>;
  subjects: Set<string>;
  placeholders: Map<string, string>;
  stateGenerations: Map<string, number>;
  runs: Map<string, RunBoundary[]>;
  archivedRuns: Map<string, { sourceTs: string; offset: number; fileId?: string }>;
}

function indexFact(index: ObservationIndex, fact: Fact | FactInput, factId: string): void {
  index.subjects.add(fact.subject);
  if (fact.kind === "observation.unsupported" && fact.source === "rollout-codex") {
    const payload = readObject(fact.payload);
    const cursor = fact.cursor ? readObject(JSON.parse(fact.cursor)) : {};
    if (typeof payload.count === "number") index.unsupported.set(fact.subject, { factId, count: payload.count,
      offset: typeof payload.last_offset === "number" ? payload.last_offset : undefined,
      hash: readText(payload.last_hash), fileId: readText(cursor.file_id) });
  }
  if (fact.kind === "conversation.created" && fact.source === "rollout-codex" && fact.confidence === "unknown") {
    index.placeholders.set(fact.subject, factId);
  }
  if (fact.kind === "run.state_changed" && fact.source === "rollout-codex" && fact.payload?.generation !== undefined) {
    index.stateGenerations.set(fact.source_event_id, fact.payload.generation);
  }
  if (fact.kind === "run.created" && fact.payload?.conversation_id) {
    const starts = index.runs.get(fact.payload.conversation_id) ?? [];
    const evidence = readObject(fact.payload.last_evidence);
    starts.push({ generation: fact.payload.generation ?? 1, offset: Number(evidence.start_offset ?? 0),
      fileId: readText(evidence.file_id) });
    index.runs.set(fact.payload.conversation_id, starts);
  }
  if (fact.kind === "run.state_changed" && readObject(fact.payload?.end_evidence).kind === "archived") {
    const evidence = readObject(fact.payload?.last_evidence);
    index.archivedRuns.set(fact.subject, { sourceTs: fact.source_ts,
      offset: Number(evidence.complete_bytes ?? 0), fileId: readText(evidence.file_id) });
  }
}

function readIndex(ledger: Ledger): ObservationIndex {
  const index: ObservationIndex = { unsupported: new Map(), subjects: new Set(), placeholders: new Map(),
    runs: new Map(), archivedRuns: new Map(), stateGenerations: new Map() };
  // 全台帳の読み取りと世代の整列は、走査全体で一度だけ行う。
  for (const fact of ledger.readSince(0, Number.MAX_SAFE_INTEGER)) indexFact(index, fact, fact.fact_id);
  for (const starts of index.runs.values()) starts.sort((a, b) => a.generation - b.generation);
  return index;
}

function resolveCodexHome(options: CodexObservationOptions): string {
  return options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function observeCodex(ledger: Ledger, options: CodexObservationOptions = {}): AppendResult[] {
  const home = resolveCodexHome(options);
  const reader = options.reader ?? rolloutReader;
  const index = readIndex(ledger);
  const archivedPaths = reader.list(join(home, "archived_sessions"));
  const archivedFileIds = new Set(archivedPaths.map((path) => basename(path)));
  return [...reader.list(join(home, "sessions")), ...archivedPaths]
    .filter((path) => !options.paths || options.paths.has(path))
    .flatMap((path) => (options.batch ?? ((operation) => operation()))(
      () => observeFile(ledger, path, { ...options, reader }, index, archivedFileIds)));
}

export function observeCodexFile(ledger: Ledger, path: string, options: CodexObservationOptions = {}): AppendResult[] {
  const reader = options.reader ?? rolloutReader;
  const archivedFileIds = new Set(reader.list(join(resolveCodexHome(options), "archived_sessions"))
    .map((archivedPath) => basename(archivedPath)));
  return observeFile(ledger, path, options, readIndex(ledger), archivedFileIds);
}

function observeFile(ledger: Ledger, path: string, options: CodexObservationOptions, index: ObservationIndex,
  archivedFileIds: Set<string>): AppendResult[] {
  const reader = options.reader ?? rolloutReader;
  const fileId = basename(path);
  let file: ReturnType<RolloutReader["read"]>;
  try { file = reader.read(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  // offset を持たない旧い集約だけ、一度全行を数えて増分へ移す。
  if (reader !== rolloutReader
    && [...index.unsupported.values()].some((group) => group.fileId === fileId && group.offset === undefined)) {
    file = rolloutReader.read(path);
  }
  const archived = normalize(path).split(sep).includes("archived_sessions");
  const observedTs = options.observedTs ?? new Date().toISOString();
  const results: AppendResult[] = [];
  const firstRow = readObject(file.lines[0]?.value);
  const metaLine = file.lines.find((line) => readObject(line.value).type === "session_meta")
    ?? (!firstRow.type && readText(firstRow.id) ? file.lines[0] : undefined);
  const metaRow = readObject(metaLine?.value);
  const meta = metaRow.type === "session_meta" ? readObject(metaRow.payload) : metaRow;
  const nativeId = readText(meta.id)
    ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileId)?.[1];
  const format = readText(meta.history_mode) ?? "legacy";
  const createdTs = readTime(meta.timestamp, observedTs);
  const supported = format === "legacy" || format === "paginated";
  const boundaries = new Map<string, RunBoundary[]>();

  function append(input: FactInput): void {
    const result = ledger.append(input);
    results.push(result);
    if (result.status === "appended") indexFact(index, input, result.fact_id);
  }
  function createBase(key: string, timestamp: string, line?: RolloutLine) {
    return {
      source: "rollout-codex" as const, source_event_id: key, source_ts: timestamp,
      observed_ts: observedTs, confidence: "confirmed" as const,
      cursor: JSON.stringify({ file_id: fileId, offset: line?.offset ?? file.completeBytes,
        hash: line?.hash ?? file.lines.at(-1)?.hash ?? null }),
    };
  }
  const unsupported = new Map<string, { line: RolloutLine; reason: string; recordType: string; payloadType: string; count: number }>();
  function reportUnsupported(line: RolloutLine, reason: string): void {
    const row = readObject(line.value);
    const recordType = reason === "Missing thread identifier" ? "unknown"
      : readText(row.type) ?? readText(row.method) ?? readText(row.record_type) ?? "unknown";
    const payloadType = reason === "Missing thread identifier" ? "unknown"
      : readText(readObject(row.payload).type) ?? readText(readObject(readObject(row.params).item).type) ?? "unknown";
    const key = JSON.stringify([fileId, recordType, payloadType, reason]);
    const previous = index.unsupported.get(`observation:codex:${key}`);
    if (previous?.offset !== undefined && (line.offset < previous.offset
      || (line.offset === previous.offset && line.hash === previous.hash))) return;
    const group = unsupported.get(key);
    if (group) { group.count += 1; group.line = line; }
    else unsupported.set(key, { line, reason, recordType, payloadType,
      count: (previous?.offset !== undefined ? previous.count : 0) + 1 });
  }
  function appendUnsupported(): void {
    for (const [key, group] of unsupported) {
      const subject = `observation:codex:${key}` as const;
      const previous = index.unsupported.get(subject);
      if (previous?.offset !== undefined && previous.count >= group.count) continue;
      // 件数が増えた場合だけ集約を追記で置き換え、再読と archive への移動は増殖させない。
      const payload = { source_kind: "rollout-codex" as const, file_path: path, format_name: format,
        format_version: readText(meta.cli_version) ?? "unknown", reason: group.reason,
        record_type: group.recordType, payload_type: group.payloadType, count: Math.max(previous?.count ?? 0, group.count),
        last_offset: group.line.offset, last_hash: group.line.hash };
      append({ ...createBase(`${key}:unsupported:${payload.count}:${group.line.offset}:${group.line.hash}`, readTime(readObject(group.line.value).timestamp, createdTs), group.line),
        kind: "observation.unsupported", subject, payload, ...(previous ? { supersedes: previous.factId } : {}) });
    }
  }
  function ensureConversation(id: string, timestamp: string): void {
    const conversation = identifyConversation(id);
    if (createdConversations.has(id) || index.subjects.has(`conversation:${conversation}`)) return;
    // 未知スレッドの出来事はメタの到着を待たず保持する。
    if (!createdConversations.has(id)) {
      createdConversations.add(id);
      append({ ...createBase(`conversation:${id}:observed`, timestamp), kind: "conversation.created",
        subject: `conversation:${conversation}`, payload: { provider: "codex", native_id: id,
          origin: "observed", type: id === nativeId && meta.source === "exec" ? "unattended"
            : id === nativeId && typeof meta.source !== "object" ? "interactive" : "subagent", history_format: format },
        confidence: "unknown" });
    }
  }
  const createdConversations = new Set<string>();
  function ensureRun(id: string, timestamp: string): void {
    if (boundaries.has(id)) return;
    const conversation = identifyConversation(id);
    const starts = index.runs.get(conversation) ?? [];
    if (!starts.length) {
      append({ ...createBase(`run:${id}:1`, timestamp), kind: "run.created", subject: `run:${conversation}:1`,
        payload: { conversation_id: conversation, generation: 1, state: "unknown", reason: "missing_state_evidence" } });
    }
    const indexedStarts = index.runs.get(conversation)!;
    const last = indexedStarts.at(-1)!;
    const end = index.archivedRuns.get(`run:${conversation}:${last.generation}`);
    // 復帰は会話自身のファイルで確認し、archive と共存する間は世代を増やさない。
    if (!archived && !archivedFileIds.has(fileId) && id === nativeId && end) {
      const generation = last.generation + 1;
      append({ ...createBase(`run:${id}:${generation}`, readTime(end.sourceTs, timestamp)), kind: "run.created",
        subject: `run:${conversation}:${generation}`, payload: { conversation_id: conversation, generation,
          state: "unknown", reason: "archive_resume", last_evidence: { file_id: end.fileId ?? fileId, start_offset: end.offset } } });
    }
    boundaries.set(id, indexedStarts);
  }
  function changeState(id: string, state: RunState, timestamp: string, line: RolloutLine, evidence: ObjectValue): void {
    ensureConversation(id, timestamp);
    ensureRun(id, timestamp);
    const starts = boundaries.get(id)!;
    // 別のファイルの byte offset は比較せず、現在の世代へ結ぶ。
    const key = `${fileId}:${line.offset}:${line.hash}:${id}:state`;
    // 再読した過去の通知は、最初に結んだ世代を保持する。
    const generation = index.stateGenerations.get(key)
      ?? starts.findLast((start) => start.fileId !== fileId || start.offset <= line.offset)!.generation;
    append({ ...createBase(key, timestamp, line), kind: "run.state_changed",
      subject: `run:${identifyConversation(id)}:${generation}`, payload: { generation, state,
        last_evidence: evidence, last_evidence_ts: timestamp } });
  }
  function createMessage(id: string, item: ObjectValue, timestamp: string, line: RolloutLine, unavailable = false): void {
    ensureConversation(id, timestamp);
    const messageNativeId = readText(item.id) ?? `${fileId}:${line.offset}:${line.hash}`;
    const messageId = createNativeId("codex", messageNativeId);
    const body = item.content ?? item.text;
    append({ ...createBase(`message:${messageNativeId}:1`, timestamp, line), kind: "message.created", subject: `message:${messageId}`,
      payload: { provider: "codex", native_id: messageNativeId, version: 1,
        role: readText(item.role) ?? (unavailable ? "unknown" : "assistant"),
        ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}),
        ...(body !== undefined && !unavailable ? { body } : {}), body_state: unavailable || body === undefined ? "unavailable" : "stored" } });
    append({ ...createBase(`membership:${messageNativeId}:${id}`, timestamp, line), kind: "message_membership.created",
      subject: `message_membership:${JSON.stringify([messageId, identifyConversation(id)])}`,
      payload: { message_id: messageId, conversation_id: identifyConversation(id), active: true } });
  }
  if (nativeId && metaLine) {
    createdConversations.add(nativeId);
    // 遅れて届くメタも内側の作成時刻を保つ。先行した仮の会話は追記で補う。
    const metadata: Extract<FactInput, { kind: "conversation.created" }> = {
      ...createBase(`${fileId}:${metaLine.offset}:${metaLine.hash}:meta`, createdTs, metaLine), kind: "conversation.created",
      subject: `conversation:${identifyConversation(nativeId)}`, payload: { provider: "codex", native_id: nativeId, origin: "observed",
        type: meta.source === "exec" ? "unattended" : typeof meta.source === "object" ? "subagent" : "interactive", history_format: format } };
    const placeholder = index.placeholders.get(metadata.subject);
    append(placeholder ? { ...metadata, kind: "conversation.corrected", supersedes: placeholder } : metadata);
    ensureRun(nativeId, createdTs);
    // parent_thread_id は照合用の根拠だけに留め、確定した辺にしない。
    const parent = readText(meta.parent_thread_id) ?? readText(readObject(readObject(readObject(meta.source).subAgent).thread_spawn).parent_thread_id);
    const generation = boundaries.get(nativeId)!.at(-1)!.generation;
    if (parent) append({ ...createBase(`${fileId}:${metaLine.hash}:parent-hint:${generation}`, createdTs, metaLine), kind: "run.updated",
      subject: `run:${identifyConversation(nativeId)}:${generation}`,
      payload: { last_evidence: { kind: "metadata_parent_hint", parent_thread_id: parent } }, confidence: "inferred" });
  }
  for (const line of file.lines) {
    if (line.contextOnly) continue;
    const row = readObject(line.value);
    const payload = readObject(row.payload);
    const params = readObject(row.params);
    const id = readText(params.threadId) ?? readText(row.threadId) ?? readText(payload.thread_id) ?? readText(payload.threadId) ?? nativeId;
    const timestamp = readTime(row.timestamp, createdTs);
    if (!supported) { reportUnsupported(line, "Unsupported history mode"); continue; }
    if (line === metaLine || row.type === "session_meta") {
      if (!nativeId) reportUnsupported(line, "Missing thread identifier");
      else if (!readText(meta.timestamp) || !Number.isFinite(Date.parse(String(meta.timestamp)))) reportUnsupported(line, "Invalid session metadata");
      continue;
    }
    const method = readText(row.method);
    const eventType = readText(payload.type);
    const item = method === "item/completed" ? readObject(params.item) : row.type === "response_item" ? payload : row;
    if (IGNORED_RECORDS.has(String(row.type)) || (!method && IGNORED_ITEMS.has(String(row.type)))
      || (row.type === "event_msg" && IGNORED_EVENTS.has(eventType ?? "")) || IGNORED_METHODS.has(method ?? "")
      || ((row.type === "response_item" || method === "item/completed") && IGNORED_ITEMS.has(String(item.type)))
      || row.record_type === "state") continue;
    if (!id) { reportUnsupported(line, "Missing thread identifier"); continue; }
    if (method === "turn/started" || (row.type === "event_msg" && eventType === "task_started")) {
      changeState(id, "running", timestamp, line, { kind: "turn_started", turn_id: params.turnId ?? readObject(params.turn).id ?? payload.turn_id ?? null });
    } else if (method === "turn/completed" || (row.type === "event_msg" && ["task_complete", "task_completed", "turn_aborted"].includes(eventType ?? ""))) {
      changeState(id, "idle", timestamp, line, { kind: "turn_completed", turn_id: params.turnId ?? readObject(params.turn).id ?? payload.turn_id ?? null });
    } else if (method === "thread/status/changed") {
      const status = readObject(params.status);
      const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
      const state = flags.includes("waitingOnApproval") ? "waiting_approval" : status.type === "active" ? "running"
        : status.type === "idle" ? "idle" : "unknown";
      changeState(id, state, timestamp, line, { kind: "thread_status", status });
    } else if (method?.endsWith("/requestApproval") || (row.type === "event_msg" && eventType === "request_approval")) {
      changeState(id, "waiting_approval", timestamp, line, { kind: "request_approval", request_id: row.id ?? payload.request_id ?? null });
    } else if (row.type === "response_item" || method === "item/completed" || row.type === "message") {
      if (item.type === "message" || item.type === "agentMessage" || item.type === "userMessage" || item.type === "agent_message") {
        createMessage(id, { ...item, role: item.role ?? (item.type === "userMessage" ? "user" : "assistant") }, timestamp, line);
      } else if (item.type === "collabAgentToolCall") {
        const sender = readText(item.senderThreadId);
        if (item.tool === "spawnAgent" && item.status === "completed" && sender && Array.isArray(item.receiverThreadIds)) {
          ensureConversation(sender, timestamp);
          for (const receiver of item.receiverThreadIds) {
            if (typeof receiver !== "string") continue;
            ensureConversation(receiver, timestamp);
            const relationId = JSON.stringify([identifyConversation(sender), identifyConversation(receiver), "delegated"]);
            append({ ...createBase(`${fileId}:${line.offset}:${line.hash}:delegated:${receiver}`, timestamp, line), kind: "relation.created",
              subject: `relation:${relationId}`, payload: { type: "delegated", from_id: identifyConversation(sender), to_id: identifyConversation(receiver),
                confidence: "confirmed", active: true, evidence: { item_id: item.id ?? null, senderThreadId: sender, receiverThreadId: receiver } } });
          }
        }
      } else {
        reportUnsupported(line, "Unsupported response item");
      }
    } else {
      reportUnsupported(line, "Unsupported rollout record");
    }
  }
  appendUnsupported();
  if (nativeId && !metaLine) { ensureConversation(nativeId, createdTs); ensureRun(nativeId, createdTs); }
  const firstMessageLine = file.lines.find((line) => {
    const row = readObject(line.value);
    const params = readObject(row.params);
    const payload = readObject(row.payload);
    const id = readText(params.threadId) ?? readText(row.threadId) ?? readText(payload.thread_id) ?? readText(payload.threadId) ?? nativeId;
    const item = row.method === "item/completed" ? readObject(params.item) : payload;
    return id === nativeId && ["message", "agentMessage", "userMessage"].includes(String(item.type))
      && (item.content !== undefined || item.text !== undefined);
  });
  if (nativeId && metaLine && supported && format === "paginated" && !firstMessageLine) {
    createMessage(nativeId, { id: `history-unavailable:${nativeId}` }, createdTs, metaLine, true);
  } else if (nativeId && firstMessageLine && index.subjects.has(`message:${createNativeId("codex", `history-unavailable:${nativeId}`)}`)) {
    // 取得不能の印は監査用に所属ごと残す。omitted は本文未保存の空レコードを表す。
    append({ ...createBase(`history-available:${nativeId}`, readTime(readObject(firstMessageLine.value).timestamp, createdTs), firstMessageLine), kind: "message.body_state_changed",
      subject: `message:${createNativeId("codex", `history-unavailable:${nativeId}`)}`, payload: { body_state: "omitted" } });
  }
  if (archived && nativeId && supported) {
    const generation = boundaries.get(nativeId)!.at(-1)!.generation;
    const timestamp = readTime(readObject(file.lines.at(-1)?.value).timestamp, createdTs);
    append({ ...createBase(`archive:${nativeId}:${generation}`, timestamp), kind: "run.state_changed",
      subject: `run:${identifyConversation(nativeId)}:${generation}`, payload: { generation, state: "ended", ended_ts: timestamp,
        end_evidence: { kind: "archived", location: "archived_sessions" },
        last_evidence: { file_id: fileId, complete_bytes: file.completeBytes } } });
  }
  return results;
}
