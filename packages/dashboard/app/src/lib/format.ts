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
  // 名前に紛れた XML 風の札は外し、中の語だけを残す。
  const name = text(value).replace(/<\/?[a-z][\w-]*>/gi, ' ').replace(/\s+/g, ' ').trim();
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

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
export function providerName(provider: string): string { return PROVIDER_NAMES[provider] ?? provider; }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatLabelTime(value: unknown, now: number): string {
  const time = new Date(text(value));
  if (!Number.isFinite(time.getTime())) return '';
  const clock = `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`;
  return new Date(now).toDateString() === time.toDateString() ? clock : `${MONTHS[time.getMonth()]} ${time.getDate()} ${clock}`;
}
function parseTime(value: unknown): Date | undefined {
  const time = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  return time && Number.isFinite(time.getTime()) ? time : undefined;
}
/** 時刻は短く出す。今日なら「8:45」、昨日なら「Yesterday 8:45」、それより前は「Oct 6」とする。 */
export function formatWhen(value: unknown, language: 'en' | 'ja' = 'en', now = Date.now()): string {
  const time = parseTime(value);
  if (!time) return '';
  const clock = `${time.getHours()}:${String(time.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  if (today.toDateString() === time.toDateString()) return clock;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (yesterday.toDateString() === time.toDateString()) return language === 'ja' ? `昨日 ${clock}` : `Yesterday ${clock}`;
  const sameYear = today.getFullYear() === time.getFullYear();
  if (language === 'ja') return `${sameYear ? '' : `${time.getFullYear()}年`}${time.getMonth() + 1}月${time.getDate()}日`;
  return `${MONTHS[time.getMonth()]} ${time.getDate()}${sameYear ? '' : `, ${time.getFullYear()}`}`;
}
/** 経過は「3 min ago」の形で出す。1 日を超えたら formatWhen に任せる。 */
export function formatAgo(value: unknown, language: 'en' | 'ja' = 'en', now = Date.now()): string {
  const time = parseTime(value);
  if (!time) return '';
  const seconds = Math.max(0, Math.floor((now - time.getTime()) / 1000));
  const ja = language === 'ja';
  if (seconds < 60) return ja ? 'たった今' : 'just now';
  if (seconds < 3600) return ja ? `${Math.floor(seconds / 60)} 分前` : `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return ja ? `${Math.floor(seconds / 3600)} 時間前` : `${Math.floor(seconds / 3600)} h ago`;
  return formatWhen(time, language, now);
}
const MODEL_FAMILIES: Record<string, string> = { gpt: 'GPT', claude: 'Claude', o: 'o' };
/** モデル名は人の読む形にする。「claude-opus-5-5」は「Claude Opus 5.5」、「gpt-6.1-sol」は「GPT-6.1 Sol」とする。 */
export function modelName(model: string): string {
  const value = model.trim();
  if (!value) return '';
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(value);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const claudeOld = /^claude-(\d+)(?:-(\d))?-([a-z]+)(?:-\d{8})?$/i.exec(value);
  if (claudeOld) return `Claude ${claudeOld[3][0].toUpperCase()}${claudeOld[3].slice(1)} ${claudeOld[1]}${claudeOld[2] ? `.${claudeOld[2]}` : ''}`;
  const claudeBare = /^claude-([a-z]+)$/i.exec(value);
  if (claudeBare) return `Claude ${claudeBare[1][0].toUpperCase()}${claudeBare[1].slice(1)}`;
  const gpt = /^gpt-([\d.]+[a-z]?)(?:-(.+))?$/i.exec(value);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ' ' + gpt[2].split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ') : ''}`;
  const family = /^([a-z]+)-(.+)$/i.exec(value);
  if (family && MODEL_FAMILIES[family[1].toLowerCase()]) return `${MODEL_FAMILIES[family[1].toLowerCase()]} ${family[2]}`;
  return value;
}
/** 相手の名前。モデルが分かればモデルの名前を、分からなければ provider の名前を出す。 */
export function agentName(provider: string, model?: string): string {
  const name = modelName(model ?? '');
  if (name && (name.startsWith('Claude') || name.startsWith('GPT') || !provider)) return name;
  return [providerName(provider), name].filter(Boolean).join(' ');
}
/** 会話の始まりは最初の実行の開始とし、実行がなければ最後の発言の時刻を使う。 */
export function conversationStart(state: ScreenState, conversationId: string): string {
  const starts = (state.projection.runs ?? []).filter(row => row.conversation_id === conversationId)
    .map(row => text(row.started_ts)).filter(Boolean).sort();
  return starts[0] ?? text(state.projection.conversations?.find(row => row.id === conversationId)?.last_message_ts);
}
/** 名前は core の投影の値をそのまま出す。名前のない会話は provider と始まりの時刻で呼び、本文から名前を導かない。 */
export function conversationTitle(conversation: Row | undefined, startedAt?: unknown, now = Date.now()): string {
  const name = readTitle(conversation?.name);
  if (name) return name;
  const provider = providerName(text(conversation?.provider)) || 'Conversation';
  const time = formatLabelTime(startedAt, now);
  return time ? `${provider} · ${time}` : provider;
}
export function isProvisionalName(conversation: Row | undefined): boolean {
  return Boolean(readTitle(conversation?.name)) && (conversation?.name_is_provisional === true || conversation?.name_is_provisional === 1);
}

export function conversationName(state: ScreenState, conversationId: string, visited = new Set<string>()): string {
  if (visited.has(conversationId)) return '';
  visited.add(conversationId);
  const review = state.projection.relations?.find(row => row.type === 'review_of' && row.from_id === conversationId
    && (row.active === true || row.active === 1) && row.confidence === 'confirmed');
  if (review) {
    const original = conversationName(state, text(review.to_id), visited);
    if (original) return `Review of ${original}`;
  }
  const conversation = state.projection.conversations?.find(row => row.id === conversationId);
  return conversation ? conversationTitle(conversation, conversationStart(state, conversationId)) : '';
}

/** 実行は会話の名前と世代で呼ぶ。 */
export function runLabel(state: ScreenState, runId: unknown): string {
  const run = state.projection.runs?.find(row => row.id === runId);
  if (!run) return 'Unknown run';
  const name = conversationName(state, text(run.conversation_id)) || 'Untitled conversation';
  return run.generation === undefined || run.generation === null ? name : `${name} · Run ${String(run.generation)}`;
}

export function formatClock(value: unknown): string {
  return typeof value === 'string' ? formatWhen(value) : '';
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
