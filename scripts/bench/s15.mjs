#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { cpus, platform, arch, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const FACTS = 1_000_000;
const CONVERSATIONS = 10_000;
const SCREENS = 5;
const ROUNDS = 5;
const TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 10;
const MEMORY_SAMPLE_MS = 25;
const SHUTDOWN_MS = 5000;
const LIMITS = { initial_ms: 3000, append_ms: 1000, reconnect_ms: 5000,
  search_ms: 1000, api_rss_bytes: 1_000_000_000 };
const SMOKE_FACTS = 100;
const SMOKE_CONVERSATIONS = 10;
const MARKER = 'S15SEARCHNEEDLE';
const SOURCE_TS = '2026-10-07T00:00:00.000Z';

function createFact(index, kind, subject, payload) {
  return { source: 'host-codex', source_event_id: `s15:${index}`, kind, subject,
    source_ts: SOURCE_TS, confidence: 'confirmed', payload };
}

async function runWorker(role, directory, count, conversations) {
  const dbPath = join(directory, 'ledger.db');
  if (role === 'seed') {
    const { openBatchLedger } = await import('../../packages/api/src/service/batch-ledger.ts');
    const { ledger, batch } = openBatchLedger(dbPath);
    try {
      batch(() => {
        for (let i = 0; i < conversations; i++) ledger.append(createFact(i, 'conversation.created',
          `conversation:c${i}`, { provider: 'codex', native_id: `c${i}`, origin: 'managed',
            type: 'interactive', history_format: 'jsonl' }));
        for (let i = 0; i < (count - conversations) / 2; i++) {
          const index = conversations + 2 * i;
          ledger.append(createFact(index, 'message.created', `message:m${i}`, {
            provider: 'codex', native_id: `m${i}`, version: 1, role: i % 2 ? 'assistant' : 'user',
            body: `${i === 0 ? MARKER : 'Synthetic history'} ${i} ${'x'.repeat(128)}`, body_state: 'stored',
          }));
          ledger.append(createFact(index + 1, 'message_membership.created', `message_membership:mm${i}`,
            { message_id: `m${i}`, conversation_id: `c${i % conversations}`, active: true }));
        }
      });
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(Number(db.prepare('SELECT count(*) AS n FROM facts').get().n), count);
        assert.equal(Number(db.prepare("SELECT count(*) AS n FROM facts WHERE kind = 'conversation.created'").get().n), conversations);
      } finally { db.close(); }
      process.send({ type: 'ready' });
    } finally { ledger.close(); }
    process.disconnect();
    return;
  }
  let peak = process.memoryUsage().rss;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  const timer = setInterval(sample, MEMORY_SAMPLE_MS);
  const { openObservationService } = await import('../../packages/api/src/service/index.ts');
  const { startWebSocketServer } = await import('../../packages/api/src/ws/index.ts');
  // 履歴の観測を起動せず、接続先と保存先を一時領域へ固定する。
  const service = openObservationService({ dbPath, home: directory, env: {}, live: false, readerOnly: true });
  // 本番の serve と同じ小分けの投影を使い、準備時間は表示時間から分ける。
  await waitUntil(() => service.catchUp().last_seq === count);
  const server = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'absent.sock') });
  sample();
  process.send({ type: 'ready', url: server.url, wsUrl: server.wsUrl, token: server.token });
  process.on('message', async message => {
    if (message.type !== 'stop') return;
    sample();
    // maxRSS は Node が全対応 OS で KiB として返す高水位を使う。
    peak = Math.max(peak, process.resourceUsage().maxRSS * 1024);
    process.send({ type: 'memory', peak_rss_bytes: peak });
    clearInterval(timer);
    await server.close();
    service.close();
    process.disconnect();
  });
}

