import { basename } from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { evaluateState, readNativeEvidence, readNativeTurnId } from '../../../core/src/state/index.ts';
import type { StateInput, StateEvidence, Signal, Scan, NativeRecord, ProcessIdentity } from '../../../core/src/state/index.ts';
import { orderActiveFacts } from '../../../core/src/ledger/projections/connections.ts';
import type { Fact } from '../../../core/src/ledger/facts.ts';
import { SESSION_SCAN_VALID_MS, type SessionScan } from './session-scan.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
const flag = (value: unknown): boolean | undefined => value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
export const DISPLAY_STATES = { Unresolved: 'unresolved', Stopped: 'stopped', 'Needs approval': 'waiting_approval', Waiting: 'waiting_input',
  Working: 'running', Closed: 'closed', 'Not hosted': 'not_hosted', Idle: 'idle', Unknown: 'unknown' } as const;
const PRIORITY = Object.values(DISPLAY_STATES);
interface RunContext { row: Row; facts: Fact[]; records: NativeRecord[]; input: StateInput; parent?: string; childId?: string;
  evaluation?: { scanVersion: number; at: number; until: number; row: Row } }

/** 事実の対応付けと時計は api が持ち、状態の意味は core の関数だけが決める。 */
export class CurrentState {
  private seq = -1;
  private dirty = true;
  private hasConflicts = false;
  private nextEvaluation = 0;
  private contexts = new Map<string, RunContext>();
  private nativeById = new Map<string, Row>();
  private remote = new Set<string>();
  private owners = new Map<string, ProcessIdentity | null>();
  private hasScans: boolean;
  private scanCache = new Map<string, SessionScan>();
  private scanStatements = new Map<string, StatementSync>();
  private scanQueries = new Map<string, SessionScan | undefined>();
  private scanVersion = 0;
  readonly runs = new Map<string, Row>();
  readonly conversations = new Map<string, Row>();
  evaluatedAt = 0;
  private db: DatabaseSync;
  private canonical: (id: string) => string;
  constructor(db: DatabaseSync, canonical: (id: string) => string) {
    this.db = db; this.canonical = canonical;
    db.exec(`CREATE TABLE IF NOT EXISTS api_state_scans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_run_owners (run_id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS api_scan_time ON api_state_scans(json_extract(data, '$.at'));
      CREATE INDEX IF NOT EXISTS api_scan_provider_time ON api_state_scans(coalesce(json_extract(data, '$.provider'), 'claude'), json_extract(data, '$.at'));
      CREATE INDEX IF NOT EXISTS api_scan_provider_status_time ON api_state_scans(coalesce(json_extract(data, '$.provider'), 'claude'), json_extract(data, '$.status'), json_extract(data, '$.at'));
      CREATE INDEX IF NOT EXISTS api_remote_conversation_subject ON facts(subject)
        WHERE kind GLOB 'conversation.*' AND json_type(payload, '$.connection_id') = 'text'`);
    this.hasScans = !!db.prepare('SELECT 1 FROM api_state_scans LIMIT 1').get();
    for (const row of db.prepare('SELECT * FROM api_run_owners').all()) this.owners.set(String(row.run_id), JSON.parse(String(row.data)));
  }
  get reevaluateAt(): number { return this.nextEvaluation; }
  invalidateFacts(): void { this.seq = -1; }
  recordScan(scan: SessionScan): void {
    this.db.prepare('INSERT OR IGNORE INTO api_state_scans VALUES (?, ?)').run(scan.id, JSON.stringify(scan));
    this.hasScans = true; this.scanCache.clear();
    this.scanVersion++;
    this.dirty = true;
  }
  refresh(seq: number, now = Date.now()): string[] {
    if (this.seq !== seq) { this.loadFacts(seq); this.seq = seq; this.dirty = true; }
    if (!this.dirty && now >= this.evaluatedAt && now < this.nextEvaluation) return [];
    this.dirty = false;
    this.scanQueries.clear();
    const futureScan = this.hasScans ? this.db.prepare("SELECT min(json_extract(data, '$.at')) AS at FROM api_state_scans WHERE json_extract(data, '$.at') > ?").get(now)?.at : null;
    this.nextEvaluation = Infinity;
    this.evaluatedAt = now;
    const changed: string[] = [];
    let emptyDecision: ReturnType<typeof evaluateState> | undefined;
    this.conversations.clear();
    for (const [id, context] of this.contexts) {
      const cached = context.evaluation;
      if (cached && cached.scanVersion === this.scanVersion && now >= cached.at && now < cached.until) {
        this.nextEvaluation = Math.min(this.nextEvaluation, cached.until);
        this.runs.set(id, cached.row); this.selectConversation(cached.row); continue;
      }
      const input = this.withScans(context, now);
      let decision = !input.evidence.length && !input.process && !input.attempt
        ? emptyDecision ??= evaluateState(input, now) : evaluateState(input, now);
      const previous = this.runs.get(id)?.decision as ReturnType<typeof evaluateState> | undefined;
      const stateChanged = !previous || JSON.stringify({ ...previous, evaluatedAt: 0 }) !== JSON.stringify({ ...decision, evaluatedAt: 0 });
      if (!stateChanged) decision = previous!;
      let until = typeof futureScan === 'number' ? futureScan : Infinity;
      for (const part of [decision.process, decision.hosting, decision.turn]) if (part.validUntil !== null && part.validUntil > now) until = Math.min(until, part.validUntil);
      for (const proof of input.evidence) for (const at of [proof.at, proof.observedAt]) if (at > now) until = Math.min(until, at);
      this.nextEvaluation = Math.min(this.nextEvaluation, until);
      const signals = input.evidence.filter((e): e is Signal => e.kind === 'signal' && e.turnId === input.turnId);
      const start = signals.filter(e => e.event === 'start').sort((a, b) => a.at - b.at)[0];
      const latest = signals.filter(e => e.at <= now).sort((a, b) => b.at - a.at)[0];
      const row: Row = { id, conversation_id: context.row.conversation_id, generation: context.row.generation,
        started_ts: context.row.started_ts, state: DISPLAY_STATES[decision.display.label], decision,
        turn_started_ts: decision.turn.value === 'running' && start ? new Date(start.at).toISOString() : null,
        last_evidence_ts: latest ? new Date(latest.at).toISOString() : context.row.started_ts,
        reason: decision.turn.reason, activity_rank: PRIORITY.indexOf(DISPLAY_STATES[decision.display.label]) };
      this.runs.set(id, row); if (stateChanged) changed.push(id);
      context.evaluation = { scanVersion: this.scanVersion, at: now, until, row };
      this.selectConversation(row);
    }
    for (const id of this.runs.keys()) if (!this.contexts.has(id)) { this.runs.delete(id); changed.push(id); }
    return changed;
  }
  private selectConversation(row: Row): void {
    const conversation = String(row.conversation_id);
    const previous = this.conversations.get(conversation);
    // hook の連番と履歴取り込みの時刻由来の世代は比較せず、起動の時刻を先に使う。
    const started = Date.parse(String(row.started_ts)) || 0;
    const before = Date.parse(String(previous?.started_ts)) || 0;
    if (!previous || started > before || started === before && Number(row.generation) > Number(previous.generation)) this.conversations.set(conversation, row);
  }
  private loadFacts(seq: number): void {
    this.nativeById = new Map(this.db.prepare('SELECT id, native_id, provider, type FROM conversations').all().map(row => [this.canonical(String(row.id)), row]));
    this.remote = new Set(this.db.prepare("SELECT DISTINCT subject FROM facts WHERE kind GLOB 'conversation.*' AND json_type(payload, '$.connection_id') = 'text'").all().map(row => this.canonical(String(row.subject).slice('conversation:'.length))));
    const delta = this.seq >= 0 && seq > this.seq ? this.db.prepare('SELECT kind, subject, supersedes FROM facts WHERE seq > ? AND seq <= ?').all(this.seq, seq) : undefined;
    const incremental = delta && !this.hasConflicts && !delta.some(row => row.supersedes || String(row.kind).startsWith('relation.') || row.kind === 'observation.unsupported'
      || String(row.kind).startsWith('connection.'));
    const changedSubjects = incremental ? new Set(delta.filter(row => String(row.kind).startsWith('run.')).map(row => String(row.subject))) : undefined;
    const changedConversations = new Set(delta?.filter(row => String(row.kind).startsWith('conversation.'))
      .map(row => this.canonical(String(row.subject).slice('conversation:'.length))));
    const previous = this.contexts;
    this.contexts = new Map();
    const subjects = new Map<string, RunContext[]>();
    const affected = new Set<RunContext>();
    for (const row of this.db.prepare('SELECT conversation_id, generation, started_ts, pid, start_fingerprint FROM runs').iterate()) {
      const conversation = this.canonical(String(row.conversation_id));
      const id = `${conversation}:${row.generation}`;
      const context: RunContext = { row: { id, conversation_id: conversation, generation: row.generation,
        started_ts: row.started_ts, pid: row.pid, start_fingerprint: row.start_fingerprint }, facts: [], records: [],
        input: { runId: id, turnId: null, process: null, parentProcessAtLaunch: 'independent', attempt: null, evidence: [] } };
      this.contexts.set(id, context);
      if (this.nativeById.get(conversation)?.type === 'subagent') context.input.attempt = { id: null, requiredStage: 'unknown' };
    }
    for (const row of this.db.prepare('SELECT * FROM run_subjects').all()) {
      const context = this.contexts.get(`${this.canonical(String(row.conversation_id))}:${row.generation}`);
      if (context) { const key = `run:${row.subject_id}`; subjects.set(key, [...subjects.get(key) ?? [], context]); }
    }
    if (changedSubjects) {
      for (const [subject, contexts] of subjects) {
        if (contexts.some(context => changedConversations.has(String(context.row.conversation_id))
          || this.nativeById.get(String(context.row.conversation_id))?.type === 'subagent')) changedSubjects.add(subject);
        for (const context of contexts) if (changedSubjects.has(subject) || !previous.has(String(context.row.id))) affected.add(context);
      }
      for (const [id, context] of this.contexts) if (!affected.has(context) && previous.has(id)) this.contexts.set(id, previous.get(id)!);
    } else for (const context of this.contexts.values()) affected.add(context);
    const filter = changedSubjects ? ' AND subject IN (SELECT value FROM json_each(?))' : '';
    const rows = this.db.prepare(`SELECT seq, fact_id, source, source_event_id, kind, subject, source_ts, observed_ts, confidence, supersedes, payload
      FROM facts WHERE seq <= ? AND (kind GLOB 'run.*' OR kind = 'observation.unsupported')${filter}`)
      .iterate(...(changedSubjects ? [seq, JSON.stringify([...changedSubjects])] : [seq]));
    const facts = orderActiveFacts(Array.from(rows, row => ({ ...row, payload: row.payload ? JSON.parse(String(row.payload)) : null } as Fact)));
    this.hasConflicts = facts.some(fact => fact.kind === 'observation.unsupported');
    for (const fact of facts) {
      if (!fact.kind.startsWith('run.')) continue;
      const candidates = subjects.get(fact.subject) ?? [];
      const generation = object(fact.payload).generation;
      const matching = generation !== undefined ? candidates.filter(c => c.row.generation === generation)
        : candidates.filter(c => !c.row.started_ts || Date.parse(String(c.row.started_ts)) <= Date.parse(fact.source_ts)).sort((a, b) => Number(b.row.generation) - Number(a.row.generation)).slice(0, 1);
      for (const context of matching) context.facts.push(fact);
    }
    for (const relation of this.db.prepare("SELECT * FROM relations WHERE type = 'delegated' AND active = 1 AND confidence = 'confirmed'").all()) {
      const child = this.canonical(String(relation.to_id));
      const parent = this.canonical(String(relation.from_id));
      for (const context of this.contexts.values()) if (context.row.conversation_id === child) {
        context.parent = parent;
        const native = this.nativeById.get(child)?.native_id;
        context.childId = String(native ?? '').replace(/^agent-/, '');
        context.input.parentProcessAtLaunch = null;
      }
    }
    const conflictsByPath = new Map<string, Fact[]>();
    for (const fact of facts) if (fact.kind === 'observation.unsupported' && String(object(fact.payload).reason).startsWith('Conflicting history')) {
      const path = basename(String(object(fact.payload).file_path ?? ''));
      const matches = conflictsByPath.get(path) ?? []; matches.push(fact); conflictsByPath.set(path, matches);
    }
    for (const context of affected) {
      context.row.started_ts ??= context.facts.find(f => f.kind === 'run.created')?.source_ts ?? context.facts[0]?.source_ts;
      if (context.facts.some(f => object(f.payload).last_evidence || object(f.payload).end_evidence || f.source.startsWith('host-'))) this.readEvidence(context);
      if (conflictsByPath.size) {
        const paths = new Set(context.facts.map(f => object(object(f.payload).last_evidence).file_id).filter(Boolean));
        const conflicts: StateEvidence[] = [...paths].flatMap(path => conflictsByPath.get(String(path)) ?? [])
          .map(f => ({ kind: 'conflict', id: f.fact_id, at: Date.parse(f.source_ts), observedAt: Date.parse(f.observed_ts), runId: context.input.runId!, count: Number(object(f.payload).count ?? 1) }));
        context.input.evidence = [...context.input.evidence, ...conflicts];
      }
      context.facts = [];
    }
    // 親の通知は task-id と子の既知の turn で対応させる。親の promptId は使わない。
    for (const child of this.contexts.values()) {
      if (!child.parent) continue;
      const records = [...this.contexts.values()].filter(c => c.row.conversation_id === child.parent).flatMap(c => c.records);
      const launches = records.filter(record => object(record.row.toolUseResult).agentId === child.childId
        || object(object(record.row.params).item).tool === 'spawnAgent' && (object(object(record.row.params).item).receiverThreadIds as unknown[] | undefined)?.includes(child.childId));
      for (const record of launches) {
        const result = object(record.row.toolUseResult);
        const blocks = object(record.row.message).content;
        const call = Array.isArray(blocks) ? blocks.find(block => object(block).type === 'tool_result') : undefined;
        const item = object(object(record.row.params).item);
        const id = string(object(call).tool_use_id) ?? string(item.id);
        if (!id) continue;
        const parentBlocks = object(record.parentCall?.message).content;
        const synchronous = Array.isArray(parentBlocks) && parentBlocks.some(block => object(block).id === id && flag(object(object(block).input).run_in_background) === false);
        child.input.attempt = { id: JSON.stringify([record.runId, id, 1]), requiredStage: item.tool === 'spawnAgent' ? 'responded'
          : result.status === 'async_launched' && flag(result.isAsync) === true ? 'reported' : synchronous && result.status === 'completed' && flag(result.isAsync) !== true ? 'responded' : 'unknown' };
      }
      if (child.input.attempt?.id) child.input.evidence = child.input.evidence.map(e => e.kind === 'signal' ? { ...e, attemptId: child.input.attempt!.id } : e);
      const starts = child.input.evidence.filter((e): e is Signal => e.kind === 'signal' && e.event === 'start' && !!e.turnId).sort((a, b) => a.at - b.at);
      const additional = records.flatMap(record => {
        const turn = starts.findLast(start => start.at <= record.at);
        return readNativeEvidence({ ...record, source: record.source === 'codex' ? 'codex_child' : 'claude_child',
          id: `${record.id}:child:${child.input.runId}`, runId: child.input.runId!, turnId: turn?.turnId, childId: child.childId, attemptId: child.input.attempt?.id,
          row: { ...record.row, promptId: undefined } });
      });
      child.input.evidence = [...child.input.evidence, ...additional];
    }
  }
  private readEvidence(context: RunContext): void {
    const evidence: StateEvidence[] = [];
    const turns = new Map<string, string>();
    const calls = new Map<string, Row>();
    const codexTurns = new Map<string, string>();
    const tools = new Map<string, string>();
    for (const fact of context.facts) {
      const payload = object(fact.payload), last = object(payload.last_evidence);
      const at = Date.parse(fact.source_ts), observedAt = Date.parse(fact.observed_ts);
      let source = string(last.native_source) as NativeRecord['source'] | undefined;
      let row = object(last.native_record);
      if (fact.source === 'hook' && last.auxiliary !== true && last.hook_event_name) {
        source = 'hook'; row = { ...object(last.input), hook_event_name: last.hook_event_name };
      }
      const end = object(payload.end_evidence);
      if (fact.confidence === 'confirmed' && fact.source.startsWith('host-') && end.kind === 'host_exit')
        evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.input.runId!, event: 'exit' });
      if (fact.confidence === 'confirmed' && end.kind === 'archived' && fact.source === 'rollout-codex')
        evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.input.runId!, event: 'archive' });
      if (!source && fact.source === 'host-claude' && last.kind === 'result') {
        source = 'claude_sdk'; row = { type: 'result', ...(last.outcome === 'interrupted' ? {} : { is_error: last.outcome === 'failed' }) };
        if (last.outcome === 'interrupted') { evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.input.runId!, turnId: string(last.turn_id), event: 'complete' }); continue; }
      }
      if (!source && fact.source.startsWith('host-')) {
        // ホストが保存した turn 相関付きの事実だけを入力にする。
        const turnId = string(payload.turn_id) ?? string(last.turn_id);
        const event = fact.kind === 'run.interrupt_requested' ? 'interrupt_request'
          : payload.state === 'running' ? 'start' : payload.state === 'idle' ? 'complete'
            : payload.state === 'waiting_approval' ? 'approval' : payload.state === 'waiting_input' ? 'input' : undefined;
        if (event) evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.input.runId!, turnId, event });
      }
      if (!source) continue;
      let turnId = readNativeTurnId(source, row) ?? (fact.source.startsWith('host-') ? string(last.turn_id) : undefined);
      if (source === 'codex') {
        const file = String(last.file_id ?? fact.subject);
        if (row.type === 'turn_context' && turnId) codexTurns.set(file, turnId);
        else turnId ??= codexTurns.get(file);
      }
      const parent = string(row.parentUuid);
      if (!turnId && parent) turnId = turns.get(parent);
      const blocks = object(row.message).content;
      if (!turnId && Array.isArray(blocks)) {
        const ids = new Set(blocks.map(b => tools.get(String(object(b).tool_use_id))).filter(Boolean));
        if (ids.size === 1) turnId = [...ids][0];
      }
      const record: NativeRecord = { id: fact.fact_id, at, observedAt, source, runId: context.input.runId!, row, turnId };
      if (Array.isArray(blocks)) {
        const result = blocks.find(b => object(b).type === 'tool_result');
        if (result) record.parentCall = calls.get(String(object(result).tool_use_id));
      }
      const signals = readNativeEvidence(record);
      // UUID は相関を持たない開始にだけ新しい turn の鍵として割り当てる。
      if (!turnId && source === 'claude' && string(row.uuid) && signals.some(e => e.kind === 'signal' && e.event === 'start')) {
        turnId = `prompt:${row.uuid}`; record.turnId = turnId;
      }
      if (turnId) {
        if (string(row.uuid)) turns.set(String(row.uuid), turnId);
        if (Array.isArray(blocks)) for (const b of blocks) if (object(b).type === 'tool_use' && string(object(b).id)) { tools.set(String(object(b).id), turnId); calls.set(String(object(b).id), row); }
      }
      context.records.push(record);
      const internalNotification = String(row.content ?? JSON.stringify(blocks)).includes('<task-notification>');
      if (!internalNotification) evidence.push(...readNativeEvidence(record));
    }
    const starts = evidence.filter((e): e is Signal => e.kind === 'signal' && e.event === 'start' && !!e.turnId).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const keyed = evidence.filter((e): e is Signal => e.kind === 'signal' && !!e.turnId).sort((a, b) => b.at - a.at);
    context.input.turnId = starts[0]?.turnId ?? keyed[0]?.turnId ?? null;
    context.input.evidence = evidence;
  }
  private readScan(provider: string, where: string, values: SQLInputValue[], first = false): SessionScan | undefined {
    const key = JSON.stringify([provider, where, values, first]);
    if (this.scanQueries.has(key)) return this.scanQueries.get(key);
    const sql = `SELECT id, data FROM api_state_scans WHERE coalesce(json_extract(data, '$.provider'), 'claude') = ? AND ${where}
      ORDER BY json_extract(data, '$.at') ${first ? 'ASC' : 'DESC'}, id LIMIT 1`;
    let statement = this.scanStatements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.scanStatements.set(sql, statement); }
    const row = statement.get(provider, ...values);
    if (!row) { this.scanQueries.set(key, undefined); return; }
    let scan = this.scanCache.get(String(row.id));
    if (!scan) { scan = JSON.parse(String(row.data)) as SessionScan; this.scanCache.set(scan.id, scan); }
    this.scanQueries.set(key, scan);
    return scan;
  }
  private withScans(context: RunContext, now: number): StateInput {
    const input = { ...context.input, evidence: [...context.input.evidence] };
    if (typeof context.row.pid === 'number' && typeof context.row.start_fingerprint === 'string') input.process = { pid: context.row.pid, procStart: context.row.start_fingerprint };
    if (input.process && !context.parent) input.evidence = input.evidence.map(e => e.kind === 'signal' && e.event === 'exit' ? { ...e, process: input.process! } : e);
    if (!this.hasScans) return input;
    const conversation = context.parent ?? String(context.row.conversation_id);
    if (this.remote.has(conversation)) return input;
    const native = this.nativeById.get(conversation);
    if (!native || !['claude', 'codex'].includes(String(native.provider))) return input;
    const provider = String(native.provider);
    const successful = "json_extract(data, '$.status') = 'succeeded' AND json_extract(data, '$.at') <= ?";
    const latest = this.readScan(provider, "json_extract(data, '$.at') <= ?", [now]);
    const good = this.readScan(provider, successful, [now]);
    const started = Date.parse(String(context.row.started_ts ?? ''));
    let owner: ProcessIdentity | null = this.owners.get(input.runId!) ?? input.process;
    if (!this.owners.has(input.runId!)) {
      // 起動前に観測した親だけを固定する。既存の子を現在の親で補わない。
      const scan = this.readScan(provider, successful + ` AND EXISTS (SELECT 1 FROM json_each(data, '$.sessions') session
        WHERE json_extract(session.value, '$.sessionId') = ? AND json_extract(session.value, '$.startedAt') <= ?)
        ${context.parent ? "AND json_extract(data, '$.at') <= ? AND json_extract(data, '$.at') > ?" : ''}`,
        [now, String(native.native_id), started, ...(context.parent ? [started, started - SESSION_SCAN_VALID_MS] : [])]);
      const session = scan?.sessions.find(row => row.sessionId === native.native_id);
      if (session) owner = { pid: session.pid, procStart: session.procStart };
      if (owner || context.parent) {
        this.db.prepare('INSERT OR IGNORE INTO api_run_owners VALUES (?, ?)').run(input.runId!, JSON.stringify(owner));
        this.owners.set(input.runId!, owner);
      }
    }
    const current = good?.sessions.find(row => row.sessionId === native.native_id);
    input.process = context.parent && current ? { pid: current.pid, procStart: current.procStart } : owner;
    input.parentProcessAtLaunch = context.parent ? owner : 'independent';
    if (owner && !context.parent) input.evidence = input.evidence.map(e => e.kind === 'signal' && e.event === 'exit' ? { ...e, process: owner! } : e);
    const absent = owner ? this.readScan(provider, successful + ` AND json_extract(data, '$.at') >= ?
      AND NOT EXISTS (SELECT 1 FROM json_each(data, '$.processes') process WHERE json_extract(process.value, '$.pid') = ?
        AND (json_extract(process.value, '$.procStart') IS NULL OR json_extract(process.value, '$.procStart') = ?))`,
      [now, started, owner.pid, owner.procStart], true) : undefined;
    const start = input.evidence.filter((e): e is Signal => e.kind === 'signal' && e.event === 'start' && e.turnId === input.turnId).sort((a, b) => b.at - a.at)[0];
    const busy = start && !context.parent ? this.readScan(provider, `json_extract(data, '$.at') <= ? AND json_extract(data, '$.at') >= ?
      AND EXISTS (SELECT 1 FROM json_each(data, '$.sessions') session WHERE json_extract(session.value, '$.sessionId') = ?
        AND json_extract(session.value, '$.status') = 'busy' AND json_extract(session.value, '$.statusUpdatedAt') >= ?)`,
      [now, started, String(native.native_id), start.at]) : undefined;
    // 最新の健康・所持と、物理終了の最初の証拠だけで判定する。走査の全履歴は DB に残す。
    const scans = new Map([latest, good, absent, busy].filter((scan): scan is SessionScan => !!scan).map(scan => [scan.id, scan]));
    for (const scan of scans.values()) {
      if (scan.at < started) continue;
      const session = scan.sessions.find(row => row.sessionId === native.native_id);
      const proof: Scan = { kind: 'scan', id: scan.id, at: scan.at, observedAt: scan.at, source: `${native.provider}_sessions`, scope: 'local',
        subjects: [input.runId!], status: scan.status, validForMs: SESSION_SCAN_VALID_MS, processes: scan.processes,
        hosted: session && scan.processes.some(p => p.pid === session.pid && p.procStart === session.procStart) ? [input.runId!] : [] };
      input.evidence.push(proof);
      if (session && !context.parent && start && session.statusUpdatedAt !== undefined && session.statusUpdatedAt >= start.at) input.evidence.push(...readNativeEvidence({ id: `${scan.id}:busy:${input.runId}`, at: scan.at, observedAt: scan.at,
        source: 'claude_session', runId: input.runId!, turnId: input.turnId, row: { ...session } }));
    }
    return input;
  }
}
