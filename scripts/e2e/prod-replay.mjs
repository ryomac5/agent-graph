#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openObservationService } from '../../packages/api/src/service/index.ts';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';
import { SendWatch } from '../../packages/api/src/service/send-watch.ts';
import { scanSessions } from '../../packages/api/src/service/session-scan.ts';
import { evaluateState, readNativeEvidence } from '../../packages/core/src/state/index.ts';
import { openLedger } from '../../packages/core/src/ledger/index.ts';

// node --expose-gc scripts/e2e/prod-replay.mjs [--db /path/agent-graph.db] [--claude-home /path/.claude] [--codex-home /path/.codex] [--keep] [--inspect <Claude の会話 ID>]
// --inspect は判定に加えず、取り込み直後の走査でその会話の表示と、競合の印が付いた turn の数を報告する。
// 終了値: 0=全判定成功、1=不一致、2=読み取りや走査を完了できず未確認。CLI・サーバーは起動しない。
// 反映 1 秒の予算から poll 500 ms と配信・描画 200 ms を除き、同期 refresh は 300 ms に限る。
export const MAX_APPEND_REFRESH_MS = 300;
export const MAX_EVALUATED_HEAP_BYTES = 400 * 1024 * 1024;
export const MAX_MISSING_TURN_RATIO = 0.01;
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function checkReplay(name, operation, { present = true, absent = 'unavailable', reason } = {}) {
  if (!present) return { name, status: absent, ok: null, reason };
  try { return { name, status: 'passed', ok: true, ...operation() }; }
  catch (error) { return { name, status: 'failed', ok: false, error: error.message }; }
}
export function replayExitCode(results) {
  return results.some(row => row.status === 'failed') ? 1 : results.some(row => row.status === 'unavailable') ? 2 : 0;
}
export function assessReplayMetrics({ appendRefreshMs, heapBytes, coverage }) {
  const results = [checkReplay('single-fact refresh <= 300 ms', () => {
    assert.ok(Number.isFinite(appendRefreshMs) && appendRefreshMs <= MAX_APPEND_REFRESH_MS, `${appendRefreshMs} ms exceeds ${MAX_APPEND_REFRESH_MS} ms`);
    return { value: appendRefreshMs, limit: MAX_APPEND_REFRESH_MS };
  }, { present: appendRefreshMs !== undefined, reason: 'No existing run for the append refresh probe' }), checkReplay('evaluated heap <= 400 MiB', () => {
    assert.ok(Number.isFinite(heapBytes) && heapBytes <= MAX_EVALUATED_HEAP_BYTES, `${heapBytes} bytes exceeds ${MAX_EVALUATED_HEAP_BYTES} bytes`);
    return { value: heapBytes, limit: MAX_EVALUATED_HEAP_BYTES };
  }, { present: heapBytes !== undefined, reason: 'Run with node --expose-gc to measure retained heap after evaluation' })];
  for (const provider of ['claude', 'codex']) {
    const row = coverage[provider];
    results.push(checkReplay(`${provider}: recent runs without a turn key <= 1%`, () => {
      assert.ok(row.ratio <= MAX_MISSING_TURN_RATIO, `${row.missing}/${row.runs} (${row.ratio}) exceeds ${MAX_MISSING_TURN_RATIO}`);
      return { ...row, limit: MAX_MISSING_TURN_RATIO };
    }, { present: row.runs > 0, absent: 'skip', reason: 'No runs with evidence or a start in the last 7 days' }));
  }
  return results;
}

