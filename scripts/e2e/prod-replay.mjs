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

// node scripts/e2e/prod-replay.mjs [--db /path/agent-graph.db] [--claude-home /path/.claude] [--codex-home /path/.codex] [--keep]
// 終了値: 0=全判定成功、1=不一致、2=読み取りや走査を完了できず未確認。CLI・サーバーは起動しない。
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
    if (present) throw new Error('E2 rows are partially present');
    for (const watch of E2_WATCHES) {
      const fact = db.prepare("SELECT payload FROM facts WHERE seq = ? AND kind = 'message.created'").get(watch.received_seq);
      const command = fact && /^<bash-input>([\s\S]*)<\/bash-input>$/u.exec(JSON.parse(fact.payload).body)?.[1];
      if (command === undefined) throw new Error(`E2 received row missing: ${watch.received_seq}`);
      db.prepare(`INSERT INTO api_send_watches (id, conversation_id, body, sent_ts, baseline_seq, state, message_id, failed_ts, attachments)
        VALUES (?, ?, ?, ?, ?, 'failed', NULL, ?, '[]')`).run(watch.id, E2_CONVERSATION, `!${command}`, watch.sent_ts, watch.baseline_seq, watch.failed_ts);
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
  function check(name, operation) {
    try { const detail = operation(); results.push({ name, ok: true, ...detail }); }
    catch (error) { results.push({ name, ok: false, error: error.message }); }
  }
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
      assert.ok(live.length, 'No live busy sessions: live-session assertion cannot be evaluated');
      for (const session of live) {
        const row = feed.current.conversations.get(JSON.stringify(['claude', session.sessionId]));
        assert.ok(row, `Missing current conversation: ${session.sessionId}`);
        assert.ok(!['Stopped', 'Unknown', 'Not hosted', 'Unresolved'].includes(row.decision.display.label), `${session.sessionId}: ${row.decision.display.label}/${row.decision.turn.reason}`);
        assert.equal(row.decision.process.value, 'alive_confirmed', session.sessionId);
      }
      return { count: live.length };
    });
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
    });
    check('E2: both legacy failed sends are Likely delivered', () => {
      for (const { id } of E2_WATCHES) {
        assert.equal(watch.decision(id)?.value, 'received_candidate', id);
        assert.equal(watch.decision(id)?.display, 'Likely delivered', id);
      }
      return { source: e2Source };
    });
    check('E3: disputed historical runs are Unresolved without an invented run mapping', () => {
      // 表の E3 は二つの run の対応未解決を入力条件とする。現在の別世代の選択とは分けて原台帳の7件を再生する。
      const rows = db.prepare('SELECT * FROM facts WHERE seq IN (301161,301162,301164,301165,301178,301179,301180)').all();
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
    });
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
    return { exitCode: results.every(row => row.ok) ? 0 : 1, results, ingestion,
      timings: { refreshMs, deliveryMs, unrelatedCommitCheckMs: performance.now() - recheckStart }, ...(options.keep ? { copy: directory } : {}) };
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
    else if (names[flag] && process.argv[index + 1]) options[names[flag]] = process.argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  const report = await replayProduction(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
}
