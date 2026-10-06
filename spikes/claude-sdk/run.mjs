import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

const TURN_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 5_000;
const QUIET_MS = 1_000;
const INTERRUPT_AFTER_CHARS = 120;
const FILE_CONTENT = 'claude-sdk-spike-ok\n';
const cwd = await mkdtemp(join(tmpdir(), 'claude-sdk-spike-'));
const filePath = join(cwd, 'approval.txt');
const marker = `memory-${randomUUID()}`;
const children = [];
const hosts = [];
let stage = 1;
let approvals = 0;
let failed = false;

// 認証値は引き継がず、既存ログインを本体に読ませる。
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|CLAUDECODE|AGENT_GRAPH_)/.test(key)) delete env[key];
}
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && value?.length >= 8)
  .map(([, value]) => value);
function emit(event, values = {}) {
  let line = JSON.stringify({ at: new Date().toISOString(), stage, event, ...values });
  for (const value of secrets) line = line.replaceAll(value, '[REDACTED]');
  line = line.replace(/sk-ant-[\w-]+/g, '[REDACTED]').replace(/Bearer\s+[\w.\/-]+/gi, 'Bearer [REDACTED]');
  process.stdout.write(`${line}\n`);
}
async function withTimeout(promise, label, ms = TURN_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function check(value, label, values = {}) {
  emit('check', { label, passed: Boolean(value), ...values });
  if (!value) { failed = true; }
}
function createInput() {
  const queue = [];
  let wake;
  let ended = false;
  return {
    push(content, session_id) {
      queue.push({ type: 'user', session_id, message: { role: 'user', content }, parent_tool_use_id: null });
      wake?.();
    },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        if (queue.length) yield queue.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    },
  };
}
function startHost(resume) {
  const input = createInput();
  const host = { input, sessionId: resume, text: '', models: [], states: [], results: [], deltas: 0, closed: false };
  hosts.push(host);
  host.query = query({ prompt: input, options: {
    cwd, model: 'haiku', resume, settingSources: [],
    settings: { disableAllHooks: true },
    tools: ['Write'], permissionMode: 'default',
    includePartialMessages: true, persistSession: true, env,
    canUseTool: async (name, toolInput) => {
      const allow = stage === 3 && name === 'Write' && resolve(cwd, toolInput.file_path ?? '') === filePath && toolInput.content === FILE_CONTENT;
      emit('permission_request', { name, input: toolInput });
      if (allow) approvals++;
      emit('permission_response', { behavior: allow ? 'allow' : 'deny' });
      return allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'Only the specified spike file and content are permitted.' };
    },
    spawnClaudeCodeProcess(options) {
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'] });
      const record = { child, exited: false };
      children.push(record);
      host.process = record;
      record.done = new Promise(resolve => {
        child.once('close', (code, signal) => {
          record.exited = true;
          emit('process_exit', { pid: child.pid, code, signal });
          resolve();
        });
      });
      child.on('error', error => emit('process_error', { error: error.message }));
      child.stderr.on('data', data => emit('stderr', { text: data.toString() }));
      emit('process_spawn', { pid: child.pid });
      return child;
    },
  } });
  host.reader = (async () => {
    try {
      for await (const message of host.query) {
        host.sessionId = message.session_id ?? host.sessionId;
        const base = { type: message.type, subtype: message.subtype, session_id: message.session_id };
        if (message.type === 'system' && message.subtype === 'init') {
          emit('init', { ...base, model: message.model, apiKeySource: message.apiKeySource });
        } else if (message.subtype === 'session_state_changed') {
          host.states.push(message.state);
          emit('state', { ...base, state: message.state });
        } else if (message.type === 'system' && message.subtype === 'status') {
          emit('status', { ...base, status: message.status });
        } else if (message.type === 'assistant') {
          host.models.push(message.message.model);
          for (const block of message.message.content) {
            if (block.type === 'text') { host.text += block.text; emit('text', { ...base, model: message.message.model, text: block.text }); }
            if (block.type === 'tool_use') emit('tool_call', { ...base, id: block.id, name: block.name, input: block.input });
          }
        } else if (message.type === 'stream_event') {
          const delta = message.event.delta;
          if (delta?.type === 'text_delta') {
            host.deltas += delta.text.length;
            emit('text_delta', { ...base, text: delta.text });
            host.onDelta?.();
          }
        } else if (message.type === 'result') {
          host.results.push(message);
          emit('result', { ...base, is_error: message.is_error, result: message.result, errors: message.errors, stop_reason: message.stop_reason, num_turns: message.num_turns, total_cost_usd: message.total_cost_usd });
          host.finishTurn?.(message);
        } else emit('message', base);
      }
      if (!host.closed) host.failTurn?.(new Error('Stream ended before close'));
    } catch (error) {
      host.error = error;
      emit('stream_error', { error: error.message, stack: error.stack });
      host.failTurn?.(error);
    }
  })();
  return host;
}
async function sendTurn(host, prompt) {
  host.text = '';
  host.models = [];
  if (host.error) throw host.error;
  const result = new Promise((resolve, reject) => { host.finishTurn = resolve; host.failTurn = reject; });
  emit('input', { session_id: host.sessionId, prompt });
  host.input.push(prompt, host.sessionId ?? '');
  try { return await withTimeout(result, `stage ${stage}`); }
  finally { host.finishTurn = undefined; host.failTurn = undefined; }
}
async function closeHost(host) {
  if (host.closed && host.process?.exited) return;
  host.closed = true;
  host.input.end();
  host.query.close();
  const record = host.process;
  if (record && !record.exited) {
    await Promise.race([record.done, delay(CLOSE_TIMEOUT_MS)]);
    if (!record.exited) { record.child.kill('SIGKILL'); await withTimeout(record.done, 'process kill', CLOSE_TIMEOUT_MS); }
  }
  await withTimeout(host.reader, 'reader close', CLOSE_TIMEOUT_MS);
  emit('closed', { session_id: host.sessionId, exited: record?.exited });
}
async function main() {
  emit('start', { cwd, sdk: '0.3.291', model: 'haiku', marker });
  const host = startHost();
  const first = await sendTurn(host, `Remember this marker for later: ${marker}. Reply only READY. Do not use tools.`);
  check(!first.is_error && host.text.includes('READY') && host.sessionId, 'start', { session_id: host.sessionId });
  const account = await withTimeout(host.query.accountInfo(), 'accountInfo');
  emit('authentication', { subscriptionType: account.subscriptionType, tokenSource: account.tokenSource, apiKeySource: account.apiKeySource, apiProvider: account.apiProvider });
  if (first.is_error) throw new Error(first.result ?? JSON.stringify(first.errors));
  stage = 2;
  check(host.deltas > 0, 'streaming', { delta_chars: host.deltas, states: host.states });
  stage = 3;
  const write = await sendTurn(host, `Use Write to create ${filePath} with exactly this content including the final newline: ${JSON.stringify(FILE_CONTENT)}. Then reply only WRITTEN.`);
  const content = await readFile(filePath, 'utf8');
  check(!write.is_error && approvals > 0 && content === FILE_CONTENT, 'approval_and_file', { approvals, content });
  stage = 4;
  let interruptPromise;
  const startChars = host.deltas;
  host.onDelta = () => {
    if (!interruptPromise && host.deltas - startChars >= INTERRUPT_AFTER_CHARS) {
      emit('interrupt_request', { delta_chars: host.deltas - startChars });
      interruptPromise = host.query.interrupt().then(receipt => { emit('interrupt_ack', { receipt }); return true; }, error => { emit('interrupt_error', { error: error.message }); return false; });
    }
  };
  const interrupted = await sendTurn(host, 'Write 1000 numbered lines of a detailed story about a lighthouse. Each line must have at least 20 words. Start immediately and do not use tools.');
  host.onDelta = undefined;
  const acknowledged = interruptPromise && await withTimeout(interruptPromise, 'interrupt');
  const stoppedAt = host.deltas;
  await delay(QUIET_MS);
  check(acknowledged && host.deltas === stoppedAt && interrupted.stop_reason !== 'end_turn' && interrupted.stop_reason !== 'max_tokens', 'interrupted', { result: interrupted.result, stop_reason: interrupted.stop_reason, quiet_ms: QUIET_MS, delta_chars: stoppedAt - startChars, states: host.states });
  stage = 5;
  const sessionId = host.sessionId;
  await closeHost(host);
  const resumed = startHost(sessionId);
  const recall = await sendTurn(resumed, 'What marker did I ask you to remember? Reply with that marker only. Do not use tools or read files.');
  check(!recall.is_error && resumed.sessionId === sessionId && resumed.text.includes(marker), 'resume_memory', { session_id: resumed.sessionId, text: resumed.text });
  stage = 6;
  await withTimeout(resumed.query.setModel('sonnet'), 'setModel');
  emit('model_switch_ack', { model: 'sonnet' });
  const switched = await sendTurn(resumed, 'Reply only SWITCHED. Do not use tools.');
  check(!switched.is_error && resumed.models.some(model => model.includes('sonnet')), 'model_switch', { models: resumed.models, session_id: resumed.sessionId });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  emit('signal', { signal });
  for (const host of hosts) { host.closed = true; host.input.end(); host.query?.close(); }
  for (const { child, exited } of children) if (!exited) child.kill('SIGKILL');
  process.exitCode = 1;
});
try { await main(); }
catch (error) {
  failed = true;
  emit('error', { error: error.message, stack: error.stack });
  for (let next = stage + 1; next <= 6; next++) emit('skipped', { skipped_stage: next, reason: `stage ${stage} failed` });
} finally {
  for (const host of hosts) {
    try { await closeHost(host); }
    catch (error) { failed = true; emit('cleanup_error', { error: error.message }); }
  }
  for (const record of children) {
    if (!record.exited) { record.child.kill('SIGKILL'); await record.done; }
  }
  emit('complete', { passed: !failed, all_processes_exited: children.every(record => record.exited) });
  process.exitCode = failed ? 1 : 0;
}
