import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const CODEX = process.env.SPIKE_CODEX ?? '/Users/r/.nodebrew/current/bin/codex';
const MODEL = 'gpt-5.6-luna';
const OTHER_MODEL = process.env.SPIKE_OTHER_MODEL ?? 'gpt-5.6-sol';
const RPC_TIMEOUT = 30_000;
const TURN_TIMEOUT = 120_000;
const secrets = [];
const servers = [];
const events = new Map();
let root;
let hookEvents = 0;
let approvals = 0;
let failed = false;
let interrupted = false;

function redact(value) {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text.replace(/(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[REDACTED]');
}
function emit(kind, data) {
  process.stdout.write(redact({ time: new Date().toISOString(), kind, ...data }) + '\n');
}
function collectSecrets(value) {
  if (typeof value === 'string' && value.length > 8) secrets.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(collectSecrets);
}
function summarize(thread) {
  const { id, parentThreadId, forkedFromId, ephemeral, model, reasoningEffort, source, status, path } = thread;
  return { id, parentThreadId, forkedFromId, ephemeral, model, reasoningEffort, source, status, path, turns: thread.turns?.length };
}
class Server {
  pending = new Map();
  completed = new Map();
  nextId = 0;
  async start(home, cwd) {
    if (interrupted) throw new Error('Spike interrupted');
    // 親の認証や実行制御の環境変数を子へ持ち込まない。
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    this.child = spawn(CODEX, ['app-server', '--listen', 'stdio://'], {
      cwd, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    servers.push(this);
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.ended = true;
      for (const { reject } of this.pending.values()) reject(new Error(`app-server closed: ${code}/${signal}`));
      this.pending.clear();
      emit('process/closed', { pid: this.child.pid, code, signal });
      resolve();
    }));
    this.child.on('error', error => emit('process/error', { error: error.message }));
    this.child.stdin.on('error', error => emit('stdin/error', { error: error.message }));
    createInterface({ input: this.child.stderr }).on('line', line => emit('stderr', { line }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { emit('protocol/error', { line }); return; }
      this.receive(message);
    });
    emit('process/started', { pid: this.child.pid });
    const initialized = await this.rpc('initialize', { clientInfo: { name: 'agent_graph_spike', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    emit('initialize', initialized);
    this.send({ method: 'initialized' });
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  receive(message) {
    if (!message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    const p = message.params ?? {};
    const threadId = p.threadId ?? p.thread?.id ?? p.conversationId ?? null;
    // 生の旧イベントも残すが、分類は通知のスレッド ID を使う。
    if (threadId) {
      if (!events.has(threadId)) events.set(threadId, []);
      events.get(threadId).push({ method: message.method, params: p });
    }
    if (message.method.startsWith('hook/')) hookEvents++;
    emit('event', { threadId, message });
    if (message.method === 'turn/completed') this.completed.set(`${threadId}/${p.turn.id}`, p.turn);
    if (message.id !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        approvals++;
        this.send({ id: message.id, result: { decision: 'accept' } });
        emit('approval', { threadId, id: message.id, decision: 'accept' });
      } else {
        this.send({ id: message.id, error: { code: -32601, message: 'Unsupported spike server request' } });
      }
    }
  }
  async rpc(method, params) {
    if (interrupted) throw new Error('Spike interrupted');
    const id = ++this.nextId;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, RPC_TIMEOUT);
        this.pending.set(id, { resolve, reject });
        this.send({ id, method, params });
      });
    } finally { clearTimeout(timer); }
  }
  async turn(threadId, text, model, effort) {
    emit('turn/request', { threadId, model, effort, text });
    const { turn } = await this.rpc('turn/start', { threadId, model, effort, input: [{ type: 'text', text }] });
    const configured = await this.rpc('thread/read', { threadId });
    emit('turn/configured', { threadId, turnId: turn.id, requestedModel: model, requestedEffort: effort, ...summarize(configured.thread) });
    const key = `${threadId}/${turn.id}`;
    const deadline = Date.now() + TURN_TIMEOUT;
    while (!this.completed.has(key) && !this.ended && Date.now() < deadline) await delay(100);
    if (!this.completed.has(key)) {
      if (!this.ended) await this.rpc('turn/interrupt', { threadId, turnId: turn.id });
      throw new Error(`Turn timeout or server closed: ${key}`);
    }
    const result = this.completed.get(key);
    const messages = (events.get(threadId) ?? []).filter(e => e.method === 'item/completed' && e.params.turnId === turn.id && e.params.item.type === 'agentMessage').map(e => e.params.item.text);
    emit('turn/result', { threadId, turnId: turn.id, status: result.status, error: result.error, messages });
    if (result.status !== 'completed') throw new Error(JSON.stringify(result.error ?? result));
    return messages.join('\n');
  }
  async stop() {
    if (!this.child?.pid || this.stopped) return;
    this.stopped = true;
    this.child.stdin.end();
    await Promise.race([this.closed, delay(2000)]);
    // 専用のプロセス群だけを停止し、道具の子孫も残さない。
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-this.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (signal === 'SIGTERM') await delay(300);
    }
    await this.closed;
    emit('process/groupStopped', { pid: this.child.pid });
  }
}
async function stage(name, action) {
  try { const result = await action(); emit('stage/result', { stage: name, ok: true, result }); return result; }
  catch (error) { failed = true; emit('stage/result', { stage: name, ok: false, error: error.message }); return null; }
}
async function cleanup() {
  const stopped = await Promise.allSettled(servers.map(server => server.stop()));
  if (root) await rm(root, { recursive: true, force: true });
  const errors = stopped.filter(result => result.status === 'rejected').map(result => result.reason.message);
  emit('cleanup', { processesStopped: errors.length === 0, temporaryHomeRemoved: true, errors });
  if (errors.length) failed = true;
}
let cleaning;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  cleaning ??= cleanup();
  cleaning.finally(() => process.exit(130));
});
try {
  root = await mkdtemp(join(tmpdir(), 'codex-app-server-spike-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  await mkdir(home, { mode: 0o700 });
  await mkdir(cwd);
  const auth = await readFile(join(homedir(), '.codex', 'auth.json'), 'utf8');
  collectSecrets(JSON.parse(auth));
  await writeFile(join(home, 'auth.json'), auth, { mode: 0o600 });
  emit('isolation', { home, cwd, copiedFiles: await readdir(home), hooksFileCopied: false });
  let server = new Server();
  await server.start(home, cwd);
  await stage('models', async () => (await server.rpc('model/list', {})).data.map(m => ({ model: m.model, supportedReasoningEfforts: m.supportedReasoningEfforts })));
  const threads = await Promise.all([0, 1].map(i => stage(`start-${i}`, async () => {
    const result = await server.rpc('thread/start', { model: MODEL, cwd, ephemeral: false, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
    emit('thread', { stage: 'start', ...summarize(result.thread), responseModel: result.model });
    return result.thread.id;
  })));
  const markers = ['AMBER-731', 'VIOLET-482'];
  await Promise.all(threads.map((id, i) => id && stage(`initial-turn-${i}`, () => server.turn(id, `Remember the marker ${markers[i]} in this conversation only. Do not write the marker to a file. Run the shell command sleep 2 using the command tool to test approval, then reply READY. Do not inspect any files or environment.`, MODEL, 'low'))));
  emit('approval/result', { approvals });
  await server.stop();
  server = new Server();
  await server.start(home, cwd);
  for (const [i, id] of threads.entries()) if (id) await stage(`resume-${i}`, async () => {
    const response = await server.rpc('thread/resume', { threadId: id });
    emit('thread', { stage: 'resume', ...summarize(response.thread) });
    const savedText = JSON.stringify(response.thread.turns);
    emit('resume/history', { threadId: id, expectedMarkerPresent: savedText.includes(markers[i]), otherMarkerPresent: savedText.includes(markers[1 - i]) });
    const answer = await server.turn(id, 'What marker did I ask you to remember? Reply only with that marker. Do not use tools.', MODEL, 'medium');
    if (!answer.includes(markers[i]) || answer.includes(markers[1 - i])) throw new Error(`Memory mismatch: ${answer}`);
    return { answer, matches: true };
  });
  if (threads[0]) await stage('fork', async () => {
    const response = await server.rpc('thread/fork', { threadId: threads[0], ephemeral: false });
    emit('thread', { stage: 'fork', ...summarize(response.thread) });
    if (response.thread.forkedFromId !== threads[0]) throw new Error('forkedFromId mismatch');
    return summarize(response.thread);
  });
  if (threads[0]) await stage('subagent', async () => {
    const turnResult = await stage('subagent-turn', () => server.turn(threads[0], 'Use spawn_agent to create exactly one subagent. Ask it to reply CHILD-OK without tools. Wait for its completion and then close it. Do not execute shell commands or read files. Report its answer.', MODEL, 'high'));
    const response = await server.rpc('thread/list', { parentThreadId: threads[0], sourceKinds: ['subAgentThreadSpawn'], limit: 100 });
    const children = response.data.map(summarize);
    emit('children', { children });
    if (!children.length) throw new Error(`No child thread observed; parent turn ${turnResult === null ? 'failed' : 'completed'}`);
    if (children.some(child => child.parentThreadId !== threads[0] || !events.get(child.id)?.length)) throw new Error('Child parentThreadId or child events missing');
    return children.map(child => ({ ...child, eventCount: events.get(child.id)?.length ?? 0 }));
  });
  if (threads[1]) for (const [model, effort] of [[OTHER_MODEL, 'low'], [MODEL, 'high']]) await stage(`switch-${model}-${effort}`, async () => {
    await server.turn(threads[1], 'Reply SWITCH-OK. Do not use tools.', model, effort);
    const { thread } = await server.rpc('thread/read', { threadId: threads[1] });
    emit('thread', { stage: 'switch', ...summarize(thread) });
    if (thread.model !== model || thread.reasoningEffort !== effort) throw new Error('Model or effort mismatch');
    return summarize(thread);
  });
  emit('summary', { hookEvents, approvals, threads: [...events].map(([id, entries]) => ({ id, events: entries.length, methods: [...new Set(entries.map(e => e.method))] })) });
  if (hookEvents || !approvals) failed = true;
} catch (error) {
  failed = true;
  emit('fatal', { error: error.message });
} finally {
  cleaning ??= cleanup();
  await cleaning;
}
process.exitCode = failed ? 1 : 0;
