import { spawn } from 'node:child_process';
import { stateNow } from './clock.mjs';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { assertIsolation, readJson, writeJson } from './isolation.mjs';
import { Transcript, CLAUDE_MODELS, CLAUDE_MODEL_IDS, CLAUDE_VERSION, REPLY_PREFIX, renderClaude, renderCodex } from './fixtures.mjs';

const CONTROL_POLL_MS = 40;
const REPLY_DELAY_MS = 350;
const PARENT_CHECK_MS = 1000;

export class InputDecoder {
  constructor(submit, draw, choose) { this.submit = submit; this.draw = draw; this.choose = choose; this.input = ''; this.buffer = ''; this.pasting = false; }
  feed(chunk) {
    this.buffer += chunk;
    while (this.buffer) {
      if (this.buffer.startsWith('\x1b[200~')) { this.pasting = true; this.buffer = this.buffer.slice(6); continue; }
      if (this.buffer.startsWith('\x1b[201~')) { this.pasting = false; this.buffer = this.buffer.slice(6); this.draw(this.input); continue; }
      if (['\x1b[200~', '\x1b[201~'].some(marker => marker.startsWith(this.buffer))) return;
      const char = this.buffer[0]; this.buffer = this.buffer.slice(1);
      if (!this.pasting && this.choose(char)) continue;
      if (char === '\x15') this.input = '';
      else if (!this.pasting && (char === '\r' || char === '\n')) {
        const input = this.input.trimEnd(); this.input = ''; this.submit(input);
      } else if (char === '\x7f') this.input = this.input.slice(0, -1);
      else if (char >= ' ' || this.pasting && char === '\n') this.input += char;
    }
    this.draw(this.input);
  }
}

async function runProtocol(provider, audit) {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line); audit('protocol', { request });
    if (provider === 'claude') {
      if (request.type !== 'control_request') throw new Error('The fixture supports SDK discovery only; interactive journeys must use the PTY');
      const subtype = request.request.subtype;
      const response = subtype === 'initialize' ? {
        commands: [], agents: [], output_style: 'default', available_output_styles: ['default'], models: CLAUDE_MODELS,
        account: { subscriptionType: 'synthetic', apiProvider: 'synthetic', apiKeySource: 'none' },
      } : subtype === 'get_usage' ? { rate_limits: [] } : undefined;
      send({ type: 'control_response', response: response ? { subtype: 'success', request_id: request.request_id, response }
        : { subtype: 'error', request_id: request.request_id, error: `Unsupported synthetic control: ${subtype}` } });
    } else if (request.id !== undefined) {
      const result = request.method === 'initialize' ? { userAgent: 'e2e-codex', platformFamily: 'unix', platformOs: process.platform }
        : request.method === 'model/list' ? { data: [{ id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6', defaultReasoningEffort: 'medium' }], nextCursor: null }
          : request.method === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } }
            : undefined;
      send(result ? { id: request.id, result } : { id: request.id, error: { code: -32601, message: 'Unsupported synthetic method' } });
    }
  }
}

