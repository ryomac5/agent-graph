import { expandNativeEvidence } from '../../../core/src/ledger/native-evidence.ts';
import { renderConversationState, type ConversationDecision } from './conversation-display.ts';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import { DEFAULT_STATE_POLICY, DEFAULT_DELIVERY_POLICY, evaluateState, readNativeEvidence, readNativeTurnId } from '../../../core/src/state/index.ts';
import type { StateDecision, StateInput, StateEvidence, Signal, Scan, NativeRecord, ProcessIdentity } from '../../../core/src/state/index.ts';
import { orderActiveFacts } from '../../../core/src/ledger/projections/connections.ts';
import type { Fact } from '../../../core/src/ledger/facts.ts';
import { SESSION_SCAN_VALID_MS, type SessionScan } from './session-scan.ts';
import { normalizeProcessStart } from '../../../core/src/state/process.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined;
const flag = (value: unknown): boolean | undefined => value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined;
export const DISPLAY_STATES = { Unresolved: 'unresolved', Stopped: 'stopped', 'Needs approval': 'waiting_approval', Waiting: 'waiting_input',
  Working: 'running', 'Waiting for agents': 'waiting_agents', Closed: 'closed', 'Not hosted': 'not_hosted', Idle: 'idle', Unknown: 'unknown' } as const;
const PRIORITY = Object.values(DISPLAY_STATES);
// core の進行・待ち 300 秒、配達 60 秒、走査の生存 30 秒の最大値。
export const STATE_SCAN_RETENTION_MS = Math.max(DEFAULT_STATE_POLICY.progressMs, DEFAULT_STATE_POLICY.waitingMs,
  DEFAULT_DELIVERY_POLICY.deadlineMs, SESSION_SCAN_VALID_MS);

function identifyDecision(decision: StateDecision, input: StateInput): string {
  // 走査の証拠は保持し、識別には照会時刻でなく対象プロセスと結果を使う。
  const evidence = new Map(input.evidence.map(proof => {
    const { id, at, observedAt, ...content } = proof;
    // 走査の対象はこの実行自身であり、所持の有無は hosted に畳む。対象の ID を残すと、
    // 同じ内容の判定が実行ごとに別の ID になり、同じ判定を一度だけ配れない。
    const identity = proof.kind === 'scan'
      ? { ...content, subjects: undefined, processes: proof.processes?.filter(p => p.pid === input.process?.pid)
        .map(p => [p.pid, p.procStart]).sort(), hosted: proof.hosted?.includes(input.runId!) }
      : proof.kind === 'signal' && proof.activity === 'session_busy' ? content : id;
    return [id, JSON.stringify(identity)];
  }));
  const parts = Object.fromEntries((['process', 'hosting', 'closure', 'turn', 'result'] as const).map(key => {
    const { at, validUntil, evidenceIds, ...content } = decision[key];
    return [key, { ...content, evidenceIds: [...new Set(evidenceIds.map(id => evidence.get(id) ?? id))].sort() }];
  }));
  const content = { ...parts, processIdentity: input.process, parentProcessAtLaunch: input.parentProcessAtLaunch,
    observation: decision.observation.map(({ at, ...row }) => row), conflicts: decision.conflicts, display: decision.display };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 32);
}
/**
 * 実行自身の証拠も、プロセスも、試行もない入力の鍵を返す。走査は id ごとに中身が決まるので、
 * 走査の id と、この実行を所持するかだけを鍵にする。core は実行の id を一致の比較にしか使わない。
 */
function sharedInputKey(input: StateInput): string | undefined {
  if (input.process || input.attempt || input.turnId !== null || input.runId === null) return;
  const parts: unknown[] = [input.parentProcessAtLaunch];
  for (const proof of input.evidence) {
    if (proof.kind !== 'scan' || proof.supersedes || proof.subjects.length !== 1 || proof.subjects[0] !== input.runId
      || proof.id.includes(input.runId) || proof.hosted?.some(id => id !== input.runId)) return;
    parts.push([proof.id, proof.at, proof.observedAt, proof.source, proof.scope, proof.status, proof.validForMs, proof.hosted?.length ?? null]);
  }
  return JSON.stringify(parts);
}
// 提供元や種類のように値の少ない文字列は、1 万行に別々の写しを持たせない。
const interned = new Map<unknown, unknown>();
const intern = (value: unknown): unknown => typeof value !== 'string' ? value : interned.get(value) ?? (interned.set(value, value), value);
// 親の原記録が子を名指しし得る id。子の起動結果、Codex の協調と子の活動、task-notification の task-id を集める。
// readNativeEvidence が子の証拠を作るのは、これらのどれかが子の id と一致する記録だけである。
function readRecordChildIds(row: Row): string[] {
  const ids: string[] = [];
  const agent = string(object(row.toolUseResult).agentId);
  if (agent) ids.push(agent);
  const item = object(object(row.params).item);
  if (Array.isArray(item.receiverThreadIds)) for (const id of item.receiverThreadIds) if (typeof id === 'string') ids.push(id);
  const activity = string(object(object(row.payload).item).agent_thread_id);
  if (activity) ids.push(activity);
  const blocks = object(row.message).content;
  const texts = [row.content, ...(Array.isArray(blocks) ? blocks.map(block => object(block).text) : [])];
  for (const text of texts) if (typeof text === 'string') for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/gu)) ids.push(match[1]);
  return ids;
}
// 証拠の読み取りの続きを残す実行の事実数の下限。少ない実行は毎回全事実から読み直しても軽い。
const EVIDENCE_STATE_MIN_FACTS = 500;
/**
 * readEvidence の途中の状態。事実を時刻の順に読むので、後に並ぶ事実だけを足せば全事実を読み直した結果と一致する。
 * 既存の事実の祖先が新しい事実の uuid に届く場合、時刻の前後、競合の印の変化、時刻の解釈の失敗では続きを使わない。
 */
interface EvidenceState {
  seq: number; exact: boolean; conflicts: string; last?: Fact;
  evidence: StateEvidence[]; records: NativeRecord[]; files: Set<string>;
  turns: Map<string, string>; calls: Map<string, Row>; codexTurns: Map<string, string>; tools: Map<string, string>;
  parents: Map<string, string | undefined>; prompts: Map<string, string>; dangling: Set<string>;
  start?: Signal; keyed?: Signal;
  // 実行の表に開始時刻がないとき、事実から補った開始時刻とその根拠の事実。
  derived?: { startedTs: unknown; first?: Fact; created?: Fact };
}
function createEvidenceState(): EvidenceState {
  return { seq: -1, exact: true, conflicts: '', evidence: [], records: [], files: new Set(), turns: new Map(), calls: new Map(),
    codexTurns: new Map(), tools: new Map(), parents: new Map(), prompts: new Map(), dangling: new Set() };
}
function readConflictSignature(files: Iterable<string>, conflictsByPath: Map<string, Fact[]>): string {
  return JSON.stringify([...files].sort().map(file => [file, (conflictsByPath.get(file) ?? []).map(fact => fact.fact_id)]));
}
function readClaudeUuid(fact: Fact): string | undefined {
  const last = object(object(fact.payload).last_evidence);
  return last.native_source === 'claude' ? string(object(last.native_record).uuid) : undefined;
}
const hasEvidence = (fact: Fact): boolean => !!(object(fact.payload).last_evidence || object(fact.payload).end_evidence || fact.source.startsWith('host-'));
/**
 * 実行ごとの読み込みと評価の状態。1 万件の実行に持つので、1 つの物に平らに置き、配る行も兼ねる。
 * 入力、事実、記録は持つ実行にだけ作る。
 */
