import type { Row, ScreenState } from './store.ts';

// 画面に出す名前と要約を作る。生の識別子や JSON は画面に出さない。
function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
function object(value: unknown): Row {
  const decoded = decode(value);
  return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Row : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

export function readTitle(value: unknown): string {
  const name = text(value).trim();
  return /^Untitled(?: task| conversation)?$/i.test(name) ? '' : name;
}

// 台帳の理由は機械向けの語で書かれる。人が読む文に置き換え、置き換えられない機械語は出さない。
export function approvalReasonText(reason: string): string {
  if (/patch_hash|patch changed/i.test(reason)) return 'The patch changed after this request.';
  if (/expired|timeout/i.test(reason)) return 'The request expired before an answer was sent.';
  return /^[a-z0-9_.:-]+(?: [a-z0-9_.:-]+)*$/.test(reason) && /[_:.]/.test(reason) ? '' : reason;
}

export function splitPath(path: string): string[] { return path.split(/[\\/]+/).filter(Boolean); }

/** プロジェクトの主の名前はリポジトリの名前とし、従の表示は親の場所を短く出す。 */
export function projectLabel(path: string): { name: string; detail: string; full: string } {
  const parts = splitPath(path);
  if (!path.includes('/') && !path.includes('\\')) return { name: path || 'No project', detail: '', full: path };
  const name = parts.at(-1) ?? path;
  const parents = parts.slice(0, -1);
  const home = parents[0] === 'Users' || parents[0] === 'home' ? 2 : 0;
  const detail = home && parents.length <= 4 ? `~/${parents.slice(home).join('/')}`
    : parents.length > 2 ? `…/${parents.slice(-2).join('/')}` : `/${parents.join('/')}`;
  return { name, detail: detail === '~/' ? '~' : detail, full: path };
}

/** 作業ツリーは場所の末尾と枝の名前で出す。 */
export function worktreeLabel(run?: Row): { place: string; branch: string; full: string } | undefined {
  if (!run) return;
  const launch = object(run.launch);
  const full = text(run.cwd) || text(launch.cwd);
  const branch = text(run.branch);
  if (!full && !branch) return;
  return { place: splitPath(full).at(-1) ?? full, branch, full };
}

export function readModel(run?: Row): { model: string; effort: string } {
  const launch = object(run?.launch);
  const model = object(launch.model);
  return { model: text(model.model), effort: text(model.effort) };
}

export function conversationName(state: ScreenState, conversationId: string, preference: 'task' | 'conversation' = 'task', visited = new Set<string>()): string {
  if (visited.has(conversationId)) return '';
  visited.add(conversationId);
  const review = state.projection.relations?.find(row => row.type === 'review_of' && row.from_id === conversationId
    && (row.active === true || row.active === 1) && row.confidence === 'confirmed');
  if (review) {
    const original = conversationName(state, text(review.to_id), 'task', visited);
    if (original) return `Review of ${original}`;
  }
  const conversation = state.projection.conversations?.find(row => row.id === conversationId);
  if (!conversation) return '';
  const task = state.projection.tasks?.find(row => row.id === conversation.task_id);
  const taskName = readTitle(task?.name);
  const name = readTitle(conversation.name);
  const provisional = text(conversation.first_request_excerpt) || text(task?.purpose);
  return preference === 'conversation' || conversation.type === 'subagent' ? name || taskName || provisional : taskName || name || provisional;
}

/** 実行は会話の名前と世代で呼ぶ。 */
export function runLabel(state: ScreenState, runId: unknown): string {
  const run = state.projection.runs?.find(row => row.id === runId);
  if (!run) return 'Unknown run';
  const name = conversationName(state, text(run.conversation_id)) || 'Untitled conversation';
  return run.generation === undefined || run.generation === null ? name : `${name} · Run ${String(run.generation)}`;
}

export function formatClock(value: unknown): string {
  const time = typeof value === 'string' ? new Date(value) : undefined;
  if (!time || !Number.isFinite(time.getTime())) return '';
  const today = new Date().toDateString() === time.toDateString();
  return time.toLocaleString(undefined, today ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

const DECISION_LABELS: Record<string, string> = {
  allow: 'Allow', deny: 'Deny', accept: 'Accept', decline: 'Decline', cancel: 'Cancel',
  acceptForSession: 'Accept for session', allow_for_session: 'Allow for session', allowForSession: 'Allow for session',
};
export function decisionLabel(decision: string): string {
  return DECISION_LABELS[decision] ?? decision.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase());
}
export function isPositiveDecision(decision: string): boolean { return /^(allow|accept|approve)/i.test(decision); }

/** 根拠は種類の名前で呼ぶ。事実の ID より種類を優先する。 */
export function evidenceLabel(value: unknown): string {
  const decoded = decode(value);
  if (typeof decoded === 'string') return decoded;
  const evidence = object(decoded);
  const kind = text(evidence.kind) || text(evidence.outcome);
  if (kind) return kind.replace(/[._]+/g, ' ');
  return text(evidence.fact_id);
}

export interface ApprovalRequest { tool: string; summary: string; command?: string; file?: string; diff?: string; fields: [string, unknown][] }
const HIDDEN_FIELDS = new Set(['threadId', 'turnId', 'itemId', 'tool_use_id', 'availableDecisions', 'command', 'diff', 'patch', 'file_path',
  'old_string', 'new_string', 'changes', 'fileChanges', 'description', 'reason', 'name', 'input']);
function prefix(lines: string, mark: string): string { return lines.split('\n').map(line => `${mark}${line}`).join('\n'); }
/** Claude の道具の入力と Codex の承認の要求を、同じ形に読み替える。 */
export function readApprovalRequest(value: unknown): ApprovalRequest {
  const request = object(value);
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input) ? request.input as Row : request;
  const rawCommand = input.command;
  const command = Array.isArray(rawCommand) ? rawCommand.map(String).join(' ') : typeof rawCommand === 'string' ? rawCommand : undefined;
  const file = text(input.file_path) || text(input.path) || undefined;
  const rawDiff = input.diff ?? input.patch ?? request.changes ?? request.fileChanges;
  let diff = typeof rawDiff === 'string' ? rawDiff : undefined;
  if (diff === undefined && (input.old_string !== undefined || input.new_string !== undefined)) {
    diff = [text(input.old_string) && prefix(text(input.old_string), '-'), text(input.new_string) && prefix(text(input.new_string), '+')].filter(Boolean).join('\n');
  } else if (diff === undefined && typeof input.content === 'string' && file) diff = prefix(input.content, '+');
  const tool = text(request.name) || (command !== undefined ? 'Command' : diff !== undefined ? 'File change' : 'Request');
  const summary = text(input.description) || text(request.reason) || text(input.reason) || (file ? splitPath(file).at(-1)! : '');
  const fields = Object.entries(input).filter(([key, entry]) => !HIDDEN_FIELDS.has(key) && entry !== undefined && entry !== null && !(key === 'content' && diff !== undefined));
  return { tool, summary, command, file, diff, fields };
}
export function summarizeApproval(value: unknown): string {
  const request = readApprovalRequest(value);
  const detail = request.command ?? (request.file ? splitPath(request.file).at(-1) : '') ?? request.summary;
  return detail ? `${request.tool}: ${detail}` : request.tool;
}

const PENDING_STATES = new Set(['pending', 'requested', 'waiting', 'waiting_approval']);
export type ApprovalOutcome = 'pending' | 'answered' | 'allowed' | 'denied' | 'expired' | 'stale' | 'resolved';
/** 承認の結果を 1 つの語に決める。期限切れと無効は回答より優先し、回答があれば許可か拒否かで分ける。 */
export function approvalOutcome(row: Row, answered = false): ApprovalOutcome {
  const state = text(row.state);
  if (state === 'expired') return 'expired';
  if (state === 'stale') return 'stale';
  const decision = text(row.decision);
  if (decision) return isPositiveDecision(decision) ? 'allowed' : 'denied';
  if (PENDING_STATES.has(state)) return answered ? 'answered' : 'pending';
  return 'resolved';
}