function startWorker(role, directory, count, conversations) {
  const child = fork(fileURLToPath(import.meta.url), ['--worker', role, directory, String(count), String(conversations)],
    { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: {
      PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
      XDG_STATE_HOME: directory, XDG_CONFIG_HOME: directory,
    } });
  const messages = [];
  let failure;
  child.on('message', message => messages.push(message));
  child.on('error', error => { failure = error; });
  child.on('exit', (code, signal) => {
    if (code !== 0) failure = new Error(`${role} exited: ${code ?? signal}`);
  });
  return { child, async receive(type, timeoutMs = TIMEOUT_MS) {
    const start = performance.now();
    while (!messages.some(message => message.type === type)) {
      const workerError = messages.find(message => message.type === 'failure');
      if (workerError) throw Object.assign(new Error(workerError.message), { code: workerError.code });
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${role} exited before ${type}`);
      if (performance.now() - start > timeoutMs) throw new Error(`${role} timed out before ${type}`);
      await delay(POLL_MS);
    }
    return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
  } };
}

async function fetchJson(api, path) {
  const response = await fetch(`${api.url}${path}`, { headers: { 'x-agent-graph-token': api.token },
    signal: AbortSignal.timeout(TIMEOUT_MS) });
  assert.equal(response.status, 200);
  return response.json();
}

function hashRow(row) {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(
    Object.keys(row).sort().map(key => [key, row[key]])))).digest('hex');
}
function loadProjection(snapshot) {
  return new Map(Object.entries(snapshot.projection).map(([table, rows]) =>
    [table, new Map(rows.map(row => [String(row.id), hashRow(row)]))]));
}
function applyPatch(screen, patch) {
  assert.equal(patch.generation, screen.generation);
  assert.equal(patch.from_seq, screen.seq);
  for (const [table, changes] of Object.entries(patch.changes)) {
    const rows = screen.rows.get(table);
    for (const id of changes.remove) rows.delete(id);
    for (const row of changes.upsert) rows.set(String(row.id), hashRow(row));
    if (table === 'messages') {
      const marker = changes.upsert.find(row => row.id === JSON.stringify(['codex', 'm0']));
      if (marker) screen.markerBody = marker.body;
    }
  }
  screen.identities = patch.identities ?? screen.identities;
  screen.seq = patch.seq;
}
async function connectScreen(api, screen) {
  const socket = new WebSocket(`${api.wsUrl}?token=${encodeURIComponent(api.token)}`);
  screen.socket = socket;
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'ack' && message.cmd_id === screen.connectionId) {
        assert.equal(message.ok, false);
        assert.equal(message.error, 'Runner unavailable');
        screen.subscribed = true;
      } else {
        assert.equal(message.type, 'patch', `Unexpected frame: ${message.type}`);
        applyPatch(screen, message);
      }
    } catch (error) { screen.error = error; }
  });
  socket.addEventListener('error', () => { screen.error = new Error('WebSocket error'); });
  await waitUntil(() => socket.readyState === WebSocket.OPEN, screen);
  screen.subscribed = false;
  screen.connectionId = `s15-connect-${screen.id}-${screen.seq}`;
  socket.send(JSON.stringify({ type: 'hello', seq: screen.seq, generation: screen.generation }));
  // 不在の runner への読み取り要求で、hello の受理までを確かめる。
  socket.send(JSON.stringify({ type: 'cmd', cmd_id: screen.connectionId, command: 'runner.status' }));
  await waitUntil(() => screen.subscribed, screen);
}
async function waitUntil(check, screen) {
  const start = performance.now();
  while (!await check()) {
    if (screen?.error) throw screen.error;
    if (screen?.socket?.readyState === WebSocket.CLOSED) throw new Error('WebSocket closed');
    if (performance.now() - start > TIMEOUT_MS) throw new Error('Screen timed out');
    await delay(POLL_MS);
  }
  if (screen?.error) throw screen.error;
}
async function disconnectScreen(screen) {
  screen.socket.close();
  await waitUntil(() => screen.socket.readyState === WebSocket.CLOSED);
}
async function stopWorker(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_MS);
  try { await exited; }
  finally { clearTimeout(timer); }
}
async function awaitScreens(operations) {
  // 一画面の失敗後も他画面の計測を回収してから終了処理へ進む。
  const outcomes = await Promise.allSettled(operations);
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}

function summarize(values, limit, expectedCount) {
  const complete = values.length === expectedCount;
  return { samples: values, sample_count: values.length, expected_count: expectedCount, complete,
    max: values.length ? Math.max(...values) : null, limit,
    passed: complete && values.every(value => value <= limit) };
}

async function runBenchmark(smoke) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-graph-s15-'));
  const count = smoke ? SMOKE_FACTS : FACTS;
  const conversations = smoke ? SMOKE_CONVERSATIONS : CONVERSATIONS;
  const workers = [];
  const screens = [];
  const initialTimes = [], appendTimes = [], reconnectTimes = [], searchTimes = [];
  let apiWorker;
  let apiReady = false;
  let stage = 'seed';
  const result = { sample: 'S15', qualifies: !smoke, status: 'error',
    started_at: new Date().toISOString(), release_readiness: 'pending_external_checks',
    unmeasured: ['runner_memory', 'browser_rendering'],
    environment: { node: process.version, platform: platform(), arch: arch(),
      cpu: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem() },
    workload: { facts: count, conversations, screens: SCREENS, rounds: ROUNDS, body_padding_bytes: 128 },
    method: { initial: 'snapshot parsed and materialized through subscription acknowledgement after API ready',
      append: 'before durable append to all client projections updated',
      reconnect: 'before socket creation through subscription, replay, complete projection and identity equality',
      projection: 'production serve readerOnly path; initial catch-up included in api_startup_ms',
      memory: 'API child RSS high-water including startup; runner not started',
      rendering: 'simulated clients; browser rendering requires separate verification' }, metrics: {} };
  try {
    const seedStart = performance.now();
    const seed = startWorker('seed', directory, count, conversations);
    workers.push(seed.child);
    await seed.receive('ready');
    result.seed_ms = performance.now() - seedStart;
    stage = 'api_startup';
    const apiStart = performance.now();
    const worker = startWorker('api', directory, count, conversations);
    workers.push(worker.child);
    apiWorker = worker;
    const api = await worker.receive('ready');
    apiReady = true;
    result.api_startup_ms = performance.now() - apiStart;
    stage = 'initial';
    await awaitScreens(Array.from({ length: SCREENS }, async (_, id) => {
      const start = performance.now();
      const snapshot = await fetchJson(api, '/snapshot');
      assert.equal(snapshot.seq, count);
      assert.equal(snapshot.projection.conversations.length, conversations);
      assert.equal(snapshot.projection.messages.length, (count - conversations) / 2);
      assert.equal(snapshot.projection.message_memberships.length, (count - conversations) / 2);
      assert.equal(Object.keys(snapshot.identities.conversations).length, conversations);
      const screen = { id, seq: snapshot.seq, generation: snapshot.generation,
        rows: loadProjection(snapshot), identities: snapshot.identities };
      screens.push(screen);
      await connectScreen(api, screen);
      initialTimes.push(performance.now() - start);
    }));
    // 操作先を決める識別子の対応も全表の投影とともに照合する。
    for (const screen of screens) {
      assert.deepEqual(screen.rows, screens[0].rows);
      assert.deepEqual(screen.identities, screens[0].identities);
    }
    result.verified_workload = { facts: count, conversations, connected_screens: screens.length,
      messages: (count - conversations) / 2, initial_projections_equal: true, initial_identities_equal: true };
    const { openLedger } = await import('../../packages/core/src/ledger/ledger.ts');
    const ledger = openLedger(join(directory, 'ledger.db'));
    try {
      for (let round = 0; round < ROUNDS; round++) {
        assert.equal(screens.length, SCREENS);
        for (const screen of screens) {
          assert.equal(screen.socket.readyState, WebSocket.OPEN);
          if (screen.error) throw screen.error;
        }
        const payload = { provider: 'codex', native_id: 'm0', version: round * 2 + 2,
          role: 'user', body: `${MARKER} live ${round}`, body_state: 'stored' };
        stage = 'append';
        const start = performance.now();
        const added = ledger.append(createFact(count + round * 2, 'message.updated', 'message:m0', payload));
        assert.equal(added.status, 'appended');
        await awaitScreens(screens.map(async screen => {
          await waitUntil(() => screen.seq === added.seq && screen.markerBody === JSON.stringify(payload.body), screen);
          assert.equal(screen.rows.get('messages').size, (count - conversations) / 2);
          appendTimes.push(performance.now() - start);
        }));
        stage = 'reconnect';
        await awaitScreens(screens.map(disconnectScreen));
        const offline = ledger.append(createFact(count + round * 2 + 1, 'message.updated', 'message:m0',
          { ...payload, version: payload.version + 1, body: `${MARKER} offline ${round}` }));
        assert.equal(offline.status, 'appended');
        let expected;
        await waitUntil(async () => {
          expected = await fetchJson(api, '/snapshot');
          return expected.seq === offline.seq;
        });
        assert.equal(expected.seq, offline.seq);
        const expectedRows = loadProjection(expected);
        await awaitScreens(screens.map(async screen => {
          const reconnectStart = performance.now();
          await connectScreen(api, screen);
          await waitUntil(() => screen.seq === expected.seq, screen);
          assert.deepEqual(screen.rows, expectedRows);
          assert.deepEqual(screen.identities, expected.identities);
          reconnectTimes.push(performance.now() - reconnectStart);
        }));
        stage = 'search';
        await awaitScreens(screens.map(async () => {
          const searchStart = performance.now();
          const response = await fetchJson(api, `/api/search?q=${MARKER}&limit=10`);
          assert.ok(response.total > 0);
          assert.ok(response.results.some(row => row.body === `${MARKER} offline ${round}`));
          searchTimes.push(performance.now() - searchStart);
        }));
      }
    } finally { ledger.close(); }
    stage = 'complete';
  } catch (error) {
    result.error = { stage, name: error.name, code: error.code, message: error.message };
    process.exitCode = 1;
  } finally {
    // 途中で失敗しても取得済みの値と不足した測定数を残す。
    for (const [name, values, expected] of [
      ['initial_ms', initialTimes, SCREENS],
      ['append_ms', appendTimes, SCREENS * ROUNDS],
      ['reconnect_ms', reconnectTimes, SCREENS * ROUNDS],
      ['search_ms', searchTimes, SCREENS * ROUNDS],
    ]) result.metrics[name] = summarize(values, LIMITS[name], expected);
    if (apiReady && apiWorker.child.connected) {
      try {
        apiWorker.child.send({ type: 'stop' });
        const memory = await apiWorker.receive('memory', SHUTDOWN_MS);
        result.metrics.api_rss_bytes = summarize([memory.peak_rss_bytes], LIMITS.api_rss_bytes, 1);
      } catch (error) {
        result.cleanup_error = { name: error.name, code: error.code, message: error.message };
        process.exitCode = 1;
      }
    }
    result.metrics.api_rss_bytes ??= summarize([], LIMITS.api_rss_bytes, 1);
    result.runner_memory = { status: 'not_measured', limit_bytes: LIMITS.api_rss_bytes };
    if (!result.error && !result.cleanup_error) {
      const passed = Object.values(result.metrics).every(metric => metric.passed);
      result.status = !passed ? 'failed' : smoke ? 'smoke_only' : 'measured_limits_passed';
      process.exitCode = passed ? 0 : 1;
    }
    for (const screen of screens) screen.socket?.close();
    await Promise.all(workers.map(stopWorker));
    rmSync(directory, { recursive: true, force: true });
    result.finished_at = new Date().toISOString();
    console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[2] === '--worker' && process.send) {
  try {
    await runWorker(process.argv[3], process.argv[4], Number(process.argv[5]), Number(process.argv[6]));
  } catch (error) {
    process.send({ type: 'failure', code: error.code, message: error.message }, () => process.exit(1));
  }
} else if (process.argv.slice(2).some(argument => argument !== '--smoke')) {
  console.error('Usage: node scripts/bench/s15.mjs [--smoke]');
  process.exitCode = 1;
} else {
  await runBenchmark(process.argv.includes('--smoke'));
}