export function measureAppendRefresh(path, feed, now) {
  const db = new DatabaseSync(path, { readOnly: true });
  const ledger = openLedger(path);
  try {
    // 最大の履歴を持つ実行への追記で測る。小さな新規 run だけで判定しない。
    const target = db.prepare(`SELECT f.subject, r.conversation_id, r.generation, count(*) AS facts
      FROM facts f JOIN run_subjects s ON f.subject = 'run:' || s.subject_id
      JOIN runs r ON r.conversation_id = s.conversation_id AND r.generation = s.generation
      WHERE f.kind GLOB 'run.*' GROUP BY f.subject, r.conversation_id, r.generation ORDER BY facts DESC LIMIT 1`).get();
    if (!target) return undefined;
    ledger.append({ source: 'ui', source_event_id: 'prod-replay-refresh-probe', kind: 'run.updated', subject: target.subject,
      source_ts: new Date(now).toISOString(), observed_ts: new Date(now).toISOString(), confidence: 'confirmed',
      payload: { conversation_id: target.conversation_id, generation: target.generation } });
    const start = performance.now(); feed.refresh(now);
    return { elapsedMs: performance.now() - start, subject: target.subject, facts: target.facts };
  } finally { ledger.close(); db.close(); }
}
// 会話の代表表示、生存、現在の turn の競合の印と、競合の印が付いた turn の数を、全 turn の数と並べて返す。
export function inspectConversation(feed, scan, nativeId) {
  const id = JSON.stringify(['claude', nativeId]);
  const row = feed.current.conversations.get(id);
  if (!row) return { id, present: false };
  const decision = row.decision;
  const session = scan.sessions.find(entry => entry.sessionId === nativeId);
  const runs = [...feed.current.contexts.values()].filter(context => context.conversation_id === id).map(context => {
    const evidence = context.input?.evidence ?? [];
    return { id: context.id, current: context.id === row.id,
      turns: new Set(evidence.filter(e => e.kind === 'signal' && e.turnId).map(e => e.turnId)).size,
      conflictTurns: new Set(evidence.filter(e => e.kind === 'conflict').map(e => e.turnId)).size };
  });
  const children = [...feed.current.contexts.values()].filter(context => context.parent === id && feed.current.conversations.get(context.conversation_id)?.id === context.id)
    .map(context => context.decision?.display.label).filter(label => label === 'Working' || label === 'Needs approval').length;
  return { id, present: true, label: decision.display.label, state: row.state, process: decision.process.value, hosting: decision.hosting.value,
    turn: decision.turn.value, details: decision.display.details, conflicts: decision.conflicts.length, workingChildren: children,
    session: session ? { status: session.status, statusUpdatedAt: session.statusUpdatedAt } : null, runs };
}

export function copyProductionDatabase(sourcePath, destination) {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { source.prepare('VACUUM INTO ?').run(destination); }
  finally { source.close(); }
  chmodSync(destination, 0o600);
}

// 本番の api は failed の送信行を 24 時間で消す。E2 の行が写しに無いときだけ、
// docs/agents/architecture-critique.md の E2 の表の値で写しの旧表に戻す。本文は受信行の <bash-input> から復元する。
const E2_CONVERSATION = '["claude","1c0d055c-8912-452b-b273-47e9874df7e8"]';
export const E2_WATCHES = [
  { id: '896eb201-37af-453c-ab95-05c0ed07ed4d', sent_ts: '2026-10-14T09:08:58.299Z', baseline_seq: 301134, received_seq: 301136, failed_ts: '2026-10-14T09:09:58.785Z' },
  { id: '8dceda21-b727-4ec8-bcbf-70017d8f5738', sent_ts: '2026-10-14T09:09:13.099Z', baseline_seq: 301144, received_seq: 301145, failed_ts: '2026-10-14T09:10:13.310Z' },
];
export function restoreLegacyE2(path) {
  const db = new DatabaseSync(path);
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_send_watches'").get()) return 'missing_table';
    const present = E2_WATCHES.filter(watch => db.prepare('SELECT 1 FROM api_send_watches WHERE id = ?').get(watch.id)).length;
    if (present === E2_WATCHES.length) return 'production';
    if (present) return 'unavailable';
    const commands = [];
    for (const watch of E2_WATCHES) {
      const fact = db.prepare("SELECT payload FROM facts WHERE seq = ? AND kind = 'message.created'").get(watch.received_seq);
      const command = fact && /^<bash-input>([\s\S]*)<\/bash-input>$/u.exec(JSON.parse(fact.payload).body)?.[1];
      if (command === undefined) return 'unavailable';
      commands.push(command);
    }
    for (const [index, watch] of E2_WATCHES.entries()) {
      db.prepare(`INSERT INTO api_send_watches (id, conversation_id, body, sent_ts, baseline_seq, state, message_id, failed_ts, attachments)
        VALUES (?, ?, ?, ?, ?, 'failed', NULL, ?, '[]')`).run(watch.id, E2_CONVERSATION, `!${commands[index]}`, watch.sent_ts, watch.baseline_seq, watch.failed_ts);
    }
    return 'restored';
  } finally { db.close(); }
}

