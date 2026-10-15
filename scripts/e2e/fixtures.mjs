import { stateNow } from './clock.mjs';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export const CLAUDE_VERSION = '2.1.299';
export const CLAUDE_MODELS = [
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Synthetic Sonnet' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Synthetic Haiku' },
];
export const CLAUDE_MODEL_IDS = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };
export const DAY_MS = 86_400_000;
export const REPLY_PREFIX = 'E2E reply: ';
export const COMPACT_SUMMARY = 'This session is being continued from a previous conversation. E2E synthetic compact summary.';

export class Transcript {
  constructor(provider, env, { id = randomUUID(), model, historyAgeMs = 0, parentSessionId } = {}) {
    this.parentSessionId = parentSessionId; this.provider = provider; this.env = env; this.id = id; this.parent = null;
    this.cwd = env.E2E_PROJECT; this.model = model || (provider === 'claude' ? 'sonnet' : 'gpt-6-sol');
    this.createdAt = new Date(stateNow(env) - historyAgeMs).toISOString(); this.ordinal = 0;
    this.open();
    if (provider === 'codex') this.codex('session_meta', {
      id, timestamp: this.createdAt, cwd: this.cwd, originator: 'codex_cli_rs', cli_version: '0.160.1',
      source: 'cli', history_mode: 'paginated', model_provider: 'openai',
    });
    if (historyAgeMs) {
      this.user('E2E historical request', this.createdAt);
      this.assistant('E2E historical reply', this.createdAt);
    }
  }
  open() {
    let directory = this.provider === 'claude'
      ? join(this.env.CLAUDE_CONFIG_DIR, 'projects', this.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
      : join(this.env.CODEX_HOME, 'sessions', ...this.createdAt.slice(0, 10).split('-'));
    if (this.parentSessionId) directory = join(directory, this.parentSessionId, 'subagents');
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, this.provider === 'claude' ? `${this.id}.jsonl` : `rollout-${this.createdAt.replaceAll(':', '-')}-${this.id}.jsonl`);
    // Codex のホスト発見は lsof で実際に開いている rollout を調べる。
    this.fd = openSync(this.path, 'a');
  }
  append(row) { appendFileSync(this.fd, JSON.stringify(row) + '\n'); return row; }
  base(type, timestamp = new Date(stateNow(this.env)).toISOString()) {
    const uuid = randomUUID();
    const row = { parentUuid: this.parent, isSidechain: false, type, uuid, timestamp,
      userType: 'external', entrypoint: 'cli', cwd: this.cwd, sessionId: this.id, version: CLAUDE_VERSION, gitBranch: 'main' };
    this.parent = uuid;
    return row;
  }
  codex(type, payload, timestamp = new Date(stateNow(this.env)).toISOString()) {
    return this.append({ timestamp, ordinal: this.ordinal++, type, payload });
  }
  user(text, timestamp) {
    if (this.provider === 'codex') {
      this.turn = randomUUID();
      this.codex('turn_context', { turn_id: this.turn, cwd: this.cwd, model: this.model, effort: 'medium' }, timestamp);
      this.codex('event_msg', { type: 'task_started', turn_id: this.turn }, timestamp);
      return this.codex('response_item', { type: 'message', id: randomUUID(), role: 'user', content: [{ type: 'input_text', text }] }, timestamp);
    }
    // 2.1.299 の打鍵した依頼の行の形。行の印は local() を使う。
    this.turn = randomUUID();
    this.prompts = (this.prompts ?? 0) + 1;
    return this.append({ ...this.base('user', timestamp), promptId: this.turn, message: { role: 'user', content: text }, permissionMode: 'default',
      origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: this.prompts, turnIndex: this.prompts } });
  }
  local(text, fields = {}) {
    if (this.provider === 'codex') return this.user(text);
    return this.append({ ...this.base('user'), promptId: randomUUID(), message: { role: 'user', content: text }, ...fields });
  }
  assistant(text, timestamp) {
    if (this.provider === 'codex') {
      const row = this.codex('response_item', { type: 'message', id: randomUUID(), role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }, timestamp);
      this.codex('event_msg', { type: 'task_complete', turn_id: this.turn, last_agent_message: text }, timestamp);
      return row;
    }
    // 2.1.299 の assistant 行は別名ではなく完全なモデル ID を持つ。
    const model = CLAUDE_MODEL_IDS[this.model] ?? this.model;
    return this.append({ ...this.base('assistant', timestamp), session_id: this.id, requestedModel: model, message: {
      model, id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } });
  }
  complete() {
    if (this.provider === 'claude') this.append({ ...this.base('system', new Date(stateNow(this.env) + 1).toISOString()), promptId: this.turn, subtype: 'turn_duration' });
  }
  tool(name = 'Bash') {
    this.append({ ...this.base('assistant'), promptId: this.turn, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: randomUUID(), name, input: {} }] } });
  }
  interrupt() {
    if (this.provider === 'claude') this.append({ ...this.base('user'), promptId: this.turn, message: { role: 'user', content: '[Request interrupted by user]' } });
    else this.codex('event_msg', { type: 'turn_aborted', turn_id: this.turn });
  }
  enqueue(text) {
    const item = { text, source: randomUUID(), delivery: randomUUID(), timestamp: new Date(stateNow(this.env)).toISOString() };
    this.append({ type: 'queue-operation', operation: 'enqueue', timestamp: item.timestamp, sessionId: this.id, content: text, commandUuid: item.source, deliveryId: item.delivery });
    return item;
  }
  absorb(item) {
    this.append({ type: 'queue-operation', operation: 'remove', timestamp: new Date(stateNow(this.env)).toISOString(), sessionId: this.id,
      content: item.text, reason: 'absorbed_mid_turn', commandUuid: item.source, deliveryId: item.delivery });
    return this.append({ ...this.base('attachment'), session_id: this.id,
      attachment: { type: 'queued_command', prompt: item.text, source_uuid: item.source, delivery_id: item.delivery,
        commandMode: 'prompt', origin: { kind: 'human' }, timestamp: item.timestamp, humanTurn: true },
      rendered: [{ content: item.text }], renderedRole: 'user' });
  }
  rename(name) { this.append({ type: 'custom-title', customTitle: name, sessionId: this.id }); }
  fork() {
    const previous = this.id;
    const shared = readFileSync(this.path, 'utf8');
    const next = randomUUID();
    this.append({ type: 'continued-in', timestamp: new Date(stateNow(this.env)).toISOString(), sessionId: previous, continuedInSessionId: next });
    closeSync(this.fd); this.id = next; this.open();
    writeFileSync(this.path, shared);
    return { previous, next };
  }
  compact() {
    const previous = this.parent;
    this.append({ ...this.base('system'), parentUuid: null, logicalParentUuid: previous, subtype: 'compact_boundary',
      content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 1200 } });
    this.append({ ...this.base('user'), promptId: randomUUID(), isVisibleInTranscriptOnly: true, isCompactSummary: true,
      message: { role: 'user', content: COMPACT_SUMMARY } });
  }
  bash(text) {
    // ! は通常文と同じ本文にならない。実履歴の local shell の包みも再現する。
    // 2.1.299 は ! の後ろをそのまま残す。出力の行だけ turnOrigin と turnPosition を持つ。
    this.prompts = (this.prompts ?? 0) + 1;
    this.local(`<bash-input>${text.slice(1)}</bash-input>`);
    this.local('<bash-stdout>E2E shell output</bash-stdout><bash-stderr></bash-stderr>',
      { turnOrigin: 'human', turnPosition: { promptIndex: this.prompts, turnIndex: this.prompts } });
  }
  close() { closeSync(this.fd); }
}