interface RunContext {
  id: string; conversation_id: string; generation: unknown; started_ts: unknown; pid: unknown; start_fingerprint: unknown;
  input?: StateInput; facts?: Fact[]; records?: NativeRecord[]; files?: string[]; parent?: string; childId?: string;
  inheritedEvidence?: StateEvidence[];
  // 配る今の状態。未評価の実行は state を持たない。
  state?: string; decision?: ConversationDecision; ownDecision?: StateDecision; ownDecisionId?: string; decision_id?: string; turn_started_ts?: string | null; last_evidence_ts?: unknown;
  reason?: string; activity_rank?: number; deliveredStarted?: unknown;
  // 最後の評価の版と時刻。
  evaluatedVersion?: number; evaluatedAt?: number; evaluatedUntil?: number;
  // 所持者が見つからなかった照会。会話、開始時刻、未来の走査の時刻で有効かを確かめる。
  missNative?: unknown; missStarted?: number; missUntil?: number;
  // 開始時刻のない実行は、事実の順で最初の事実と最初の run.created から開始時刻を補う。事実の全体は持たない。
  firstFact?: Fact; firstCreated?: Fact;
}
export interface TurnCoverageRun { conversation_id: string; generation: unknown; provider: string; type: string; native_id: string }
function inputOf(context: RunContext): StateInput {
  return context.input ??= { runId: context.id, turnId: null, process: null, parentProcessAtLaunch: 'independent', attempt: null, evidence: [] };
}