export async function replayProduction(options = {}) {
  const original = { ...process.env };
  const home = homedir();
  const sourcePath = resolve(options.db ?? join(original.XDG_STATE_HOME || join(home, '.local/state'), 'agent-graph/agent-graph.db'));
  const claudeHome = resolve(options.claudeHome ?? original.CLAUDE_CONFIG_DIR ?? join(home, '.claude'));
  const codexHome = resolve(options.codexHome ?? original.CODEX_HOME ?? join(home, '.codex'));
  const directory = mkdtempSync(join(tmpdir(), 'agent-graph-prod-replay-'));
  const stateHome = join(directory, 'state'), isolatedHome = join(directory, 'home');
  mkdirSync(join(stateHome, 'agent-graph'), { recursive: true }); mkdirSync(isolatedHome);
  const path = join(stateHome, 'agent-graph', 'agent-graph.db');
  let service, feed, watch, db;
  const results = [];
  function check(name, operation, availability) { results.push(checkReplay(name, operation, availability)); }
  try {
    copyProductionDatabase(sourcePath, path);
    const e2Source = restoreLegacyE2(path);
    // 走査できない環境では、大きな履歴の取り込みより先に未確認で終了する。
    const preflight = await scanSessions(join(claudeHome, 'sessions'));
    if (preflight.status !== 'succeeded') throw new Error(`sessions/ps scan incomplete: ${preflight.status}`);
    // outbox・キャッシュ・設定の書き先は全て隔離する。原記録の二つの home だけ読み取り元にする。
    const env = { ...original, HOME: isolatedHome, XDG_STATE_HOME: stateHome, XDG_CACHE_HOME: join(directory, 'cache'),
      XDG_CONFIG_HOME: join(directory, 'config'), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
    Object.assign(process.env, env);
    service = openObservationService({ dbPath: path, home: isolatedHome, env });
    const ingestion = service.ingestOnce(); service.catchUp();
    // 本番では取り込みは worker。評価のヒープにその snapshot を混ぜない。
    service.close(); service = undefined; global.gc?.();
    service = openObservationService({ dbPath: path, home: isolatedHome, env });
    feed = new ProjectionFeed(path, service.catchUp);
    watch = new SendWatch(path);
    db = new DatabaseSync(path);
    const scan = await scanSessions(join(claudeHome, 'sessions'));
    if (scan.status !== 'succeeded') throw new Error(`sessions/ps scan incomplete: ${scan.status}`);
    const refreshStart = performance.now();
    feed.recordScan(scan); feed.refresh(scan.at);
    const refreshMs = performance.now() - refreshStart;
    watch.recordScan(scan);
    const deliveryStart = performance.now(); watch.check(scan.at);
    const deliveryMs = performance.now() - deliveryStart;
    const live = scan.sessions.filter(row => row.status === 'busy' && scan.processes.some(p => p.pid === row.pid && p.procStart === row.procStart));
    check('live busy Claude conversations', () => {
      for (const session of live) {
        const row = feed.current.conversations.get(JSON.stringify(['claude', session.sessionId]));
        assert.ok(row, `Missing current conversation: ${session.sessionId}`);
        assert.ok(!['Stopped', 'Unknown', 'Not hosted', 'Unresolved'].includes(row.decision.display.label), `${session.sessionId}: ${row.decision.display.label}/${row.decision.turn.reason}`);
        assert.equal(row.decision.process.value, 'alive_confirmed', session.sessionId);
      }
      return { count: live.length };
    }, { present: live.length > 0, absent: 'skip', reason: 'No live busy Claude sessions in the successful scan' });
    check('E1: stopped child remains Unknown, launched/incomplete', () => {
      const row = feed.current.conversations.get(JSON.stringify(['claude', 'agent-a46a60f85e3267c52']));
      assert.ok(row, 'E1 child missing');
      // 表の Unknown は親の生存中の値である。親の不在を走査が示せば、R32 の優先順で Not hosted が代表になる。
      const hosting = row.decision.hosting.value;
      assert.equal(row.decision.display.label, hosting === 'not_hosted' ? 'Not hosted' : 'Unknown');
      assert.equal(row.decision.turn.value, 'unknown');
      assert.equal(row.decision.turn.reason, 'boundary_unavailable');
      assert.equal(row.decision.result.stage, 'launched');
      assert.equal(row.decision.result.value, 'incomplete');
      assert.equal(row.decision.display.result, null);
      return { label: row.decision.display.label, hosting };
    }, { present: feed.current.conversations.has(JSON.stringify(['claude', 'agent-a46a60f85e3267c52'])), reason: 'E1 source conversation is absent from this copy' });
    check('E2: both legacy failed sends are Likely delivered', () => {
      for (const { id } of E2_WATCHES) {
        assert.equal(watch.decision(id)?.value, 'received_candidate', id);
        assert.equal(watch.decision(id)?.display, 'Likely delivered', id);
      }
      return { source: e2Source };
    }, { present: ['production', 'restored'].includes(e2Source), reason: 'E2 watches or their source receipts are absent from this copy' });
    const e3Rows = db.prepare('SELECT * FROM facts WHERE seq IN (301161,301162,301164,301165,301178,301179,301180)').all();
    check('E3: disputed historical runs are Unresolved without an invented run mapping', () => {
      // 表の E3 は二つの run の対応未解決を入力条件とする。現在の別世代の選択とは分けて原台帳の7件を再生する。
      const rows = e3Rows;
      assert.equal(rows.length, 7, 'E3 source facts missing');
      assert.ok(rows.every(row => String(row.subject).includes('396247a1-5fc0-48e2-b984-2f4a8dac1f17')), 'E3 seq refers to another database');
      assert.equal(new Set(rows.map(row => row.subject)).size, 2);
      const evidence = rows.flatMap(row => {
        const payload = JSON.parse(row.payload), last = payload.last_evidence ?? {};
        return readNativeEvidence({ id: row.fact_id, source: row.source === 'hook' ? 'hook' : 'claude',
          row: last.native_record ?? last.input ?? {}, runId: row.subject, at: Date.parse(row.source_ts), observedAt: Date.parse(row.observed_ts) });
      });
      const decision = evaluateState({ runId: null, turnId: null, process: null, parentProcessAtLaunch: 'independent', attempt: null, evidence }, scan.at);
      assert.equal(decision.display.label, 'Unresolved'); assert.equal(decision.process.value, 'unverified');
    }, { present: e3Rows.length === 7 && e3Rows.every(row => String(row.subject).includes('396247a1-5fc0-48e2-b984-2f4a8dac1f17')),
      reason: 'E3 source fact IDs are absent or belong to another database' });
    check('legacy closed deliveries retain received tombstones', () => {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_send_watches'").get(), 'Legacy watch table missing');
      const rows = db.prepare("SELECT id, baseline_seq, message_id FROM api_send_watches WHERE state='closed' AND message_id IS NOT NULL").all();
      assert.ok(rows.length, 'No closed deliveries to check');
      for (const row of rows) {
        const migrated = JSON.parse(db.prepare('SELECT data FROM api_delivery_operations WHERE id=?').get(row.id).data);
        assert.equal(migrated.baseline_seq, row.baseline_seq, row.id);
        assert.equal(migrated.message_id, row.message_id, row.id);
        assert.equal(watch.decision(row.id)?.value, 'received', row.id);
      }
      return { count: rows.length };
    });
    // 別接続の書き込みで facts の差分が無い場合の主スレッド時間も報告する。
    db.exec('CREATE TABLE replay_probe (id INTEGER); INSERT INTO replay_probe VALUES (1)');
    const recheckStart = performance.now(); watch.check(scan.at);
    const unrelatedCommitCheckMs = performance.now() - recheckStart;
    const coverage = feed.current.readTurnCoverage(scan.at - RECENT_WINDOW_MS);
    const inspected = options.inspect ? inspectConversation(feed, scan, options.inspect) : undefined;
    const appendRefresh = measureAppendRefresh(path, feed, scan.at);
    global.gc?.();
    const heapBytes = global.gc ? process.memoryUsage().heapUsed : undefined;
    results.push(...assessReplayMetrics({ appendRefreshMs: appendRefresh?.elapsedMs, heapBytes, coverage }));
    return { exitCode: replayExitCode(results), results, ingestion, coverage, heapBytes, ...(inspected ? { inspected } : {}),
      timings: { refreshMs, deliveryMs, unrelatedCommitCheckMs, appendRefresh }, ...(options.keep ? { copy: directory } : {}) };
  } catch (error) {
    return { exitCode: 2, results, error: error.message, ...(options.keep ? { copy: directory } : {}) };
  } finally {
    db?.close(); watch?.close(); feed?.close(); service?.close();
    for (const name of ['HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
      if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
    }
    if (!options.keep) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  const names = { '--db': 'db', '--claude-home': 'claudeHome', '--codex-home': 'codexHome' };
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--keep') options.keep = true;
    else if (flag === '--inspect' && process.argv[index + 1]) options.inspect = process.argv[++index];
    else if (names[flag] && process.argv[index + 1]) options[names[flag]] = process.argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  const report = await replayProduction(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