export function renderClaude({ input = '', working = false, panel = false, model = 'haiku', output = '' } = {}) {
  if (panel) {
    const selected = model === 'haiku' ? 5 : 4;
    const items = ['Default (recommended)  Use the default model', 'Opus                   Opus 5.5',
      'Fable                  Fable 5.1', 'Sonnet                 Sonnet 5.5', 'Haiku                  Haiku 5.5'];
    return '\x1b[2J\x1b[HSelect model\r\n  Switch between Claude models. Your pick becomes the default for new\r\n'
      + '  sessions. For other/previous model names, specify with --model.\r\n\r\n'
      + items.map((item, index) => `  ${index + 1 === selected ? '❯' : ' '} ${index + 1}. ${item}`).join('\r\n')
      + '\r\n\r\n  ◐ Medium effort (default) ←/→ to adjust\r\n\r\n'
      + '  Enter to set as default · s to use this session only · Esc to cancel' + `\x1b[${4 + selected};5H`;
  }
  const lines = [`Claude Code v${CLAUDE_VERSION}`, output || '', working ? '✻ Working… (esc to interrupt)' : '',
    '────────────────────────────────────────────────────────────', `❯ ${input}`,
    '────────────────────────────────────────────────────────────', '  ? for shortcuts'];
  return '\x1b[2J\x1b[H' + lines.join('\r\n') + `\x1b[5;${3 + input.length}H`;
}
export function renderCodex({ input = '', working = false, output = '' } = {}) {
  return '\x1b[2J\x1b[HOpenAI Codex (synthetic)\r\n' + output + '\r\n'
    + (working ? '• Working\r\n' : '\r\n') + `› ${input}\r\n  ? for shortcuts · 100% context left\x1b[4;${3 + input.length}H`;
}