export async function main(provider) {
  await assertIsolation();
  const control = process.env.E2E_CONTROL;
  const directory = join(control, String(process.pid));
  await mkdir(join(directory, 'requests'), { recursive: true });
  await mkdir(join(directory, 'responses'), { recursive: true });
  const audit = (event, data = {}) => appendFileSync(join(control, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, provider, event, ...data }) + '\n');
  const parent = Number(process.env.E2E_PARENT_PID ?? process.ppid);
  const watchdog = setInterval(() => {
    try { process.kill(parent, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(0); else throw error; }
  }, PARENT_CHECK_MS);
  watchdog.unref();
  audit('started', { args: process.argv.slice(2), parent });
  const args = process.argv.slice(2);
  const protocol = args.includes('stream-json') || args.includes('app-server');
  if (args.includes('--version')) { console.log(provider === 'claude' ? `${CLAUDE_VERSION} (Claude Code; synthetic)` : 'codex-cli 0.160.1 (synthetic)'); return; }
  if (protocol) {
    await writeJson(join(directory, 'state.json'), { pid: process.pid, provider, protocol: true });
    await runProtocol(provider, audit); return;
  }
  if (provider === 'claude') process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  const options = await readJson(join(control, 'next-session.json')) ?? {};
  await rm(join(control, 'next-session.json'), { force: true });
  const argValue = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const transcript = new Transcript(provider, process.env, { ...options, id: argValue('--resume') ?? argValue('resume'), model: argValue('--model') });
  let dropStop = false, dropSessionEnd = false, statusUpdatedAt = stateNow(), child;
  let working = false, holdNext = false, dropNext = false, panel = false, panelModel = '', panelArgs = '', stopped = false;
  let queued = [], pending = [], output = '', timer, poll;
  let operation = Promise.resolve();
  const serialize = fn => { operation = operation.then(fn); operation.catch(error => { audit('fatal', { error: error.stack }); console.error(error); void shutdown(1); }); return operation; };
  const state = () => ({ pid: process.pid, provider, id: transcript.id, path: transcript.path, model: transcript.model, working, panel, child: child ? { id: child.id, path: child.path, turn: child.turn } : undefined, queued: queued.map(item => item.text), stopped });
  async function saveState() {
    const temporary = join(directory, 'state.tmp');
    await writeJson(temporary, state()); await rename(temporary, join(directory, 'state.json'));
    if (provider === 'claude') {
      const destination = join(process.env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`);
      await writeJson(destination + '.tmp', { pid: process.pid, sessionId: transcript.id, cwd: transcript.cwd,
        startedAt: Date.parse(transcript.createdAt), version: CLAUDE_VERSION, kind: 'interactive', entrypoint: 'cli',
        status: working ? 'busy' : 'idle', statusUpdatedAt, updatedAt: stateNow() });
      await rename(destination + '.tmp', destination);
    }
  }
  async function hook(name, fields = {}) {
    if (provider !== 'claude') return;
    if (name === 'Stop' && dropStop || name === 'SessionEnd' && dropSessionEnd) { audit('dropped-hook', { name }); return; }
    const input = { session_id: transcript.id, transcript_path: transcript.path, cwd: transcript.cwd,
      permission_mode: 'default', hook_event_name: name, source_ts: new Date(stateNow()).toISOString(), prompt_id: transcript.turn, ...fields };
    // 実際の hook の model は完全なモデル ID。
    if (input.model) input.model = CLAUDE_MODEL_IDS[input.model] ?? input.model;
    audit('hook-input', { input });
    // 本物の adapter の世代採番、outbox、HTTP 配達を通す。
    const { runHookV2 } = await import('../../packages/adapters/src/hook-v2/cli.ts');
    const { Readable } = await import('node:stream');
    await runHookV2(Readable.from([JSON.stringify(input)]), { destinationFile: process.env.E2E_HOOK_DESTINATION });
  }
  function draw(input = '') { process.stdout.write((provider === 'claude' ? renderClaude : renderCodex)({ input, working, panel, model: panelModel, output })); }
  async function finish() {
    clearTimeout(timer);
    for (const item of queued) { transcript.absorb(item); pending.push(item.text); }
    queued = [];
    for (const text of pending) { output = REPLY_PREFIX + text; transcript.assistant(output); audit('reply', { text, id: transcript.id }); }
    pending = []; working = false; statusUpdatedAt = stateNow();
    await hook('Stop', { stop_hook_active: false, last_assistant_message: output });
    transcript.complete();
    await saveState(); draw();
  }
  async function submit(text) {
    if (!text) return;
    audit('input', { text, id: transcript.id });
    if (dropNext) { dropNext = false; audit('dropped', { text }); draw(); return; }
    if (text.startsWith('/rename ')) { transcript.rename(text.slice(8).trim()); output = '⎿ Session renamed'; await saveState(); draw(); return; }
    if (text.startsWith('/model')) { panel = true; panelArgs = text.split(/\s+/)[1] ?? ''; panelModel = panelArgs || 'haiku'; await saveState(); draw(); return; }
    if (text.startsWith('/compact')) { transcript.compact(); output = '⎿ Conversation compacted'; await saveState(); draw(); return; }
    if (text.startsWith('!')) { transcript.bash(text); output = 'E2E shell output'; await saveState(); draw(); return; }
    if (working && provider === 'claude') { queued.push(transcript.enqueue(text)); await saveState(); draw(); return; }
    if (stopped) stopped = false;
    transcript.user(text); pending.push(text); working = true; statusUpdatedAt = stateNow();
    await hook('UserPromptSubmit', { prompt: text, prompt_id: transcript.turn });
    await saveState(); draw();
    if (holdNext) holdNext = false;
    else timer = setTimeout(() => serialize(finish), REPLY_DELAY_MS);
  }
  async function interrupt() { clearTimeout(timer); transcript.interrupt(); working = false; pending = []; queued = []; statusUpdatedAt = stateNow(); await saveState(); draw(); }
  async function choose(char) {
    if (char === '\x1b') { panel = false; await saveState(); draw(); return; }
    if (!['s', '\r', '\n'].includes(char)) return;
    transcript.model = panelModel; panel = false;
    output = `⎿ Set model to ${panelModel}`;
    const display = CLAUDE_MODELS.find(model => model.value === panelModel)?.displayName ?? panelModel;
    // 実履歴と同じく、注意書き・コマンド・結果の三行を確定時に書く。
    transcript.local('<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>', { isMeta: true });
    transcript.local(`<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${panelArgs}</command-args>`);
    transcript.local(`<local-command-stdout>Set model to \`${display}\`</local-command-stdout>`);
    audit('model-confirmed', { model: transcript.model }); await saveState(); draw();
  }
  const decoder = new InputDecoder(text => serialize(() => submit(text)), draw, char => {
    if (!panel) return false;
    serialize(() => choose(char)); return true;
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let escapeTimer;
  process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => {
    clearTimeout(escapeTimer); decoder.feed(chunk);
    if (decoder.buffer === '\x1b') escapeTimer = setTimeout(() => {
      decoder.buffer = '';
      if (panel) serialize(() => choose('\x1b'));
      else if (working) serialize(interrupt);
    }, 30);
  }); process.stdin.resume();
  await hook('SessionStart', { source: args.includes('--resume') ? 'resume' : 'startup', model: transcript.model });
  await saveState(); draw();
  async function controlCommand(request) {
    switch (request.action) {
      case 'drop-stop': dropStop = true; break;
      case 'drop-session-end': dropSessionEnd = true; break;
      case 'interrupt': await interrupt(); break;
      case 'long-tool': clearTimeout(timer); working = true; statusUpdatedAt = stateNow(); transcript.user('E2E long tool'); transcript.tool(); break;
      case 'approval-wait': clearTimeout(timer); working = false; transcript.user('E2E approval request'); await hook('UserPromptSubmit', { prompt: 'E2E approval request' }); await hook('Notification', { notification_type: 'permission_prompt' }); break;
      case 'background-child':
      case 'child-tool': {
        child?.close(); child = new Transcript('claude', process.env, { id: 'agent-' + randomUUID(), parentSessionId: transcript.id });
        if (request.action === 'background-child') {
          transcript.user('E2E delegate in background');
          const call = randomUUID();
          transcript.append({ ...transcript.base('assistant'), promptId: transcript.turn,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: call, name: 'Agent', input: { run_in_background: true } }] } });
          transcript.append({ ...transcript.base('user'), promptId: transcript.turn,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call }] },
            toolUseResult: { agentId: child.id.slice(6), status: 'async_launched', isAsync: true } });
          transcript.complete();
        }
        child.user('E2E child tool'); child.tool(); break;
      }
      case 'child-stop-tool':
        if (!child) throw new Error('No child');
        child.append({ ...child.base('attachment'), promptId: child.turn, attachment: { type: 'hook_success', hookEvent: 'SubagentStop' } }); break;
      case 'child-stopped-notification':
        if (!child) throw new Error('No child');
        transcript.append({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(stateNow()).toISOString(), sessionId: transcript.id,
          content: '<task-notification><task-id>' + child.id.slice(6) + '</task-id><status>stopped</status></task-notification>' }); break;
      case 'external-input': transcript.user(request.text); break;
      case 'scan-failure': await writeJson(join(process.env.CLAUDE_CONFIG_DIR, 'sessions', 'invalid.json'), { broken: true }); break;
      case 'restore-scan': await rm(join(process.env.CLAUDE_CONFIG_DIR, 'sessions', 'invalid.json'), { force: true }); break;
      case 'advance-clock': await writeJson(join(control, 'clock.json'), { offset: stateNow() - Date.now() + request.ms }); break;
      case 'parent-restart': {
        const next = spawn(process.execPath, [process.argv[1], '--resume', transcript.id], { env: { ...process.env, E2E_PARENT_PID: String(parent), E2E_KEEP_ALIVE: '1' }, stdio: 'ignore', detached: true });
        next.unref(); dropSessionEnd = true; setTimeout(() => void shutdown(), 100); break;
      }
      case 'hold-next': holdNext = true; break;
      case 'drop-next': dropNext = true; break;
      case 'release': await finish(); break;
      case 'fork': {
        const ids = transcript.fork(); audit('fork', ids);
        await hook('SessionStart', { source: 'resume', model: transcript.model }); break;
      }
      case 'rename': transcript.rename(request.name); break;
      case 'compact': transcript.compact(); break;
      case 'end': await hook('SessionEnd', { reason: 'other' }); stopped = true; break;
      case 'resume': await hook('SessionStart', { source: 'resume', model: transcript.model }); stopped = false; break;
      case 'exit': setTimeout(() => void shutdown(), 100); break;
      default: throw new Error(`Unknown script action: ${request.action}`);
    }
    await saveState(); draw();
    return state();
  }
  let polling = false;
  poll = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      for (const name of (await readdir(join(directory, 'requests'))).filter(name => name.endsWith('.json')).sort()) {
        const path = join(directory, 'requests', name);
        const request = JSON.parse(await readFile(path, 'utf8'));
        await rm(path);
        const value = await serialize(() => controlCommand(request));
        await writeJson(join(directory, 'responses', name), { ok: true, value });
      }
    } catch (error) { audit('fatal', { error: error.stack }); console.error(error); await shutdown(1); }
    finally { polling = false; }
  }, CONTROL_POLL_MS);
  let closing = false;
  async function shutdown(code = 0) {
    if (closing) return; closing = true;
    clearInterval(poll); clearInterval(watchdog); clearTimeout(timer); clearTimeout(escapeTimer);
    await hook('SessionEnd', { reason: 'prompt_input_exit' });
    stopped = true; await saveState(); child?.close(); transcript.close();
    if (provider === 'claude') await rm(join(process.env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`), { force: true });
    audit('exited'); process.exit(code);
  }
  process.once('SIGTERM', () => void shutdown()); process.once('SIGHUP', () => void shutdown());
  if (process.env.E2E_KEEP_ALIVE !== '1') process.stdin.once('end', () => void shutdown());
}
