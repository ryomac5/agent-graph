#!/usr/bin/env node
// api だけを再起動しても、runner が持つ端末（偽 claude）が生き続けるかを実測する。
// E2E_CODE_ROOT で試す版を指定する。未指定なら main の版。ブラウザと dashboard の build は使わない。
import { writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DIRECTORY, createIsolation, launch, stopProcess, removeIsolation, readActors, readJson, waitFor, START_TIMEOUT_MS } from './isolation.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const isolation = await createIsolation();
const processes = [];
const track = role => { const run = launch(process.execPath, [join(DIRECTORY, 'services.mjs'), role], { cwd: isolation.state, env: isolation.env }); processes.push(run); return run; };
async function ready(run, file, pid) {
  return waitFor(async () => {
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`startup failed: ${run.output()}`);
    const value = await readJson(join(isolation.root, file));
    return value && (pid === undefined || value.pid === pid) ? value : undefined;
  }, file, START_TIMEOUT_MS);
}
async function connect(url) {
  const html = await (await fetch(url)).text();
  const token = /name="agent-graph-token" content="([^"]+)"/.exec(html)?.[1];
  const state = await (await fetch(url + '/snapshot', { headers: { 'x-agent-graph-token': token } })).json();
  const socket = new WebSocket(`${url.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'ack') pending.get(message.cmd_id)?.(message);
  });
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('ws error')); });
  socket.send(JSON.stringify({ type: 'hello', seq: state.seq, generation: state.generation, scope: { tables: [] } }));
  const cmd = (command, payload) => new Promise((resolve, reject) => {
    const cmd_id = `rc-${crypto.randomUUID()}`;
    const timer = setTimeout(() => reject(new Error(`${command}: timeout`)), 15_000);
    pending.set(cmd_id, ack => { clearTimeout(timer); resolve(ack); });
    socket.send(JSON.stringify({ type: 'cmd', cmd_id, command, payload }));
  });
  return { cmd, close: () => socket.close() };
}
let runner, api;
try {
  execFileSync('/usr/bin/git', ['init', '--initial-branch=main', isolation.project], { env: isolation.env });
  await writeFile(join(isolation.dist, 'index.html'), '<!doctype html><html><head><meta name="agent-graph-token" content="__AGENT_GRAPH_TOKEN__"></head><body></body></html>');
  console.log(`code root: ${process.env.E2E_CODE_ROOT ?? '(main)'}`);
  runner = track('runner'); const runnerReady = await ready(runner, 'runner-ready.json');
  api = track('api'); let address = await ready(api, 'api-ready.json', undefined);
  console.log(`runner pid ${runnerReady.pid}, api pid ${address.pid}`);
  let ws = await connect(address.url);
  const added = await ws.cmd('project.add', { path: isolation.project });
  check('project.add', added.ok, added.error);
  const launched = await ws.cmd('session.launch', { projectId: added.result?.projectId, provider: 'claude' });
  check('session.launch', launched.ok, launched.error);
  const terminalId = launched.result?.terminalId;
  const actor = await waitFor(async () => (await readActors(isolation.control)).find(a => a.provider === 'claude' && a.id), 'fake claude', START_TIMEOUT_MS);
  const conversationId = JSON.stringify(['claude', actor.id]);
  const find = async client => { const ack = await client.cmd('session.hosts', {}); return ack.ok && ack.result.hosts.find(h => h.conversationId === conversationId); };
  const before = await waitFor(() => find(ws), 'host discovery', START_TIMEOUT_MS);
  console.log(`terminalId ${terminalId}, fake claude pid ${actor.pid}, host terminalId ${before.terminalId}`);
  await ws.cmd('terminal.attach', { terminalId });
  const send1 = await ws.cmd('session.send', { conversationId, text: 'BEFORE-RESTART' });
  check('再起動前の送信', send1.ok, send1.error);
  await waitFor(async () => (await readFile(actor.path, 'utf8')).includes('E2E reply: BEFORE-RESTART'), 'reply before', 20_000);
  check('再起動前の返事', true);
  ws.close();
  // api だけを止めて起動し直す。runner には触れない。
  await stopProcess(api); await delay(500);
  const fakeAlive = alive(actor.pid), runnerAlive = alive(runnerReady.pid);
  console.log(`api stopped: fake claude alive=${fakeAlive}, runner alive=${runnerAlive}`);
  api = track('api');
  address = await ready(api, 'api-ready.json', api.child.pid);
  console.log(`api restarted: new api pid ${address.pid}`);
  check('(a) 偽 claude の pid が同じまま生きている', fakeAlive && alive(actor.pid), `pid ${actor.pid}`);
  check('(c) runner の pid が変わらず生きている', runnerAlive && alive(runnerReady.pid) && (await readJson(join(isolation.root, 'runner-ready.json'))).pid === runnerReady.pid, `pid ${runnerReady.pid}`);
  ws = await connect(address.url);
  const after = await waitFor(() => find(ws), 'host rediscovery', 15_000).catch(() => undefined);
  check('(b1) 同じ conversation が同じ terminalId で再び見つかる', after?.terminalId === terminalId, `before ${terminalId}, after ${after?.terminalId}`);
  const attach = await ws.cmd('terminal.attach', { terminalId });
  check('(b2) 同じ terminalId へ再接続でき、画面が復元される', attach.ok && /BEFORE-RESTART/.test(attach.result?.scrollback ?? ''), attach.ok ? `scrollback ${attach.result.scrollback.length} bytes` : attach.error);
  const send2 = await ws.cmd('session.send', { conversationId, text: 'AFTER-RESTART' });
  let replied = false;
  if (send2.ok) replied = await waitFor(async () => (await readFile(actor.path, 'utf8')).includes('E2E reply: AFTER-RESTART'), 'reply after', 20_000).catch(() => false);
  check('(b3) 再起動後の送信が通り、偽 claude が返事する', send2.ok && replied, send2.ok ? '' : send2.error);
  ws.close();
} catch (error) { console.error(error.stack ?? error); check('実行', false, error.message); }
finally {
  for (const run of processes.reverse()) await stopProcess(run).catch(() => {});
  for (const a of await readActors(isolation.control).catch(() => [])) {
    try { if (alive(a.pid) && execFileSync('ps', ['-p', String(a.pid), '-o', 'command=']).toString().includes(isolation.bin)) process.kill(a.pid, 'SIGTERM'); } catch {}
  }
  await delay(500);
  await removeIsolation(isolation).catch(error => console.error('cleanup:', error.message));
  const ok = results.length > 0 && results.every(r => r.ok);
  console.log(`判定: ${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}