/** 事実の対応付けと時計は api が持ち、状態の意味は core の関数だけが決める。 */
export class CurrentState {
  private seq = -1;
  private dirty = true;
  private conflictPaths = new Set<string>();
  // 事実の多い実行の証拠の読み取りの続き。追記だけの次の差分で、新しい事実だけを読む。
  private evidenceStates = new Map<string, EvidenceState>();
  private nextEvaluation = 0;
  private contexts = new Map<string, RunContext>();
  private nativeById = new Map<string, Row>();
  private remote = new Set<string>();
  private owners = new Map<string, ProcessIdentity | null>();
  // 所持者が見つからなかった実行。新しい走査がその会話を含むか、未来の走査の時刻に達するまで照会し直さない。
  private recordedSessions = new Set<string>();
  private contextsChanged = true;
  private futureScanAt = Infinity;
  private providerScans = new Map<string, (SessionScan | undefined)[]>();
  private hasScans: boolean;
  private scanCache = new Map<string, SessionScan>();
  private scanStatements = new Map<string, StatementSync>();
  private scanQueries = new Map<string, SessionScan | undefined>();
  private scanHistory = new Map<string, SessionScan[]>();
  private scanIndexes = new WeakMap<SessionScan, { sessions: Map<string, SessionScan['sessions'][number]>; processes: Map<number, string | null> }>();
  private scanVersion = 0;
  // 実行ごとの今の行は文脈に置き、別の 1 万件の表を持たない。
  readonly runs = { get: (id: string): Row | undefined => { const context = this.contexts.get(id); return context?.state === undefined ? undefined : context as unknown as Row; } };
  private removedRuns: string[] = [];
  readonly conversations = new Map<string, Row>();
  evaluatedAt = 0;
  private db: DatabaseSync;
  private canonical: (id: string) => string;
  private scanWriter: boolean;
  constructor(db: DatabaseSync, canonical: (id: string) => string, scanWriter = false) {
    this.scanWriter = scanWriter;
    this.db = db; this.canonical = canonical;
    db.exec(`CREATE TABLE IF NOT EXISTS api_state_scans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_run_owners (run_id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS api_scan_time ON api_state_scans(json_extract(data, '$.at'));
      CREATE INDEX IF NOT EXISTS api_scan_provider_time ON api_state_scans(coalesce(json_extract(data, '$.provider'), 'claude'), json_extract(data, '$.at'));
      CREATE INDEX IF NOT EXISTS api_scan_provider_status_time ON api_state_scans(coalesce(json_extract(data, '$.provider'), 'claude'), json_extract(data, '$.status'), json_extract(data, '$.at'));
      CREATE INDEX IF NOT EXISTS api_history_conflicts ON facts(seq) WHERE kind = 'observation.unsupported';
      CREATE INDEX IF NOT EXISTS api_remote_conversation_subject ON facts(subject)
        WHERE kind GLOB 'conversation.*' AND json_type(payload, '$.connection_id') = 'text'`);
    this.hasScans = !!db.prepare('SELECT 1 FROM api_state_scans LIMIT 1').get();
    for (const row of db.prepare('SELECT * FROM api_run_owners').all()) {
      const owner = JSON.parse(String(row.data)) as ProcessIdentity | null;
      if (owner) {
        const conversation = String(row.run_id).replace(/:\d+$/, '');
        const provider = db.prepare('SELECT provider FROM conversations WHERE id = ?').get(conversation)?.provider;
        owner.procStart = normalizeProcessStart(owner.procStart, provider === 'codex' ? 'local' : 'UTC');
      }
      this.owners.set(String(row.run_id), owner);
      if (scanWriter && JSON.stringify(owner) !== row.data) db.prepare('UPDATE api_run_owners SET data = ? WHERE run_id = ?').run(JSON.stringify(owner), row.run_id);
    }
    if (scanWriter) for (const row of db.prepare('SELECT * FROM api_state_scans').all()) {
      const scan = this.normalizeScan(JSON.parse(String(row.data)));
      if (JSON.stringify(scan) !== row.data) db.prepare('UPDATE api_state_scans SET data = ? WHERE id = ?').run(JSON.stringify(scan), row.id);
    }
  }
  private normalizeScan(scan: SessionScan): SessionScan {
    return { ...scan, sessions: scan.sessions.map(row => ({ ...row, procStart: normalizeProcessStart(row.procStart, scan.provider === 'codex' ? 'local' : 'UTC') })),
      processes: scan.processes.map(row => ({ ...row, procStart: row.procStart === null ? null : normalizeProcessStart(row.procStart, 'local') })) };
  }
  get reevaluateAt(): number { return this.nextEvaluation; }
  readTurnCoverage(since: number, withoutRequest?: (run: TurnCoverageRun) => boolean): Record<string, { runs: number; missing: number; ratio: number }> {
    const coverage = { claude: { runs: 0, missing: 0, ratio: 0 }, codex: { runs: 0, missing: 0, ratio: 0 } };
    for (const context of this.contexts.values()) {
      const native = this.nativeById.get(context.conversation_id), provider = native?.provider;
      const at = Date.parse(String(context.last_evidence_ts ?? context.started_ts));
      if (provider !== 'claude' && provider !== 'codex' || !(at >= since && at <= this.evaluatedAt)) continue;
      // 信号の欠落から依頼の不在は証明できない。呼び出し側が台帳の外の独立した記録で依頼がないと示した実行だけを外す。
      if (!context.input?.turnId && withoutRequest?.({ conversation_id: context.conversation_id, generation: context.generation,
        provider, type: String(native!.type), native_id: String(native!.native_id) })) continue;
      const row = coverage[provider]; row.runs++;
      if (!context.input?.turnId) row.missing++;
    }
    for (const row of Object.values(coverage)) row.ratio = row.runs ? row.missing / row.runs : 0;
    return coverage;
  }
  invalidateFacts(): void { this.seq = -1; }
  recordScan(scan: SessionScan): void {
    scan = this.normalizeScan(scan);
    this.db.prepare('INSERT OR IGNORE INTO api_state_scans VALUES (?, ?)').run(scan.id, JSON.stringify(scan));
    this.hasScans = true; this.scanCache.clear();
    this.scanHistory.clear();
    for (const session of scan.sessions) this.recordedSessions.add(session.sessionId);
    this.scanVersion++;
    this.dirty = true;
  }
  refresh(seq: number, now = Date.now()): string[] {
    if (this.seq !== seq) { this.loadFacts(seq); this.seq = seq; this.dirty = true; }
    if (!this.dirty && now >= this.evaluatedAt && now < this.nextEvaluation) return [];
    this.dirty = false;
    this.scanQueries.clear();
    const futureScan = this.hasScans ? this.db.prepare("SELECT min(json_extract(data, '$.at')) AS at FROM api_state_scans WHERE json_extract(data, '$.at') > ?").get(now)?.at : null;
    this.futureScanAt = typeof futureScan === 'number' ? futureScan : Infinity;
    this.nextEvaluation = Infinity;
    this.evaluatedAt = now;
    const changed = new Set<string>();
    // 実行の id の違いしかない入力は、同じ判定と id を共有する。1 万件の実行に判定を 1 万個作らない。
    const shared = new Map<string, { decision: StateDecision; id: string }>();
    // 自身の証拠も所持者もない実行は、提供元の走査と、走査に含まれるかと所持の印だけで入力が決まる。
    // 同じ印の実行は入力を組み立てずに、最初に評価した実行の結果を使う。
    const plain = new Map<string, { decision: StateDecision; id: string; until: number }>();
    this.providerScans.clear();
    // 会話ごとの今の実行は、実行の組が変わったときだけ選び直す。選ぶ鍵は起動の時刻と世代で、状態には依らない。
    const reselect = this.contextsChanged;
    this.contextsChanged = false;
    if (reselect) this.conversations.clear();
    for (const [id, context] of this.contexts) {
      if (context.state !== undefined && context.evaluatedVersion === this.scanVersion && now >= context.evaluatedAt! && now < context.evaluatedUntil!) {
        this.nextEvaluation = Math.min(this.nextEvaluation, context.evaluatedUntil!);
        if (reselect) this.selectConversation(context as unknown as Row);
        continue;
      }
      const plainKey = this.plainInputKey(context, now);
      let evaluated = plainKey === undefined ? undefined : plain.get(plainKey);
      let turnStarted: string | null = null;
      let lastEvidence = context.started_ts;
      if (!evaluated) {
        const input = this.withScans(context, now);
        const key = sharedInputKey(input);
        let result = key === undefined ? undefined : shared.get(key);
        if (!result) {
          const decision = evaluateState(input, now);
          result = { decision, id: identifyDecision(decision, input) };
          if (key !== undefined) shared.set(key, result);
        }
        let until = typeof futureScan === 'number' ? futureScan : Infinity;
        for (const part of [result.decision.process, result.decision.hosting, result.decision.turn]) if (part.validUntil !== null && part.validUntil > now) until = Math.min(until, part.validUntil);
        for (const proof of input.evidence) for (const at of [proof.at, proof.observedAt]) if (at > now) until = Math.min(until, at);
        evaluated = { ...result, until };
        if (plainKey !== undefined) plain.set(plainKey, evaluated);
        const signals = input.evidence.filter((e): e is Signal => e.kind === 'signal' && e.turnId === input.turnId);
        const start = signals.filter(e => e.event === 'start').sort((a, b) => a.at - b.at)[0];
        const latest = signals.filter(e => e.at <= now).sort((a, b) => b.at - a.at)[0];
        if (['running', 'waiting_approval', 'waiting_input'].includes(result.decision.turn.value) && start) turnStarted = new Date(start.at).toISOString();
        if (latest) lastEvidence = new Date(latest.at).toISOString();
      }
      const { decision, until } = evaluated;
      this.nextEvaluation = Math.min(this.nextEvaluation, until);
      const reason = decision.turn.reason;
      // 配る欄と判定の id が同じなら変化として扱わない。走査の時刻や証拠の id だけの更新で全件を配り直さない。
      // 会話と世代は実行の id に含まれるので、ここで変わるのは開始時刻だけである。
      const stateChanged = context.state === undefined || context.ownDecisionId !== evaluated.id
        || context.turn_started_ts !== turnStarted || context.last_evidence_ts !== lastEvidence || context.reason !== reason
        || context.deliveredStarted !== context.started_ts;
      if (stateChanged) changed.add(id);
      // 行は文脈そのものなので、作り直さずに欄を書き換える。
      context.ownDecision = decision; context.ownDecisionId = evaluated.id;
      context.turn_started_ts = turnStarted;
      context.last_evidence_ts = lastEvidence; context.reason = reason; context.deliveredStarted = context.started_ts;
      context.evaluatedVersion = this.scanVersion; context.evaluatedAt = now; context.evaluatedUntil = until;
      if (reselect) this.selectConversation(context as unknown as Row);
    }
    const children = new Map<string, StateDecision[]>();
    for (const row of this.conversations.values()) {
      const child = row as unknown as RunContext;
      if (!child.parent || !child.ownDecision) continue;
      const group = children.get(child.parent) ?? [];
      group.push(child.ownDecision); children.set(child.parent, group);
    }
    for (const context of this.contexts.values()) {
      if (!context.ownDecision) continue;
      const decision = renderConversationState(context.ownDecision,
        this.conversations.get(context.conversation_id)?.id === context.id ? children.get(context.conversation_id) ?? [] : []);
      const id = decision === context.ownDecision ? context.ownDecisionId!
        : createHash('sha256').update(context.ownDecisionId! + ':waiting_agents').digest('hex').slice(0, 32);
      if (id !== context.decision_id) changed.add(context.id);
      context.decision = decision; context.decision_id = id;
      const state = DISPLAY_STATES[decision.display.label];
      context.state = state; context.activity_rank = PRIORITY.indexOf(state);
    }
    for (const id of this.removedRuns) changed.add(id);
    this.removedRuns = [];
    // 走査を記録した後の評価は全実行を通るので、ここで新しい会話の印を消してよい。
    this.recordedSessions.clear();
    if (this.scanWriter) {
      // 掃除は次の周期でもよい。書き込みの競合で api ごと落とさない。
      try { this.pruneScans(now); } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
      }
    }
    return [...changed];
  }
  private pruneScans(now: number): void {
    // 期限のない終了証拠など、今回の判定が実際に読んだ走査も残す。
    // 対象の最新登録と最新 busy は、後から届く実行の所持者・進行の照会にも使う。
    const removed = this.db.prepare(`WITH retained AS (
      SELECT id, row_number() OVER (
        PARTITION BY coalesce(json_extract(data, '$.provider'), 'claude'), json_extract(data, '$.status')
        ORDER BY json_extract(data, '$.at') DESC, id) AS position
      FROM api_state_scans
    ), sessions AS (
      SELECT scans.id, row_number() OVER (
        PARTITION BY coalesce(json_extract(data, '$.provider'), 'claude'), json_extract(data, '$.status'),
          json_extract(session.value, '$.sessionId'), json_extract(session.value, '$.status')
        ORDER BY json_extract(data, '$.at') DESC, scans.id) AS position
      FROM api_state_scans scans, json_each(data, '$.sessions') session
    ) DELETE FROM api_state_scans
      WHERE json_extract(data, '$.at') < ?
        AND id NOT IN (SELECT value FROM json_each(?))
        AND id NOT IN (SELECT id FROM retained WHERE position = 1)
        AND id NOT IN (SELECT id FROM sessions WHERE position = 1)`)
      .run(now - STATE_SCAN_RETENTION_MS, JSON.stringify([...this.scanCache.keys()]));
    if (removed.changes) this.scanHistory.clear();
  }
  private selectConversation(row: Row): void {
    const conversation = String(row.conversation_id);
    const previous = this.conversations.get(conversation);
    // hook の連番と履歴取り込みの時刻由来の世代は比較せず、起動の時刻を先に使う。
    const started = Date.parse(String(row.started_ts)) || 0;
    const before = Date.parse(String(previous?.started_ts)) || 0;
    if (!previous || previous.id === row.id || started > before || started === before && Number(row.generation) > Number(previous.generation)) this.conversations.set(conversation, row);
  }
  private loadFacts(seq: number): void {
    this.contextsChanged = true;
    // 行の写しは小さな固定の形で持つ。SQLite の行のまま 1 万件を持ち続けない。
    this.nativeById = new Map();
    for (const row of this.db.prepare('SELECT id, native_id, provider, type FROM conversations').iterate()) {
      this.nativeById.set(this.canonical(String(row.id)), { native_id: row.native_id, provider: intern(row.provider), type: intern(row.type) });
    }
    this.remote = new Set(this.db.prepare("SELECT DISTINCT subject FROM facts WHERE kind GLOB 'conversation.*' AND json_type(payload, '$.connection_id') = 'text'").all().map(row => this.canonical(String(row.subject).slice('conversation:'.length))));
    const delta = this.seq >= 0 && seq > this.seq ? this.db.prepare('SELECT kind, subject, supersedes FROM facts WHERE seq > ? AND seq <= ?').all(this.seq, seq) : undefined;
    const unsupported = this.db.prepare("SELECT * FROM facts WHERE kind = 'observation.unsupported' AND seq <= ?").all(seq)
      .map(row => ({ ...row, payload: row.payload ? JSON.parse(String(row.payload)) : null }) as Fact);
    const conflictsByPath = new Map<string, Fact[]>();
    for (const fact of orderActiveFacts(unsupported)) if (String(object(fact.payload).reason).startsWith('Conflicting history')) {
      const path = basename(String(object(fact.payload).file_path ?? ''));
      const matches = conflictsByPath.get(path) ?? []; matches.push(fact); conflictsByPath.set(path, matches);
    }
    const conflictPaths = new Set([...this.conflictPaths, ...conflictsByPath.keys()]);
    this.conflictPaths = new Set(conflictsByPath.keys());
    const incremental = delta && !delta.some(row => row.supersedes && row.kind !== 'observation.unsupported'
      || String(row.kind).startsWith('relation.') || String(row.kind).startsWith('connection.'));
    const changedSubjects = incremental ? new Set(delta.filter(row => String(row.kind).startsWith('run.')).map(row => String(row.subject))) : undefined;
    const changedConversations = new Set(delta?.filter(row => String(row.kind).startsWith('conversation.'))
      .map(row => this.canonical(String(row.subject).slice('conversation:'.length))));
    const previous = this.contexts;
    this.contexts = new Map();
    const subjects = new Map<string, RunContext[]>();
    const affected = new Set<RunContext>();
    const affectedConversations = new Set<string>();
    for (const row of this.db.prepare('SELECT conversation_id, generation, started_ts, pid, start_fingerprint FROM runs').iterate()) {
      const conversation = this.canonical(String(row.conversation_id));
      const id = `${conversation}:${row.generation}`;
      // 照会の外れは読み直しの後も使う。会話と開始時刻が変われば isKnownOwnerMiss が捨てる。
      const old = previous.get(id);
      // 欄は作るときに全部置く。後から足すと、1 万件の物に欄の配列を別に作り直す。
      const context: RunContext = { id, conversation_id: conversation, generation: row.generation,
        started_ts: row.started_ts, pid: row.pid, start_fingerprint: row.start_fingerprint,
        input: undefined, facts: undefined, records: undefined, files: undefined, parent: undefined, childId: undefined, inheritedEvidence: undefined,
        // 前に配った欄は変化の比較に使う。評価の時刻は引き継がず、読み直した実行は評価し直す。
        state: old?.state, decision: old?.decision, ownDecision: old?.ownDecision, ownDecisionId: old?.ownDecisionId, decision_id: old?.decision_id, turn_started_ts: old?.turn_started_ts,
        last_evidence_ts: old?.last_evidence_ts, reason: old?.reason, activity_rank: old?.activity_rank, deliveredStarted: old?.deliveredStarted,
        evaluatedVersion: undefined, evaluatedAt: undefined, evaluatedUntil: undefined,
        missNative: old?.missNative, missStarted: old?.missStarted, missUntil: old?.missUntil, firstFact: undefined, firstCreated: undefined };
      this.contexts.set(id, context);
      if (this.nativeById.get(conversation)?.type === 'subagent') inputOf(context).attempt = { id: null, requiredStage: 'unknown' };
    }
    for (const row of this.db.prepare('SELECT conversation_id, generation, subject_id FROM run_subjects').iterate()) {
      const context = this.contexts.get(`${this.canonical(String(row.conversation_id))}:${row.generation}`);
      if (context) { const key = `run:${row.subject_id}`; const list = subjects.get(key); if (list) list.push(context); else subjects.set(key, [context]); }
    }
    if (changedSubjects) {
      for (const [subject, contexts] of subjects) {
        if (contexts.some(context => changedConversations.has(String(context.conversation_id))
          || previous.get(context.id)?.files?.some(path => conflictPaths.has(path)))) changedSubjects.add(subject);
        for (const context of contexts) if (changedSubjects.has(subject) || !previous.has(String(context.id))) affected.add(context);
      }
      for (const context of affected) affectedConversations.add(context.conversation_id);
      for (const [id, context] of this.contexts) if (!affected.has(context) && previous.has(id)) this.contexts.set(id, previous.get(id)!);
    }
    // 全件を読み直すときは、全実行の集合を別に作らない。
    const affectedContexts: Iterable<RunContext> = changedSubjects ? affected : this.contexts.values();
    for (const id of previous.keys()) if (!this.contexts.has(id)) this.removedRuns.push(id);
    const columns = 'seq, fact_id, source, source_event_id, kind, subject, source_ts, observed_ts, confidence, supersedes, payload, cursor';
    const decode = (row: Record<string, SQLOutputValue>): Fact => { row.payload = row.payload ? JSON.parse(String(row.payload)) : null; return row as unknown as Fact; };
    const matchContexts = (candidates: RunContext[], fact: Fact): RunContext[] => {
      const generation = object(fact.payload).generation;
      return generation !== undefined ? candidates.filter(c => c.generation === generation)
        : candidates.filter(c => !c.started_ts || Date.parse(String(c.started_ts)) <= Date.parse(fact.source_ts)).sort((a, b) => Number(b.generation) - Number(a.generation)).slice(0, 1);
    };
    // 証拠の読み取りの続きを持つ実行は、前回の後に追記された事実だけを読む。会話の長い実行で、追記ごとに全事実を読み直さない。
    const continued = new Map<RunContext, Fact[]>();
    const continuedSubjects = new Set<string>();
    if (changedSubjects) {
      const candidates = [...changedSubjects].filter(subject => subjects.get(subject)?.length
        && subjects.get(subject)!.every(context => this.evidenceStates.get(context.id)?.seq === this.seq));
      const added = new Map<string, Fact[]>();
      if (candidates.length) for (const row of this.db.prepare(`SELECT ${columns} FROM facts WHERE seq > ? AND seq <= ? AND kind GLOB 'run.*'
        AND subject IN (SELECT value FROM json_each(?)) ORDER BY seq`).iterate(this.seq, seq, JSON.stringify(candidates))) {
        const fact = decode(row);
        const group = added.get(fact.subject) ?? []; group.push(...expandNativeEvidence(fact)); added.set(fact.subject, group);
      }
      for (const subject of candidates) {
        const facts = added.get(subject) ?? [];
        if (facts.some(fact => fact.supersedes)) continue;
        const assigned = new Map(subjects.get(subject)!.map(context => [context, [] as Fact[]]));
        const matched = new Map(subjects.get(subject)!.map(context => [context, [] as Fact[]]));
        for (const fact of facts) for (const context of matchContexts(subjects.get(subject)!, fact)) {
          matched.get(context)!.push(fact);
          if (hasEvidence(fact)) assigned.get(context)!.push(fact);
        }
        for (const [context, facts] of assigned) assigned.set(context, orderActiveFacts(facts));
        if (![...assigned].every(([context, facts]) => this.canContinue(this.evidenceStates.get(context.id)!, context, facts, matched.get(context)!, conflictsByPath))) continue;
        continuedSubjects.add(subject);
        for (const [context, facts] of assigned) continued.set(context, facts);
      }
    }
    const fresh = changedSubjects ? [...changedSubjects].filter(subject => !continuedSubjects.has(subject)) : undefined;
    const filter = changedSubjects ? ' AND subject IN (SELECT value FROM json_each(?))' : '';
    const scope = `FROM facts WHERE seq <= ? AND kind GLOB 'run.*'${filter}`;
    // orderActiveFacts と同じく、読んだ組の中で置き換えられた事実を先に除く。
    const superseded = fresh?.length === 0 ? new Set<string>() : new Set(this.db.prepare(`SELECT supersedes ${scope} AND supersedes IS NOT NULL AND supersedes != ''`)
      .all(...(fresh ? [seq, JSON.stringify(fresh)] : [seq])).map(row => String(row.supersedes)));
    // 全事実の配列は作らない。実行に残すのは、証拠を持つ事実と、開始時刻を事実から補う実行の事実だけにする。
    // 証拠を持たない事実は readEvidence で何も起こさないので、捨てても判定は変わらない。
    if (fresh?.length !== 0) for (const row of this.db.prepare(`SELECT ${columns} ${scope}`).iterate(...(fresh ? [seq, JSON.stringify(fresh)] : [seq]))) {
      if (superseded.has(String(row.fact_id))) continue;
      for (const fact of expandNativeEvidence(decode(row))) {
        if (superseded.has(fact.fact_id)) continue;
        if (!fact.kind.startsWith('run.')) continue;
        const matching = matchContexts(subjects.get(fact.subject) ?? [], fact);
        // 証拠を持つ事実だけを実行に残す。持たない事実は readEvidence で何も起こさない。
        if (hasEvidence(fact)) for (const context of matching) (context.facts ??= []).push(fact);
        let order: Fact | undefined;
        for (const context of matching) if (context.started_ts === null || context.started_ts === undefined) {
          // 並べ替えに使う欄だけを残す。同じ順位なら先に読んだ事実を残し、全体の安定な並べ替えと同じ結果にする。
          order ??= { fact_id: fact.fact_id, source: fact.source, source_event_id: fact.source_event_id, kind: fact.kind, source_ts: fact.source_ts } as Fact;
          if (!context.firstFact || orderActiveFacts([context.firstFact, order])[0] === order) context.firstFact = order;
          if (order.kind === 'run.created' && (!context.firstCreated || orderActiveFacts([context.firstCreated, order])[0] === order)) context.firstCreated = order;
        }
      }
    }
    const byConversation = new Map<string, RunContext[]>();
    for (const context of this.contexts.values()) {
      const group = byConversation.get(context.conversation_id) ?? [];
      group.push(context); byConversation.set(context.conversation_id, group);
    }
    for (const relation of this.db.prepare("SELECT * FROM relations WHERE type = 'delegated' AND active = 1 AND confidence = 'confirmed'").all()) {
      const child = this.canonical(String(relation.to_id));
      const parent = this.canonical(String(relation.from_id));
      for (const context of byConversation.get(child) ?? []) {
        context.parent = parent;
        const native = this.nativeById.get(child)?.native_id;
        context.childId = String(native ?? '').replace(/^agent-/, '');
        inputOf(context).parentProcessAtLaunch = null;
      }
    }
    if (!changedSubjects) this.evidenceStates.clear();
    for (const id of this.removedRuns) this.evidenceStates.delete(id);
    for (const context of affectedContexts) {
      const added = continued.get(context);
      if (added) {
        const state = this.evidenceStates.get(context.id)!;
        context.started_ts ??= state.derived?.startedTs;
        if (added.length) this.readEvidence(context, conflictsByPath, added, state);
        else this.applyEvidence(context, state);
        continue;
      }
      // 全体の安定な並べ替えを実行ごとに分けても、同じ実行の事実の順は変わらない。
      if (context.facts) context.facts = orderActiveFacts(context.facts);
      const derived = context.started_ts === null || context.started_ts === undefined
        ? { startedTs: context.firstCreated?.source_ts ?? context.firstFact?.source_ts, first: context.firstFact, created: context.firstCreated } : undefined;
      context.started_ts ??= context.firstCreated?.source_ts ?? context.firstFact?.source_ts;
      context.firstFact = context.firstCreated = undefined;
      this.evidenceStates.delete(context.id);
      if (context.facts?.some(hasEvidence)) {
        const state = createEvidenceState();
        state.derived = derived;
        this.readEvidence(context, conflictsByPath, context.facts, state);
        if (context.facts.length >= EVIDENCE_STATE_MIN_FACTS) this.evidenceStates.set(context.id, state);
      }
      context.facts = undefined;
    }
    // 事実の増えなかった実行の続きも、この位置までの読み取りとして扱う。
    for (const state of this.evidenceStates.values()) state.seq = seq;
    // 親の通知は task-id と子の既知の turn で対応させる。親の promptId は使わない。
    // 親の原記録は、名指しする子の id ごとに一度だけ分ける。子ごとに親の全記録を照合しない。
    const parentRecords = new Map<string, Map<string, NativeRecord[]>>();
    const recordsFor = (parent: string, childId: string | undefined): NativeRecord[] => {
      let index = parentRecords.get(parent);
      if (!index) {
        index = new Map();
        for (const record of (byConversation.get(parent) ?? []).flatMap(c => c.records ?? [])) {
          for (const id of new Set(readRecordChildIds(record.row))) {
            const group = index.get(id) ?? []; group.push(record); index.set(id, group);
          }
        }
        parentRecords.set(parent, index);
      }
      return childId === undefined ? [] : index.get(childId) ?? [];
    };
    for (const child of this.contexts.values()) {
      if (!child.parent || changedSubjects && !affected.has(child) && !affectedConversations.has(child.parent)) continue;
      child.evaluatedVersion = undefined;
      const childInput = inputOf(child);
      childInput.attempt = this.nativeById.get(child.conversation_id)?.type === 'subagent' ? { id: null, requiredStage: 'unknown' } : null;
      const records = recordsFor(child.parent, child.childId);
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
        inputOf(child).attempt = { id: JSON.stringify([record.runId, id, 1]), requiredStage: item.tool === 'spawnAgent' ? 'responded'
          : result.status === 'async_launched' && flag(result.isAsync) === true ? 'reported' : synchronous && result.status === 'completed' && flag(result.isAsync) !== true ? 'responded' : 'unknown' };
      }
      childInput.evidence = childInput.evidence.map(e => e.kind === 'signal' ? { ...e, attemptId: childInput.attempt?.id } : e);
      const starts = childInput.evidence.filter((e): e is Signal => e.kind === 'signal' && !!e.turnId).sort((a, b) => a.at - b.at);
      const additional = records.flatMap(record => {
        const turn = starts.findLast(start => start.at <= record.at);
        return readNativeEvidence({ ...record, source: record.source === 'codex' ? 'codex_child' : 'claude_child',
          id: `${record.id}:child:${childInput.runId}`, runId: childInput.runId!, turnId: turn?.turnId, childId: child.childId, attemptId: childInput.attempt?.id,
          row: { ...record.row, promptId: undefined } });
      });
      child.inheritedEvidence = additional;
    }
  }
  /** 前回の読み取りの後に、時刻の順で後に並ぶ事実だけが足されたかを確かめる。 */
  private canContinue(state: EvidenceState, context: RunContext, facts: Fact[], matched: Fact[], conflictsByPath: Map<string, Fact[]>): boolean {
    if (!state.exact) return false;
    if (context.started_ts === null || context.started_ts === undefined) {
      // 補った開始時刻は、より前に並ぶ事実や最初の run.created が届くと変わる。
      const derived = state.derived;
      if (!derived?.first) return false;
      for (const fact of matched) {
        const order = { fact_id: fact.fact_id, source: fact.source, source_event_id: fact.source_event_id, kind: fact.kind, source_ts: fact.source_ts } as Fact;
        if (orderActiveFacts([derived.first, order])[0] !== derived.first) return false;
        if (fact.kind === 'run.created' && (!derived.created || orderActiveFacts([derived.created, order])[0] !== derived.created)) return false;
      }
    }
    if (readConflictSignature(state.files, conflictsByPath) !== state.conflicts) return false;
    if (!facts.length) return true;
    if (state.last && orderActiveFacts([state.last, facts[0]])[0] !== state.last) return false;
    return facts.every(fact => {
      if (!Number.isFinite(Date.parse(fact.source_ts))) return false;
      const uuid = readClaudeUuid(fact);
      if (!uuid) return true;
      if (state.dangling.has(uuid)) return false;
      // 既知の uuid を別の親や turn で読み直すと、先に読んだ記録の祖先の turn が変わり得る。
      const row = object(object(object(fact.payload).last_evidence).native_record), own = readNativeTurnId('claude', row);
      return !state.parents.has(uuid) || state.parents.get(uuid) === string(row.parentUuid) && (!own || state.prompts.get(uuid) === own);
    });
  }
  /** facts は時刻の順に並べた、state の続きの事実。 */
  private readEvidence(context: RunContext, conflictsByPath: Map<string, Fact[]>, facts: Fact[], state: EvidenceState): void {
    const evidence: StateEvidence[] = [];
    for (const fact of facts) { const file = string(object(object(fact.payload).last_evidence).file_id); if (file) state.files.add(file); }
    const { turns, calls, codexTurns, tools, parents, prompts } = state;
    // 原記録の時刻は親子の順と一致しない。tool_result より前の時刻の PostToolUse が先に並ぶため、
    // 親を読む前でも祖先の promptId を辿れるよう、uuid の辺を先に集める。
    for (const fact of facts) {
      const last = object(object(fact.payload).last_evidence), row = object(last.native_record), uuid = string(row.uuid);
      if (last.native_source !== 'claude' || !uuid) continue;
      parents.set(uuid, string(row.parentUuid));
      const own = readNativeTurnId('claude', row);
      if (own) prompts.set(uuid, own);
    }
    // 祖先が未知の uuid で途切れる記録は、その uuid が後から届くと turn が変わり得る。続きを使わない印にする。
    for (const parent of parents.values()) if (parent && !parents.has(parent)) state.dangling.add(parent);
    const ancestorTurn = (uuid: string): string | undefined => {
      const seen = new Set<string>();
      for (let id: string | undefined = uuid; id && !seen.has(id); id = parents.get(id)) {
        seen.add(id);
        const turn = turns.get(id) ?? prompts.get(id);
        if (turn) return turn;
      }
    };
    for (const fact of facts) {
      const payload = object(fact.payload), last = object(payload.last_evidence);
      const at = Date.parse(fact.source_ts), observedAt = Date.parse(fact.observed_ts);
      let source = string(last.native_source) as NativeRecord['source'] | undefined;
      let row = object(last.native_record);
      if (fact.source === 'hook' && last.auxiliary !== true && last.hook_event_name) {
        source = 'hook'; row = { ...object(last.input), hook_event_name: last.hook_event_name };
      }
      // 子の開始・停止だけを除く。agent_id 付きの承認通知などは親自身の証拠にする。
      if (source === 'hook' && string(row.agent_id) && ['SubagentStart', 'SubagentStop'].includes(String(row.hook_event_name))) continue;
      const end = object(payload.end_evidence);
      if (fact.confidence === 'confirmed' && fact.source.startsWith('host-') && end.kind === 'host_exit')
        evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.id, event: 'exit' });
      if (fact.confidence === 'confirmed' && end.kind === 'archived' && fact.source === 'rollout-codex')
        evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.id, event: 'archive' });
      if (!source && fact.source === 'host-claude' && last.kind === 'result') {
        source = 'claude_sdk'; row = { type: 'result', ...(last.outcome === 'interrupted' ? {} : { is_error: last.outcome === 'failed' }) };
        if (last.outcome === 'interrupted') { evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.id, turnId: string(last.turn_id), event: 'complete' }); continue; }
      }
      if (!source && fact.source.startsWith('host-')) {
        // ホストが保存した turn 相関付きの事実だけを入力にする。
        const turnId = string(payload.turn_id) ?? string(last.turn_id);
        const event = fact.kind === 'run.interrupt_requested' ? 'interrupt_request'
          : payload.state === 'running' ? 'start' : payload.state === 'idle' ? 'complete'
            : payload.state === 'waiting_approval' ? 'approval' : payload.state === 'waiting_input' ? 'input' : undefined;
        if (event) evidence.push({ kind: 'signal', id: fact.fact_id, at, observedAt, runId: context.id, turnId, event });
      }
      if (!source) continue;
      let turnId = readNativeTurnId(source, row) ?? (fact.source.startsWith('host-') ? string(last.turn_id) : undefined);
      if (source === 'codex') {
        const file = String(last.file_id ?? fact.subject);
        if (row.type === 'turn_context' && turnId) codexTurns.set(file, turnId);
        else turnId ??= codexTurns.get(file);
      }
      const parent = string(row.parentUuid);
      if (!turnId && parent) turnId = ancestorTurn(parent);
      const blocks = object(row.message).content;
      if (!turnId && Array.isArray(blocks)) {
        const ids = new Set(blocks.map(b => tools.get(String(object(b).tool_use_id))).filter(Boolean));
        if (ids.size === 1) turnId = [...ids][0];
      }
      const record: NativeRecord = { id: fact.fact_id, at, observedAt, source, runId: context.id, row, turnId };
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
      const internalNotification = String(row.content ?? JSON.stringify(blocks)).includes('<task-notification>');
      // 親子相関のない本文・tool・UUID の辺は、この読み取りが終わったら保持しない。
      const item = object(object(row.params).item), activity = object(object(row.payload).item);
      if (string(object(row.toolUseResult).agentId) || internalNotification
        || item.type === 'collabAgentToolCall' || activity.type === 'SubAgentActivity') state.records.push(record);
      for (const conflict of conflictsByPath.get(String(last.file_id)) ?? []) {
        const rows = object(conflict.payload).rows;
        if (turnId && Array.isArray(rows) && rows.some(value => {
          const location = object(value);
          return location.turn_id === turnId || location.at === fact.source_ts
            && (location.uuid ? location.uuid === row.uuid
              : location.offset !== undefined && fact.cursor && location.offset === object(JSON.parse(fact.cursor)).offset);
        })) evidence.push({ kind: 'conflict', id: `${conflict.fact_id}:turn:${turnId}`, at: Date.parse(conflict.source_ts),
          observedAt: Date.parse(conflict.observed_ts), runId: context.id, turnId, count: Number(object(conflict.payload).count ?? 1) });
      }
      if (!internalNotification) evidence.push(...readNativeEvidence(record));
    }
    state.evidence = [...state.evidence, ...evidence];
    if (state.exact && evidence.every(e => Number.isFinite(e.at))) {
      // 並べ替えの先頭と同じく、開始は時刻と id の大きいもの、鍵付きの信号は時刻が最大のうち先のものを選ぶ。
      for (const e of evidence) if (e.kind === 'signal' && e.turnId) {
        if (!state.keyed || e.at > state.keyed.at) state.keyed = e;
        if (e.event === 'start' && (!state.start || e.at > state.start.at || e.at === state.start.at && e.id.localeCompare(state.start.id) > 0)) state.start = e;
      }
    } else {
      // 解釈できない時刻を含む並べ替えは比較が一貫しない。従来の並べ替えに任せ、以後は続きを使わない。
      state.exact = false;
      state.start = state.evidence.filter((e): e is Signal => e.kind === 'signal' && e.event === 'start' && !!e.turnId).sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))[0];
      state.keyed = state.evidence.filter((e): e is Signal => e.kind === 'signal' && !!e.turnId).sort((a, b) => b.at - a.at)[0];
    }
    const last = facts.at(-1);
    if (last) state.last = { fact_id: last.fact_id, source: last.source, source_event_id: last.source_event_id, kind: last.kind, source_ts: last.source_ts } as Fact;
    state.conflicts = readConflictSignature(state.files, conflictsByPath);
    this.applyEvidence(context, state);
  }
  private applyEvidence(context: RunContext, state: EvidenceState): void {
    context.files = [...state.files];
    context.records = state.records.length ? state.records : undefined;
    const input = inputOf(context);
    input.turnId = state.start?.turnId ?? state.keyed?.turnId ?? null;
    input.evidence = state.evidence;
  }
  private readScan(provider: string, where: string, values: SQLInputValue[], first = false, cache = true): SessionScan | undefined {
    const key = cache ? JSON.stringify([provider, where, values, first]) : '';
    if (cache && this.scanQueries.has(key)) return this.scanQueries.get(key);
    const sql = `SELECT id, data FROM api_state_scans WHERE coalesce(json_extract(data, '$.provider'), 'claude') = ? AND ${where}
      ORDER BY json_extract(data, '$.at') ${first ? 'ASC' : 'DESC'}, id LIMIT 1`;
    let statement = this.scanStatements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.scanStatements.set(sql, statement); }
    const row = statement.get(provider, ...values);
    if (!row) { if (cache) this.scanQueries.set(key, undefined); return; }
    let scan = this.scanCache.get(String(row.id));
    if (!scan) { scan = this.normalizeScan(JSON.parse(String(row.data))); this.scanCache.set(scan.id, scan); }
    if (cache) this.scanQueries.set(key, scan);
    return scan;
  }
  private indexScan(scan: SessionScan) {
    let index = this.scanIndexes.get(scan);
    if (!index) {
      index = { sessions: new Map(scan.sessions.map(row => [row.sessionId, row])), processes: new Map(scan.processes.map(row => [row.pid, row.procStart])) };
      this.scanIndexes.set(scan, index);
    }
    return index;
  }
  /** JSON の展開と PID/session の探索は走査ごとに一度だけ行う。 */
  private findScan(provider: string, matches: (scan: SessionScan) => boolean, first = false): SessionScan | undefined {
    let scans = this.scanHistory.get(provider);
    if (!scans) {
      scans = this.db.prepare(`SELECT data FROM api_state_scans WHERE coalesce(json_extract(data, '$.provider'), 'claude') = ?
        ORDER BY json_extract(data, '$.at') DESC, id`).all(provider).map(row => this.normalizeScan(JSON.parse(String(row.data))));
      this.scanHistory.set(provider, scans);
    }
    const scan = first ? scans.findLast(matches) : scans.find(matches);
    if (scan) this.scanCache.set(scan.id, scan);
    return scan;
  }
  /** 提供元ごとの最新の走査と、成功した最新の走査。評価の間は同じ値を使う。 */
  private readProviderScans(provider: string, now: number): (SessionScan | undefined)[] {
    let scans = this.providerScans.get(provider);
    if (!scans) {
      scans = [this.readScan(provider, "json_extract(data, '$.at') <= ?", [now]),
        this.readScan(provider, "json_extract(data, '$.status') = 'succeeded' AND json_extract(data, '$.at') <= ?", [now])];
      this.providerScans.set(provider, scans);
    }
    return scans;
  }
  private isKnownOwnerMiss(context: RunContext, native: Row, started: number, now: number): boolean {
    return !context.parent && context.missUntil !== undefined && context.missNative === native.native_id && Object.is(context.missStarted, started)
      && now < context.missUntil && !this.recordedSessions.has(String(native.native_id));
  }
  /**
   * withScans が自身の証拠もプロセスも所持者もない入力を作る実行に、その入力を決める印を返す。
   * 印が同じ実行は、実行の id を除いて同じ入力になる。それ以外の実行には undefined を返す。
   */
  private plainInputKey(context: RunContext, now: number): string | undefined {
    const input = context.input;
    if (context.parent || input && (input.evidence.length || input.attempt || input.turnId !== null || input.parentProcessAtLaunch !== 'independent')) return;
    if (typeof context.pid === 'number' && typeof context.start_fingerprint === 'string') return;
    if (!this.hasScans) return 'none';
    const conversation = String(context.conversation_id);
    if (this.remote.has(conversation)) return 'none';
    const native = this.nativeById.get(conversation);
    if (!native || !['claude', 'codex'].includes(String(native.provider))) return 'none';
    const started = Date.parse(String(context.started_ts ?? ''));
    if (this.owners.has(String(context.id)) || !this.isKnownOwnerMiss(context, native, started, now)) return;
    let key = String(native.provider);
    const [latest, good] = this.readProviderScans(String(native.provider), now);
    // withScans と同じく、同じ走査は一度だけ数える。
    for (const scan of [latest, good?.id === latest?.id ? undefined : good]) {
      if (!scan) continue;
      const index = this.indexScan(scan);
      const session = scan.at < started ? undefined : index.sessions.get(String(native.native_id));
      const hosted = !!session && index.processes.get(session.pid) === session.procStart;
      key += `\u0000${scan.id}\u0000${scan.at < started ? 'before' : hosted ? 'hosted' : 'not_hosted'}`;
    }
    return key;
  }
  private withScans(context: RunContext, now: number): StateInput {
    const base = context.input;
    const input: StateInput & { evidence: StateEvidence[] } = base ? { ...base, evidence: [...base.evidence, ...(context.inheritedEvidence ?? [])] }
      : { runId: context.id, turnId: null, process: null, parentProcessAtLaunch: 'independent', attempt: null, evidence: [] };
    if (typeof context.pid === 'number' && typeof context.start_fingerprint === 'string') input.process = { pid: context.pid, procStart: context.start_fingerprint };
    if (input.process && !context.parent) input.evidence = input.evidence.map(e => e.kind === 'signal' && e.event === 'exit' ? { ...e, process: input.process! } : e);
    if (!this.hasScans) return input;
    const conversation = context.parent ?? String(context.conversation_id);
    if (this.remote.has(conversation)) return input;
    const native = this.nativeById.get(conversation);
    if (!native || !['claude', 'codex'].includes(String(native.provider))) return input;
    const provider = String(native.provider);
    const successful = (scan: SessionScan) => scan.status === 'succeeded' && scan.at <= now;
    const [latest, good] = this.readProviderScans(provider, now);
    const started = Date.parse(String(context.started_ts ?? ''));
    let owner: ProcessIdentity | null = this.owners.get(input.runId!) ?? input.process;
    const knownMiss = this.isKnownOwnerMiss(context, native, started, now);
    if (!this.owners.has(input.runId!) && !knownMiss) {
      // 起動前に観測した親だけを固定する。既存の子を現在の親で補わない。
      const scan = this.findScan(provider, scan => successful(scan)
        && (this.indexScan(scan).sessions.get(String(native.native_id))?.startedAt ?? Infinity) <= started
        && (!context.parent || scan.at <= started && scan.at > started - SESSION_SCAN_VALID_MS));
      const session = scan && this.indexScan(scan).sessions.get(String(native.native_id));
      if (session) owner = { pid: session.pid, procStart: session.procStart };
      if (owner || context.parent) {
        // 保存できなくても今回の判定は進める。起動し直した後は所持者が不明になり、安全な側に倒れる。
        try { this.db.prepare('INSERT OR IGNORE INTO api_run_owners VALUES (?, ?)').run(input.runId!, JSON.stringify(owner)); } catch (error) {
          if ((error as { errcode?: number }).errcode !== 5) throw error;
        }
        this.owners.set(input.runId!, owner);
        context.missNative = context.missStarted = context.missUntil = undefined;
      } else { context.missNative = native.native_id; context.missStarted = started; context.missUntil = this.futureScanAt; }
    }
    const current = good && this.indexScan(good).sessions.get(String(native.native_id));
    input.process = context.parent && current ? { pid: current.pid, procStart: current.procStart } : owner;
    input.parentProcessAtLaunch = context.parent ? owner : 'independent';
    if (owner && !context.parent) input.evidence = input.evidence.map(e => e.kind === 'signal' && e.event === 'exit' ? { ...e, process: owner! } : e);
    const absent = owner ? this.findScan(provider, scan => successful(scan) && scan.at >= started
      && this.indexScan(scan).processes.get(owner.pid) !== null && this.indexScan(scan).processes.get(owner.pid) !== owner.procStart, true) : undefined;
    const start = input.evidence.filter((e): e is Signal => e.kind === 'signal' && e.event === 'start' && e.turnId === input.turnId).sort((a, b) => b.at - a.at)[0];
    const busy = start && !context.parent ? this.findScan(provider, scan => {
      const session = this.indexScan(scan).sessions.get(String(native.native_id));
      return scan.at <= now && scan.at >= started && session?.status === 'busy' && (session.statusUpdatedAt ?? -Infinity) >= start.at;
    }) : undefined;
    // 最新の健康・所持と、物理終了の最初の証拠だけで判定する。参照した走査は期限後も DB に残す。
    const scans = new Map([latest, good, absent, busy].filter((scan): scan is SessionScan => !!scan).map(scan => [scan.id, scan]));
    for (const scan of scans.values()) {
      if (scan.at < started) continue;
      const index = this.indexScan(scan), session = index.sessions.get(String(native.native_id));
      const processes = input.process && index.processes.has(input.process.pid)
        ? [{ pid: input.process.pid, procStart: index.processes.get(input.process.pid)! }] : [];
      const proof: Scan = { kind: 'scan', id: scan.id, at: scan.at, observedAt: scan.at, source: `${native.provider}_sessions`, scope: 'local',
        subjects: [input.runId!], status: scan.status, validForMs: SESSION_SCAN_VALID_MS, processes,
        hosted: session && index.processes.get(session.pid) === session.procStart ? [input.runId!] : [] };
      input.evidence.push(proof);
      if (session && !context.parent && start && session.statusUpdatedAt !== undefined && session.statusUpdatedAt >= start.at) input.evidence.push(...readNativeEvidence({ id: `${scan.id}:busy:${input.runId}`, at: scan.at, observedAt: scan.at,
        source: 'claude_session', runId: input.runId!, turnId: input.turnId, row: { ...session } }));
    }
    return input;
  }
}
