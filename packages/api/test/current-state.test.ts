import { expandNativeEvidence } from '../../core/src/ledger/native-evidence.ts';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, type FactInput } from '../../core/src/ledger/index.ts';
import { openObservationService } from '../src/service/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';
import { scanSessions, SESSION_SCAN_VALID_MS } from '../src/service/session-scan.ts';
import type { SessionScan } from '../src/service/session-scan.ts';
import type { StateDecision } from '../../core/src/state/index.ts';

const NOW = Date.parse('2026-10-15T00:00:00Z');
const PARENT = { pid: 41, procStart: 'parent-A' };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'wirestate-'));
  const path = join(directory, 'ledger.db');
  const ledger = openLedger(path);
  const service = openObservationService({ dbPath: path, home: directory });
  let feed = new ProjectionFeed(path, service.catchUp);
  let serial = 0;
  t.after(() => { feed.close(); service.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const append = (kind: FactInput['kind'], subject: FactInput['subject'], payload: object, at = NOW, source = 'transcript-claude') =>
    ledger.append({ kind, subject, payload, source, source_event_id: `event:${++serial}`, confidence: 'confirmed', source_ts: new Date(at).toISOString(), observed_ts: new Date(at).toISOString() } as FactInput);
  const id = (name: string) => JSON.stringify(['claude', name]);
  function run(name: string, at = NOW, type = 'interactive') {
    append('conversation.created', `conversation:${id(name)}`, { provider: 'claude', native_id: name, type, origin: 'observed' }, at);
    append('run.created', `run:${name}`, { conversation_id: id(name), generation: 1, started_ts: new Date(at).toISOString(), state: 'running' }, at);
  }
  function native(name: string, row: object, at = NOW, source = 'claude') {
    append('run.updated', `run:${name}`, { conversation_id: id(name), generation: 1, last_evidence: { native_source: source, native_record: row } }, at);
  }
  const decision = (name: string, at: number) => {
    feed.refresh(at);
    return feed.current.conversations.get(id(name))!.decision as StateDecision;
  };
  const scan = (at: number, patch: Partial<SessionScan> = {}) => feed.recordScan({ id: `scan:${at}`, at, status: 'succeeded',
    sessions: [{ ...PARENT, sessionId: 'parent', startedAt: NOW - 1000 }], processes: [PARENT], ...patch });
  return { directory, path, ledger, service, append, run, native, decision, scan, id, get feed() { return feed; },
    reopen() { feed.close(); feed = new ProjectionFeed(path, service.catchUp); } };
}
const start = (turn = 'turn') => ({ type: 'user', uuid: `user:${turn}`, promptId: turn, message: { content: 'work' } });
const tool = (turn = 'turn') => ({ type: 'assistant', uuid: `tool:${turn}`, parentUuid: `user:${turn}`, message: { content: [{ type: 'tool_use', id: 'bash', name: 'Bash' }] } });

test('decision_id は走査時刻に依存せず、生存・pid・procStart と期限切れを区別する', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start());
  const scan = (at: number, process = PARENT) => {
    f.scan(at, { sessions: [{ ...process, sessionId: 'parent', startedAt: NOW - 1000,
      status: 'busy', statusUpdatedAt: NOW }], processes: [process] });
    f.decision('parent', at);
    return f.feed.snapshot().projection;
  };
  const first = scan(NOW + 1);
  const later = scan(NOW + 2);
  assert.equal(later.runs[0].decision_id, first.runs[0].decision_id);
  assert.notDeepEqual(later.state_decisions, first.state_decisions);
  f.reopen();
  assert.equal(f.decision('parent', NOW + 2).process.value, 'alive_confirmed');
  assert.equal(f.feed.snapshot().projection.runs[0].decision_id, first.runs[0].decision_id);
  f.decision('parent', NOW + 2 + SESSION_SCAN_VALID_MS);
  assert.notEqual(f.feed.snapshot().projection.runs[0].decision_id, first.runs[0].decision_id);
  const restarted = scan(NOW + 3, { ...PARENT, procStart: 'parent-B' });
  assert.notEqual(restarted.runs[0].decision_id, first.runs[0].decision_id);
  const otherPid = scan(NOW + 4, { ...PARENT, pid: 42 });
  assert.notEqual(otherPid.runs[0].decision_id, restarted.runs[0].decision_id);
  f.scan(NOW + 5, { sessions: [], processes: [] }); f.decision('parent', NOW + 5);
  assert.notEqual(f.feed.snapshot().projection.runs[0].decision_id, first.runs[0].decision_id);
});

test('判定の表示が同じでも、未確認プロセスの pid と procStart を ID で区別する', t => {
  const f = fixture(t); f.run('parent');
  const ids = new Set();
  for (const process of [PARENT, { ...PARENT, pid: 42 }, { ...PARENT, procStart: 'parent-B' }]) {
    f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation: 1,
      pid: process.pid, start_fingerprint: process.procStart }, NOW, 'host-claude');
    assert.equal(f.decision('parent', NOW).process.value, 'unverified');
    ids.add(f.feed.snapshot().projection.runs[0].decision_id);
  }
  assert.equal(ids.size, 3);
});

test('古い申告 running/idle を採らず、api が期限と理由を配り seq 不変の再評価でも Unknown へ変える', t => {
  const f = fixture(t); f.run('parent');
  assert.equal(f.decision('parent', NOW).display.label, 'Unknown');
  f.native('parent', start());
  assert.equal(f.decision('parent', NOW).display.label, 'Working');
  const workingId = f.feed.snapshot().projection.runs[0].decision_id;
  const seq = f.feed.snapshot().seq;
  const patch = f.feed.refresh(NOW + 300_000);
  assert.ok(patch && patch !== 'resync'); assert.equal(patch.seq, seq); assert.equal(patch.evaluated_at, NOW + 300_000);
  const d = f.decision('parent', NOW + 300_000);
  assert.equal(d.display.label, 'Unknown'); assert.equal(d.turn.reason, 'progress_expired');
  assert.ok(d.turn.evidenceIds.length); assert.equal(d.evaluatedAt, NOW + 300_000);
  const expired = f.feed.snapshot().projection;
  assert.notEqual(expired.runs[0].decision_id, workingId);
  assert.ok(expired.state_decisions.some(row => row.id === expired.runs[0].decision_id));
});

for (const [name, row, source] of [
  ['Claude Esc', { type: 'user', promptId: 'turn', message: { content: '[Request interrupted by user]' } }, 'claude'],
  ['Codex turn_aborted', { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn' } }, 'codex'],
  ['Codex interrupted', { method: 'turn/completed', params: { turn: { id: 'turn', status: 'interrupted' } } }, 'codex'],
] as const) test(`${name}: 確かな中断は Idle、後続の新 turn は Working`, t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', row, NOW + 1, source);
  assert.equal(f.decision('parent', NOW + 1).display.label, 'Idle');
  f.native('parent', start('next'), NOW + 2); assert.equal(f.decision('parent', NOW + 2).display.label, 'Working');
});

for (const hook of ['Stop', 'SubagentStop']) test(`${hook} は完了を捏造せず境界不明`, t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
  f.native('parent', { hook_event_name: hook, prompt_id: 'turn' }, NOW + 2, 'hook');
  const d = f.decision('parent', NOW + 2); assert.equal(d.display.label, 'Unknown'); assert.equal(d.turn.reason, 'boundary_unavailable');
});

test('親の session に届く子の SubagentStop は親の turn の境界にしない', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
  // 本番の hook 事実と同じく、親の run に hook の入力をそのまま載せる。
  const childStop = (agent: string, at: number) => f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation: 1,
    last_evidence: { hook_event_name: 'SubagentStop', input: { session_id: 'parent', agent_id: agent, agent_type: '' } } }, at, 'hook');
  childStop('internal', NOW + 2);
  f.native('parent', { hook_event_name: 'SubagentStop', agent_id: 'named', prompt_id: 'turn' }, NOW + 2, 'hook');
  assert.equal(f.decision('parent', NOW + 2).display.label, 'Working');
  f.native('parent', { type: 'system', subtype: 'turn_duration', promptId: 'turn' }, NOW + 3);
  childStop('later', NOW + 4);
  const d = f.decision('parent', NOW + 4); assert.equal(d.display.label, 'Idle'); assert.equal(d.turn.value, 'completed');
});

test('親より前の時刻の PostToolUse を挟んでも、turn_duration を祖先の turn に対応させる', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start());
  f.native('parent', { type: 'assistant', uuid: 'call', parentUuid: 'user:turn', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'agent', name: 'Agent' }] } }, NOW + 1);
  // 実物と同じく、PostToolUse の attachment は親の tool_result より前の時刻を持つ。
  f.native('parent', { type: 'attachment', uuid: 'post', parentUuid: 'result', attachment: { type: 'hook_success', hookEvent: 'PostToolUse', toolUseID: 'agent' } }, NOW + 2);
  f.native('parent', { type: 'user', uuid: 'result', parentUuid: 'call', promptId: 'turn', message: { content: [{ type: 'tool_result', tool_use_id: 'agent' }] } }, NOW + 3);
  f.native('parent', { type: 'assistant', uuid: 'reply', parentUuid: 'post', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }, NOW + 4);
  f.native('parent', { type: 'attachment', uuid: 'stop', parentUuid: 'reply', attachment: { type: 'hook_success', hookEvent: 'Stop' } }, NOW + 5);
  f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation: 1,
    last_evidence: { hook_event_name: 'Stop', input: { session_id: 'parent', prompt_id: 'turn' } } }, NOW + 5, 'hook');
  f.native('parent', { type: 'system', subtype: 'stop_hook_summary', uuid: 'summary', parentUuid: 'stop' }, NOW + 6);
  f.native('parent', { type: 'system', subtype: 'turn_duration', uuid: 'duration', parentUuid: 'summary' }, NOW + 7);
  const d = f.decision('parent', NOW + 7); assert.equal(d.display.label, 'Idle'); assert.equal(d.turn.value, 'completed');
});

test('長い tool は生存確認で保持し、走査失敗は期限を延ばさず正確な境界で Unknown', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
  f.scan(NOW + 310_000);
  const d = f.decision('parent', NOW + 310_000); assert.equal(d.display.label, 'Working'); assert.equal(d.turn.reason, 'running_tool');
  f.scan(NOW + 320_000, { status: 'failed', sessions: [], processes: [] });
  assert.equal(f.decision('parent', NOW + 320_000).observation[0].state, 'failed');
  assert.equal(f.decision('parent', NOW + 310_000 + SESSION_SCAN_VALID_MS - 1).display.label, 'Working');
  assert.equal(f.decision('parent', NOW + 310_000 + SESSION_SCAN_VALID_MS).display.label, 'Unknown');
  f.reopen(); assert.equal(f.decision('parent', NOW + 310_000 + SESSION_SCAN_VALID_MS).display.label, 'Unknown');
});

test('起動前の親の組を子へ固定し、再起動・api 再起動で別の親を引き継がない', t => {
  const f = fixture(t); f.run('parent'); f.scan(NOW); f.run('agent-child', NOW + 1, 'subagent');
  f.append('relation.created', 'relation:child', { type: 'delegated', from_id: f.id('parent'), to_id: f.id('agent-child'), active: true, confidence: 'confirmed', evidence: {} }, NOW + 1);
  f.native('agent-child', start(), NOW + 1); f.native('agent-child', tool(), NOW + 2);
  f.scan(NOW + 310_000); assert.equal(f.decision('agent-child', NOW + 310_000).display.label, 'Working');
  const restarted = { pid: 42, procStart: 'parent-B' };
  f.scan(NOW + 311_000, { sessions: [{ ...restarted, sessionId: 'parent', startedAt: NOW + 311_000 }], processes: [restarted] });
  const d = f.decision('agent-child', NOW + 311_000); assert.equal(d.display.label, 'Unknown'); assert.equal(d.process.reason, 'owner_restarted');
  f.reopen(); assert.equal(f.decision('agent-child', NOW + 311_000).process.reason, 'owner_restarted');
});

test('起動時の親が未記録の既存の子は、現在の親の生存で埋めない', t => {
  const f = fixture(t); f.run('parent'); f.run('agent-child', NOW + 1, 'subagent');
  f.append('relation.created', 'relation:child', { type: 'delegated', from_id: f.id('parent'), to_id: f.id('agent-child'), active: true, confidence: 'confirmed', evidence: {} });
  f.native('agent-child', start(), NOW + 1); f.native('agent-child', tool(), NOW + 2); f.scan(NOW + 310_000);
  assert.equal(f.decision('agent-child', NOW + 310_000).process.reason, 'missing_evidence');
});

for (const status of ['stopped', 'completed']) test(`親の task-notification ${status} は task-id と通知時の子 turn にだけ対応する`, t => {
  const f = fixture(t); f.run('parent'); f.scan(NOW); f.run('agent-child', NOW + 1, 'subagent');
  f.append('relation.created', 'relation:child', { type: 'delegated', from_id: f.id('parent'), to_id: f.id('agent-child'), active: true, confidence: 'confirmed', evidence: {} });
  f.native('agent-child', start('child-turn'), NOW + 1); f.native('agent-child', tool('child-turn'), NOW + 2);
  f.native('parent', { type: 'queue-operation', operation: 'enqueue', promptId: 'parent-turn', content: `<task-notification><task-id>child</task-id><status>${status}</status></task-notification>` }, NOW + 3);
  assert.equal(f.decision('agent-child', NOW + 3).display.label, status === 'stopped' ? 'Unknown' : 'Idle');
  f.native('agent-child', start('new-child-turn'), NOW + 4);
  assert.equal(f.decision('agent-child', NOW + 4).display.label, 'Working');
});

test('承認・入力待ちは表示表を守り、heartbeat だけでは待ちの期限を延長しない', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start());
  f.native('parent', { hook_event_name: 'Notification', prompt_id: 'turn', notification_type: 'permission_prompt' }, NOW + 1, 'hook');
  assert.equal(f.decision('parent', NOW + 2).display.label, 'Needs approval');
  f.scan(NOW + 300_001);
  assert.equal(f.decision('parent', NOW + 300_001).display.label, 'Unknown');
});

test('SessionEnd は Closed、同じ run の新 turn で Working。投影版を変えない', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start());
  f.native('parent', { hook_event_name: 'SessionEnd', prompt_id: 'turn' }, NOW + 1, 'hook');
  assert.equal(f.decision('parent', NOW + 1).display.label, 'Closed');
  const generation = f.feed.snapshot().generation;
  f.native('parent', start('new'), NOW + 2);
  assert.equal(f.decision('parent', NOW + 2).display.label, 'Working');
  assert.equal(f.feed.snapshot().generation, generation);
});

test('sessions 走査は成功・部分破損・全体失敗と照会完了時刻を記録する', async t => {
  const f = fixture(t), directory = join(f.directory, 'sessions'); mkdirSync(directory);
  writeFileSync(join(directory, '41.json'), JSON.stringify({ ...PARENT, sessionId: 'parent', startedAt: NOW - 1, status: 'busy', statusUpdatedAt: NOW }));
  const read = () => Promise.resolve(new Map([[41, PARENT.procStart]]));
  const good = await scanSessions(directory, read, () => NOW);
  assert.equal(good.status, 'succeeded'); assert.equal(good.at, NOW); assert.equal(good.sessions[0].statusUpdatedAt, NOW);
  writeFileSync(join(directory, 'broken.json'), '{');
  assert.equal((await scanSessions(directory, read, () => NOW + 1)).status, 'partial');
  assert.equal((await scanSessions(directory, async () => { throw new Error('ps denied'); }, () => NOW + 2)).status, 'failed');
  assert.equal((await scanSessions(join(directory, 'missing'), read, () => NOW + 3)).status, 'failed');
});

for (const asynchronous of [true, false]) for (const encoded of [false, true]) test(`親の Agent の結果を子の試行へ結び、起動を完了と混ぜない: async=${asynchronous}, string=${encoded}`, t => {
  const f = fixture(t); f.run('parent'); f.run('agent-child', NOW + 1, 'subagent');
  f.append('relation.created', 'relation:child', { type: 'delegated', from_id: f.id('parent'), to_id: f.id('agent-child'), active: true, confidence: 'confirmed', evidence: {} });
  f.native('agent-child', start('child-turn'), NOW + 1);
  f.native('parent', { type: 'assistant', promptId: 'parent-turn', message: { content: [{ type: 'tool_use', id: 'call', name: 'Agent', input: { run_in_background: encoded ? String(asynchronous) : asynchronous } }] } }, NOW + 2);
  f.native('parent', { type: 'user', promptId: 'parent-turn', message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] }, toolUseResult: {
    agentId: 'child', status: asynchronous ? 'async_launched' : 'completed', isAsync: encoded ? String(asynchronous) : asynchronous, content: [{ type: 'text', text: 'answer' }],
  } }, NOW + 3);
  const decision = f.decision('agent-child', NOW + 3);
  assert.equal(decision.result.requiredStage, asynchronous ? 'reported' : 'responded');
  assert.equal(decision.result.stage, asynchronous ? 'launched' : 'responded');
  assert.equal(decision.display.result, asynchronous ? null : 'Done');
  assert.equal(decision.display.label, asynchronous ? 'Working' : 'Idle');
});

test('remote の会話へローカル sessions の不在を流用しない', t => {
  const f = fixture(t); f.run('remote');
  f.append('conversation.updated', `conversation:${f.id('remote')}`, { connection_id: 'ssh', cwd: '/remote/repo' });
  f.native('remote', start()); f.scan(NOW + 1, { sessions: [], processes: [] });
  const d = f.decision('remote', NOW + 1);
  assert.equal(d.display.label, 'Working'); assert.equal(d.hosting.value, 'unknown'); assert.deepEqual(d.observation, []);
});

test('後の成功走査と API 再起動でも、最初の物理終了の証拠は消えない', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
  f.scan(NOW + 2); assert.equal(f.decision('parent', NOW + 2).display.label, 'Working');
  f.scan(NOW + 3, { sessions: [], processes: [] });
  assert.equal(f.decision('parent', NOW + 3).display.label, 'Stopped');
  for (let index = 4; index < 40; index++) f.scan(NOW + index);
  f.reopen();
  const state = f.decision('parent', NOW + 39);
  assert.equal(state.display.label, 'Stopped');
  assert.deepEqual(state.process.evidenceIds, [`scan:${NOW + 3}`]);
});

test('将来の走査を先に保存しても、評価時刻の証拠だけで判定する', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
  f.scan(NOW + 2); f.scan(NOW + 300_001, { sessions: [], processes: [] });
  const state = f.decision('parent', NOW + 2);
  assert.equal(state.display.label, 'Working'); assert.equal(state.process.value, 'alive_confirmed');
  assert.equal(f.decision('parent', NOW + 300_000).display.label, 'Working');
  assert.equal(f.decision('parent', NOW + 300_001).display.label, 'Stopped');
});

test('管理ホストの pid と開始値に対応する終了は走査がなくても Stopped', t => {
  const f = fixture(t); f.run('parent');
  f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation: 1, pid: PARENT.pid, start_fingerprint: PARENT.procStart }, NOW, 'host-claude');
  f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation: 1, end_evidence: { kind: 'host_exit' } }, NOW + 1, 'host-claude');
  assert.equal(f.decision('parent', NOW + 1).display.label, 'Stopped');
});

test('古い履歴の時刻由来の世代番号より、後から起動した hook の実行を選ぶ', t => {
  const f = fixture(t); f.run('parent');
  f.append('run.created', 'run:old-history', { conversation_id: f.id('parent'), generation: NOW, started_ts: new Date(NOW).toISOString() });
  f.append('run.created', 'run:new-hook', { conversation_id: f.id('parent'), generation: 2, started_ts: new Date(NOW + 1000).toISOString() }, NOW + 1000, 'hook');
  f.append('run.updated', 'run:new-hook', { conversation_id: f.id('parent'), generation: 2,
    last_evidence: { hook_event_name: 'UserPromptSubmit', input: { prompt_id: 'new-turn' } } }, NOW + 1001, 'hook');
  assert.equal(f.decision('parent', NOW + 1002).display.label, 'Working');
  assert.equal(f.feed.current.conversations.get(f.id('parent'))!.generation, 2);
});

for (const exited of [false, true]) test(`保持期限後も判定・配信値と再起動後の証拠を維持する: exited=${exited}`, t => {
  const kept = fixture(t), pruned = fixture(t);
  const baseline = new DatabaseSync(kept.path);
  const database = new DatabaseSync(pruned.path);
  t.after(() => { baseline.close(); database.close(); });
  baseline.exec(`CREATE TRIGGER keep_scans BEFORE DELETE ON api_state_scans BEGIN SELECT RAISE(IGNORE); END`);
  for (const f of [kept, pruned]) {
    f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
    f.scan(NOW + 2); f.decision('parent', NOW + 2);
    if (exited) { f.scan(NOW + 3, { sessions: [], processes: [] }); f.decision('parent', NOW + 3); }
  }
  for (let index = 1; index <= 100; index++) {
    const at = NOW + index * 10_000;
    for (const f of [kept, pruned]) {
      f.scan(at, index % 3 === 0 ? { status: 'failed', sessions: [], processes: [] } : {});
      f.decision('parent', at);
    }
    assert.deepEqual(pruned.feed.snapshot(), kept.feed.snapshot());
  }
  assert.ok(Number(database.prepare('SELECT count(*) AS count FROM api_state_scans').get()!.count)
    < Number(baseline.prepare('SELECT count(*) AS count FROM api_state_scans').get()!.count));
  for (const f of [kept, pruned]) { f.reopen(); f.decision('parent', NOW + 1_000_000); }
  assert.deepEqual(pruned.feed.snapshot(), kept.feed.snapshot());
  if (exited) assert.deepEqual(pruned.decision('parent', NOW + 1_000_000).process.evidenceIds, [`scan:${NOW + 3}`]);
  else assert.equal(pruned.decision('parent', NOW + 1_000_000).turn.reason, 'running_tool');
});

test('10秒周期の走査は日をまたいでも保持期限と対象数に応じた件数に収まる', t => {
  const f = fixture(t);
  const database = new DatabaseSync(f.path);
  t.after(() => database.close());
  for (let index = 0; index <= 17_280; index++) {
    const at = NOW + index * 10_000;
    f.scan(at);
    f.feed.refresh(at);
    if (index >= 31) assert.ok(Number(database.prepare('SELECT count(*) AS count FROM api_state_scans').get()!.count) <= 31);
  }
  assert.equal(database.prepare('SELECT count(*) AS count FROM api_state_scans').get()!.count, 31);
});

test('UTC procStart と JST ps を epoch で照合し、保存済み所持者と誤った不在も修復する', async t => {
  const zone = process.env.TZ; process.env.TZ = 'Asia/Tokyo';
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  const f = fixture(t); f.run('parent'); f.native('parent', start()); f.native('parent', tool(), NOW + 1);
  const utc = 'Wed Oct 14 04:50:09 2026', local = 'Wed Oct 14 13:50:09 2026';
  const owner = { pid: 41658, procStart: utc };
  const directory = join(f.directory, 'sessions'); mkdirSync(directory);
  writeFileSync(join(directory, '41658.json'), JSON.stringify({ ...owner, sessionId: 'parent', startedAt: NOW - 1, status: 'busy', statusUpdatedAt: NOW + 310_000 }));
  const scan = await scanSessions(directory, async () => new Map([[41658, local]]), () => NOW + 310_001);
  const epoch = String(Date.parse('2026-10-14T04:50:09Z'));
  assert.equal(scan.sessions[0].procStart, epoch); assert.equal(scan.processes[0].procStart, epoch);
  const db = new DatabaseSync(f.path);
  db.prepare('INSERT INTO api_run_owners VALUES (?, ?)').run(`${f.id('parent')}:1`, JSON.stringify(owner));
  db.prepare('INSERT INTO api_state_scans VALUES (?, ?)').run('old-scan', JSON.stringify({ ...scan, id: 'old-scan', at: NOW + 2,
    sessions: [{ ...owner, sessionId: 'parent', startedAt: NOW - 1 }], processes: [{ pid: 41658, procStart: local }] }));
  f.reopen(); f.feed.recordScan(scan);
  const decision = f.decision('parent', scan.at);
  assert.equal(decision.display.label, 'Working'); assert.equal(decision.process.value, 'alive_confirmed'); assert.equal(decision.hosting.value, 'hosted');
  assert.equal(JSON.parse(String(db.prepare('SELECT data FROM api_run_owners').get()!.data)).procStart, epoch);
  f.reopen(); assert.equal(f.decision('parent', scan.at).display.label, 'Working'); db.close();
});

test('total_tokens_reminder を挟む UUID 連鎖を取り込み、再読と再起動でも turn_duration が同じ turn を閉じる', async t => {
  const { observeClaudeHistories } = await import('../src/service/claude-reader.ts');
  const f = fixture(t); const path = join(f.directory, 'chain.jsonl');
  const rows = [
    { type: 'user', uuid: '4edcf548-e60b-4cd4-b608-0ca8ff71a534', parentUuid: null, message: { role: 'user', content: 'work' } },
    { type: 'attachment', uuid: '52698412-ec73-4a2a-81d6-c5550508c376', parentUuid: '4edcf548-e60b-4cd4-b608-0ca8ff71a534', attachment: { type: 'total_tokens_reminder', text: 'private tokens' } },
    { type: 'system', subtype: 'turn_duration', uuid: '99f3317f-d905-4ca6-a731-dbe42c4c8e60', parentUuid: '52698412-ec73-4a2a-81d6-c5550508c376', durationMs: 2 },
  ].map((row, i) => ({ ...row, sessionId: 'chain', timestamp: new Date(NOW + i).toISOString() }));
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  let legacy = true;
  const ingest = () => observeClaudeHistories({ ...f.ledger, append(input) {
    if (legacy) {
      if (input.source_event_id.endsWith(':uuid-chain-backfill')) return { status: 'duplicate', seq: 0, fact_id: 'legacy-omission' };
      for (const fact of expandNativeEvidence(input as import('../../core/src/ledger/index.ts').Fact)) {
        if (!JSON.stringify(fact.payload).includes('"uuid":"52698412-ec73-4a2a-81d6-c5550508c376"')) f.ledger.append(fact as FactInput);
      }
      return { status: 'duplicate', seq: 0, fact_id: 'legacy-omission' };
    }
    return f.ledger.append(input);
  } }, f.directory, f.ledger.readSince(0, Number.MAX_SAFE_INTEGER), undefined, [path]);
  ingest(); assert.equal(f.decision('chain', Date.now()).display.label, 'Unknown');
  legacy = false;
  ingest();
  const facts = f.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.ok(facts.flatMap(expandNativeEvidence).some(fact => JSON.stringify(fact.payload).includes('"uuid":"52698412-ec73-4a2a-81d6-c5550508c376"')));
  assert.equal(JSON.stringify(facts).includes('private tokens'), false);
  assert.equal(f.decision('chain', Date.now()).display.label, 'Idle');
  ingest(); assert.equal(f.ledger.readSince(0, Number.MAX_SAFE_INTEGER).length, facts.length);
  f.reopen(); assert.equal(f.decision('chain', Date.now()).turn.reason, 'turn_finished');
});

test('承認・入力待ちでも同じ turn の開始時刻を保持する', t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start());
  for (const state of ['waiting_approval', 'waiting_input']) {
    f.append('run.state_changed', 'run:parent', { state, turn_id: 'turn' }, NOW + (state === 'waiting_approval' ? 1 : 2), 'host-claude');
    f.decision('parent', NOW + 3);
    assert.equal(f.feed.current.conversations.get(f.id('parent'))!.turn_started_ts, new Date(NOW).toISOString());
  }
});

test('走査を受け取らない worker の CurrentState は feed の死亡証拠を掃除しない', async t => {
  const { CurrentState } = await import('../src/service/current-state.ts');
  const f = fixture(t);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  const worker = new CurrentState(db, id => id, false);
  f.run('parent'); f.native('parent', start()); f.scan(NOW + 1); f.decision('parent', NOW + 1);
  f.scan(NOW + 2, { sessions: [], processes: [] }); f.decision('parent', NOW + 2);
  f.scan(NOW + 310_000); f.decision('parent', NOW + 310_000);
  worker.refresh(0, NOW + 600_000);
  assert.ok(db.prepare('SELECT 1 FROM api_state_scans WHERE id = ?').get(`scan:${NOW + 2}`));
  f.reopen(); assert.equal(f.decision('parent', NOW + 600_000).display.label, 'Stopped');
});

test('大量の無関係な OS プロセスを含む走査でも、同じ所有者の判定と短い refresh を保つ', t => {
  const f = fixture(t);
  for (let index = 0; index < 120; index++) { f.run(`session-${index}`); f.native(`session-${index}`, start()); }
  f.feed.refresh(NOW);
  const sessions = Array.from({ length: 120 }, (_, index) => ({ sessionId: `session-${index}`, pid: index + 1, procStart: `epoch-${index}`, startedAt: NOW - 1, status: 'busy', statusUpdatedAt: NOW }));
  const processes = Array.from({ length: 12000 }, (_, index) => ({ pid: index + 1, procStart: `epoch-${index}` }));
  f.scan(NOW + 1, { sessions, processes }); f.feed.refresh(NOW + 1);
  f.scan(NOW + 2, { sessions, processes });
  const started = performance.now(); f.feed.refresh(NOW + 2); const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `refresh blocked for ${elapsed.toFixed(1)} ms`);
  for (let index = 0; index < 120; index++) {
    const decision = f.feed.current.conversations.get(f.id(`session-${index}`))!.decision as StateDecision;
    assert.equal(decision.display.label, 'Working'); assert.equal(decision.process.value, 'alive_confirmed');
  }
  t.diagnostic(`120 conversations / 12000 processes refresh: ${elapsed.toFixed(1)} ms`);
});

for (const event of ['Notification', 'PreToolUse', 'UserPromptSubmit']) test(`agent_id 付きの ${event} は親自身の証拠を保つ`, t => {
  const f = fixture(t); f.run('parent'); f.native('parent', start());
  f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation: 1,
    last_evidence: { hook_event_name: event, input: { agent_id: 'child', prompt_id: 'turn', notification_type: 'permission_prompt' } } }, NOW + 1, 'hook');
  assert.equal(f.decision('parent', NOW + 1).display.label, event === 'Notification' ? 'Needs approval' : 'Working');
  assert.ok(f.decision('parent', NOW + 1).turn.evidenceIds.some(id => id.endsWith(event === 'Notification' ? ':approval' : event === 'PreToolUse' ? ':progress' : ':start')));
});

test('履歴競合と subagent があっても、一件の追記で無関係な実行を読み直さない', t => {
  const f = fixture(t);
  for (const name of ['parent', 'conflicted', ...Array.from({ length: 12 }, (_, i) => `agent-${i}`)]) {
    f.run(name, NOW, name.startsWith('agent-') ? 'subagent' : 'interactive');
    f.append('run.updated', `run:${name}`, { conversation_id: f.id(name), generation: 1,
      last_evidence: { native_source: 'claude', native_record: start(), file_id: `${name}.jsonl` } });
  }
  f.append('observation.unsupported', 'observation:conflict', { file_path: '/copy/conflicted.jsonl',
    reason: 'Conflicting history; existing facts retained', rows: [{ at: new Date(NOW).toISOString(), uuid: 'user:turn' }] });
  f.decision('parent', NOW);
  const current = f.feed.current as unknown as { readEvidence: (...args: unknown[]) => void };
  const read = current.readEvidence.bind(current); let reads = 0;
  current.readEvidence = (...args) => { reads++; read(...args); };
  f.native('parent', tool(), NOW + 1); f.decision('parent', NOW + 1);
  assert.equal(reads, 2, 'only the updated run and the conflicted file are reread');
  const incremental = f.feed.snapshot().projection;
  f.reopen(); f.decision('parent', NOW + 1);
  assert.deepEqual(f.feed.snapshot().projection, incremental);
});

test('通常の原記録を保持せず、親の後着通知だけで子の相関を更新する', t => {
  const f = fixture(t); f.run('parent'); f.run('agent-child', NOW + 1, 'subagent');
  f.append('relation.created', 'relation:child', { type: 'delegated', from_id: f.id('parent'), to_id: f.id('agent-child'), active: true, confidence: 'confirmed' });
  f.native('parent', start()); f.native('agent-child', start('child-turn'), NOW + 1);
  for (let index = 0; index < 100; index++) f.native('parent', { type: 'assistant', promptId: 'turn', message: { content: [{ type: 'text', text: 'unneeded'.repeat(1000) }] } }, NOW + index + 1);
  f.decision('parent', NOW + 101);
  assert.equal((f.feed.current.runs.get(`${f.id('parent')}:1`)!.records as unknown[] | undefined)?.length ?? 0, 0);
  const current = f.feed.current as unknown as { readEvidence: (...args: unknown[]) => void };
  const read = current.readEvidence.bind(current); let reads = 0;
  current.readEvidence = (...args) => { reads++; read(...args); };
  f.native('parent', { type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>child</task-id><status>stopped</status></task-notification>' }, NOW + 102);
  assert.equal(f.decision('agent-child', NOW + 102).turn.reason, 'boundary_unavailable');
  assert.equal(reads, 1, 'parent notifications reuse the child native evidence');
  assert.equal((f.feed.current.runs.get(`${f.id('parent')}:1`)!.records as unknown[]).length, 1);
  const incremental = f.feed.snapshot().projection;
  f.append('conversation.updated', `conversation:${f.id('parent')}`, { name: 'Renamed' }, NOW + 103);
  f.decision('parent', NOW + 103);
  f.reopen(); assert.equal(f.decision('agent-child', NOW + 103).turn.reason, 'boundary_unavailable');
  assert.deepEqual(f.feed.snapshot().projection.state_decisions, incremental.state_decisions);
});

test('競合した行の turn だけに印を付け、同じファイルの別 run と後続 turn へ広げない', t => {
  const f = fixture(t); f.run('parent');
  const native = (row: object, at: number, generation = 1) => f.append('run.updated', 'run:parent', { conversation_id: f.id('parent'), generation,
    last_evidence: { native_source: 'claude', native_record: row, file_id: 'parent.jsonl' } }, at);
  native(start('old'), NOW);
  f.append('observation.unsupported', 'observation:conflict', { file_path: '/copy/parent.jsonl',
    reason: 'Conflicting history; existing facts retained', rows: [{ at: new Date(NOW).toISOString(), uuid: 'user:old' }] });
  assert.equal(f.decision('parent', NOW).conflicts.length, 1);
  native(start('next'), NOW + 1);
  assert.equal(f.decision('parent', NOW + 1).conflicts.length, 0);
  f.append('run.created', 'run:parent', { conversation_id: f.id('parent'), generation: 2, started_ts: new Date(NOW + 2).toISOString() }, NOW + 2);
  native(start('new-run'), NOW + 2, 2);
  assert.equal(f.decision('parent', NOW + 2).conflicts.length, 0);
  f.reopen(); assert.equal(f.decision('parent', NOW + 2).conflicts.length, 0);
});

test('Idle の親は進行中の子を Waiting for agents として配り、子停止・期限切れで Idle に戻す', t => {
  const f = fixture(t); f.run('parent'); f.run('agent-child', NOW + 1, 'subagent');
  f.append('relation.created', 'relation:child', { type: 'delegated', from_id: f.id('parent'), to_id: f.id('agent-child'), active: true, confidence: 'confirmed' });
  f.native('parent', start());
  f.native('parent', { type: 'assistant', promptId: 'turn', message: { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { run_in_background: true } }] } }, NOW + 1);
  f.native('parent', { type: 'user', promptId: 'turn', message: { content: [{ type: 'tool_result', tool_use_id: 'agent' }] }, toolUseResult: { agentId: 'child', status: 'async_launched', isAsync: true } }, NOW + 2);
  f.native('parent', { type: 'system', subtype: 'turn_duration', promptId: 'turn' }, NOW + 3);
  f.native('agent-child', start('child-turn'), NOW + 1);
  const parent = () => f.feed.current.conversations.get(f.id('parent'))!;
  f.decision('parent', NOW + 3);
  assert.equal((parent().decision as { display: { label: string } }).display.label, 'Waiting for agents');
  assert.equal((parent().decision as StateDecision).turn.value, 'completed');
  assert.equal(parent().state, 'waiting_agents');
  const waitingId = parent().decision_id;
  const snapshot = f.feed.snapshot().projection;
  assert.ok(snapshot.conversations.some(row => row.id === f.id('parent') && row.state === 'waiting_agents'));
  f.reopen(); f.decision('parent', NOW + 3); assert.equal(parent().decision_id, waitingId);
  f.scan(NOW + 4, { status: 'failed', sessions: [], processes: [] }); f.decision('parent', NOW + 4);
  const stableId = parent().decision_id;
  f.scan(NOW + 5, { status: 'failed', sessions: [], processes: [] });
  assert.equal(f.feed.refresh(NOW + 5), undefined, 'unchanged Waiting for agents is not redistributed on every scan');
  assert.equal(parent().decision_id, stableId);
  const patch = f.feed.refresh(NOW + 300_001);
  assert.ok(patch && patch !== 'resync' && patch.changes.runs?.upsert.some(row => row.state === 'idle'));
  assert.equal(parent().state, 'idle');
  f.native('agent-child', start('again'), NOW + 300_002);
  f.decision('parent', NOW + 300_002); assert.equal(parent().state, 'waiting_agents');
  f.native('parent', { type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>child</task-id><status>stopped</status></task-notification>' }, NOW + 300_003);
  f.decision('parent', NOW + 300_003); assert.equal(parent().state, 'idle');
});

test('直近7日の turn 鍵欠落率は提供元別に集計し、古い実行と未来を除き、用途不明の実行を分母に含める', t => {
  const f = fixture(t); f.run('keyed'); f.native('keyed', start()); f.run('missing');
  f.run('old', NOW - 8 * 86400_000); f.run('future', NOW + 1);
  // 開始と終了だけでは依頼がないと証明できず、欠落に数える。
  f.run('session-only');
  for (const [hook, at] of [['SessionStart', NOW], ['SessionEnd', NOW + 1]] as const) f.append('run.updated', 'run:session-only', { conversation_id: f.id('session-only'), generation: 1,
    last_evidence: { hook_event_name: hook, input: { session_id: 'session-only' } } }, at - 2, 'hook');
  f.append('conversation.created', 'conversation:codex', { provider: 'codex', native_id: 'codex', type: 'interactive' });
  f.append('run.created', 'run:codex', { conversation_id: 'codex', generation: 1, started_ts: new Date(NOW).toISOString() });
  f.decision('keyed', NOW);
  assert.deepEqual(f.feed.current.readTurnCoverage(NOW - 7 * 86400_000), {
    claude: { runs: 3, missing: 2, ratio: 2 / 3 }, codex: { runs: 1, missing: 1, ratio: 1 },
  });
});

for (const withStart of [true, false]) test(`事実の多い実行への追記は前回の読み取りの続きから読み、全事実を読み直した結果と一致する（開始時刻${withStart ? 'あり' : 'を事実から補う'}）`, async t => {
  const { CurrentState } = await import('../src/service/current-state.ts');
  const f = fixture(t);
  if (withStart) f.run('big');
  else {
    // Codex の観測と同じく、開始時刻のない run.created から実行を始める。
    f.append('conversation.created', `conversation:${f.id('big')}`, { provider: 'claude', native_id: 'big', type: 'interactive', origin: 'observed' }, NOW);
    f.append('run.created', 'run:big', { conversation_id: f.id('big'), generation: 1, state: 'unknown', reason: 'missing_state_evidence' }, NOW);
  }
  const runId = `${f.id('big')}:1`;
  let random = 7;
  const next = (limit: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % limit; };
  let clock = NOW, serial = 0;
  // 一つの turn は依頼・道具の呼び出し・結果・時刻の前後する PostToolUse・完了の原記録からなる。
  const turn = (name: string) => {
    const at = (clock += 1000);
    f.native('big', { type: 'user', uuid: `${name}:user`, promptId: name, message: { content: 'work' } }, at);
    f.native('big', { type: 'assistant', uuid: `${name}:call`, parentUuid: `${name}:user`, message: { content: [{ type: 'tool_use', id: `${name}:tool`, name: 'Bash' }] } }, at + 10);
    f.native('big', { type: 'attachment', uuid: `${name}:post`, parentUuid: `${name}:result`, attachment: { type: 'hook_success', hookEvent: 'PostToolUse', toolUseID: `${name}:tool` } }, at + 15);
    f.native('big', { type: 'user', uuid: `${name}:result`, parentUuid: `${name}:call`, message: { content: [{ type: 'tool_result', tool_use_id: `${name}:tool` }] } }, at + 20);
    f.native('big', { type: 'system', subtype: 'turn_duration', uuid: `${name}:done`, parentUuid: `${name}:result` }, at + 30);
  };
  for (let index = 0; index < 110; index++) turn(`t${index}`);
  const db = new DatabaseSync(f.path);
  t.after(() => db.close());
  const seq = () => Number(db.prepare('SELECT max(seq) AS seq FROM facts').get()!.seq);
  f.service.catchUp();
  const incremental = new CurrentState(db, id => id, false);
  incremental.refresh(seq(), clock);
  const states = (incremental as unknown as { evidenceStates: Map<string, unknown> }).evidenceStates;
  assert.ok(states.has(runId), 'large runs keep the reading state');
  const read = (state: InstanceType<typeof CurrentState>) => {
    const context = (state as unknown as { contexts: Map<string, { input?: unknown; records?: unknown; files?: unknown; started_ts?: unknown }> }).contexts.get(runId)!;
    return { input: context.input, records: context.records, files: context.files, started: context.started_ts, decision: state.conversations.get(f.id('big'))?.decision };
  };
  let continuedCount = 0, earlier = 0;
  for (let round = 0; round < 40; round++) {
    const kind = next(6);
    const before = states.get(runId);
    // 0〜1 は後の時刻の追記、2 は証拠のない前の時刻の事実、3 は前の時刻、4 は後から届く親、5 は既知の uuid を別の親で読み直す。
    if (kind <= 1) turn(`n${round}`);
    else if (kind === 2) f.append(++earlier % 2 ? 'run.updated' : 'run.created', 'run:big', { conversation_id: f.id('big'), generation: 1, model: `m${round}` },
      earlier % 2 ? NOW - 1000 * round : NOW - round);
    else if (kind === 3) f.native('big', { type: 'assistant', uuid: `late${round}`, parentUuid: 't3:user', message: { content: [{ type: 'text', text: 'late' }] } }, NOW + 500);
    else if (kind === 4) {
      f.native('big', { type: 'assistant', uuid: `orphan${round}`, parentUuid: `missing${round}`, message: { content: [{ type: 'text', text: 'x' }] } }, (clock += 1000));
      f.service.catchUp(); incremental.refresh(seq(), clock);
      f.native('big', { type: 'user', uuid: `missing${round}`, promptId: `p${round}`, message: { content: 'work' } }, (clock += 1000));
    } else f.native('big', { type: 'user', uuid: 't5:result', parentUuid: 't9:call', message: { content: [{ type: 'tool_result', tool_use_id: 't9:tool' }] } }, (clock += 1000));
    serial++;
    f.service.catchUp();
    incremental.refresh(seq(), clock + 1);
    if (states.get(runId) === before) continuedCount++;
    const fresh = new CurrentState(db, id => id, false);
    fresh.refresh(seq(), clock + 1);
    assert.deepEqual(read(incremental), read(fresh), `round=${round}, kind=${kind}`);
  }
  assert.ok(continuedCount >= 8, `continued ${continuedCount} of ${serial}`);
  assert.ok(continuedCount < serial, 'out-of-order, late parents and re-read uuids fall back to a full read');
});

for (const withEvidence of [false, true]) test(`P3: 後着した正式な開始時刻を証拠キャッシュの補完値で戻さない（evidence=${withEvidence}）`, async t => {
  const { CurrentState } = await import('../src/service/current-state.ts');
  const f = fixture(t);
  f.append('conversation.created', `conversation:${f.id('big')}`, { provider: 'claude', native_id: 'big', origin: 'observed', type: 'interactive' });
  f.append('run.created', 'run:big', { conversation_id: f.id('big'), generation: 1 });
  for (let i = 0; i < 501; i++) f.native('big', start(`turn-${i}`), NOW + i + 1);
  f.decision('big', NOW + 1000);
  f.append('run.updated', 'run:big', { started_ts: new Date(NOW + 100).toISOString(),
    ...(withEvidence ? { last_evidence: { native_source: 'claude', native_record: start('next') } } : {}) }, NOW + 1001);
  f.decision('big', NOW + 1002);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  const fresh = new CurrentState(db, id => id); fresh.refresh(f.feed.snapshot().seq, NOW + 1002);
  const id = `${f.id('big')}:1`;
  assert.equal(f.feed.current.runs.get(id)!.started_ts, new Date(NOW + 100).toISOString());
  assert.equal(f.feed.current.runs.get(id)!.started_ts, fresh.runs.get(id)!.started_ts);
});

test('P5: SessionStart と user の所属がある部分取り込み漏れを分母から隠さない', t => {
  const f = fixture(t); f.run('partial');
  f.append('run.updated', 'run:partial', { conversation_id: f.id('partial'), generation: 1,
    last_evidence: { hook_event_name: 'SessionStart', input: { session_id: 'partial' } } }, NOW, 'hook');
  f.append('message.created', 'message:request', { role: 'user', body: 'work', version: 1, body_state: 'stored' });
  f.append('message_membership.created', 'message_membership:request', { message_id: 'request', conversation_id: f.id('partial'), active: true });
  f.decision('partial', NOW);
  assert.deepEqual(f.feed.current.readTurnCoverage(NOW - 7 * 86400_000).claude, { runs: 1, missing: 1, ratio: 1 });
});

test('turn 鍵欠落率は、呼び出し側が独立した記録で依頼なしと示した鍵のない実行だけを分母から外す', t => {
  const f = fixture(t); f.run('keyed'); f.native('keyed', start()); f.run('probe', NOW, 'unattended'); f.run('partial');
  f.decision('keyed', NOW);
  const asked: string[] = [];
  const coverage = f.feed.current.readTurnCoverage(NOW - 7 * 86400_000, run => { asked.push(run.native_id); return run.type === 'unattended'; });
  assert.deepEqual(coverage.claude, { runs: 2, missing: 1, ratio: 1 / 2 });
  assert.deepEqual(asked.sort(), ['partial', 'probe'], 'turn 鍵のある実行は外す候補にしない');
});

test('P6: ホストが原記録の外に持つ turn 相関を保存し承認待ちを判定する', t => {
  const f = fixture(t); f.run('host'); f.native('host', start('host-turn'));
  f.append('run.updated', 'run:host', { conversation_id: f.id('host'), generation: 1, last_evidence: {
    native_source: 'codex', native_record: { method: 'thread/status/changed', params: { status: { type: 'active', activeFlags: ['waitingOnApproval'] } } },
    turn_id: 'host-turn',
  } }, NOW + 1, 'host-codex');
  assert.equal(f.decision('host', NOW + 2).display.label, 'Needs approval');
  f.reopen(); assert.equal(f.decision('host', NOW + 2).display.label, 'Needs approval');
});

test('P6: 圧縮した長い履歴と後着の祖先・訂正は非圧縮、再起動、再構築と同じ判定になる', async t => {
  const { createNativeEvidenceBuffer } = await import('../src/observe/native-evidence.ts');
  const { captureNativeRecord } = await import('../../core/src/state/capture.ts');
  const packed = fixture(t), plain = fixture(t);
  for (const f of [packed, plain]) f.run('big');
  const inputs: FactInput[] = [];
  for (let turn = 0; turn < 120; turn++) {
    const rows = [start(`t${turn}`),
      { type: 'assistant', uuid: `call-${turn}`, parentUuid: `user:t${turn}`, message: { content: [{ type: 'tool_use', id: `tool-${turn}`, name: 'Bash' }] } },
      { type: 'attachment', uuid: `edge-${turn}`, parentUuid: `result-${turn}`, attachment: { type: 'total_tokens_reminder' } },
      { type: 'user', uuid: `result-${turn}`, parentUuid: `call-${turn}`, message: { content: [{ type: 'tool_result', tool_use_id: `tool-${turn}` }] } },
      { type: 'system', subtype: 'turn_duration', uuid: `end-${turn}`, parentUuid: `edge-${turn}` },
    ];
    for (const [i, row] of rows.entries()) {
      const at = new Date(NOW + turn * 10 + i).toISOString();
      inputs.push({ source: 'transcript-claude', source_event_id: `native-record:file:${turn * 5 + i}:hash`, kind: 'run.updated', subject: 'run:big',
        source_ts: at, observed_ts: at, confidence: 'confirmed', cursor: null,
        payload: { conversation_id: packed.id('big'), generation: 1, last_evidence_ts: at,
          last_evidence: { native_source: 'claude', file_id: 'big.jsonl', native_record: captureNativeRecord('claude', row as never)! } } });
    }
  }
  const ingest = (batch: FactInput[]) => {
    const known = new Set(packed.ledger.readSince(0, Number.MAX_SAFE_INTEGER).flatMap(expandNativeEvidence).map(f => f.source_event_id));
    const buffer = createNativeEvidenceBuffer(known, input => { packed.ledger.append(input); });
    for (const input of batch) { buffer.add(input); plain.ledger.append(input); }
    buffer.flush();
  };
  ingest(inputs);
  const original = packed.ledger.readSince(0, 1000);
  assert.equal(original.filter(f => f.source_event_id.startsWith('native-record:')).length, 5);
  const compare = () => {
    assert.deepEqual(packed.decision('big', NOW + 3000), plain.decision('big', NOW + 3000));
    packed.reopen(); assert.deepEqual(packed.decision('big', NOW + 3000), plain.decision('big', NOW + 3000));
    packed.service.rebuild(); assert.deepEqual(packed.decision('big', NOW + 3000), plain.decision('big', NOW + 3000));
  };
  compare();
  // 読み取りの区切りと順を変えても、圧縮前の行の識別で再追記を防ぐ。
  for (let i = inputs.length; i > 0; i -= 17) ingest(inputs.slice(Math.max(0, i - 17), i).reverse());
  assert.deepEqual(packed.ledger.readSince(0, 1000), original);
  const late = { ...inputs.at(-1)!, source_event_id: 'native-record:file:late:hash', source_ts: new Date(NOW + 2000).toISOString(),
    observed_ts: new Date(NOW + 2000).toISOString(), payload: { conversation_id: packed.id('big'), generation: 1,
      last_evidence_ts: new Date(NOW + 2000).toISOString(), last_evidence: { native_source: 'claude', file_id: 'big.jsonl',
        native_record: { type: 'system', subtype: 'turn_duration', uuid: 'late-end', parentUuid: 'late-parent' } } } } as FactInput;
  ingest([late]); compare();
  ingest([{ ...late, source_event_id: 'native-record:file:parent:hash', source_ts: new Date(NOW + 1500).toISOString(),
    payload: { ...late.payload, last_evidence_ts: new Date(NOW + 1500).toISOString(), last_evidence: { native_source: 'claude', file_id: 'big.jsonl',
      native_record: { uuid: 'late-parent', parentUuid: 'end-119' } } } } as FactInput]);
  compare();
  const target = original.flatMap(expandNativeEvidence).find(f => f.source_event_id === inputs.at(-1)!.source_event_id)!;
  for (const f of [packed, plain]) f.ledger.append({ ...inputs.at(-1)!, source_event_id: 'correction', supersedes: target.fact_id,
    payload: { conversation_id: packed.id('big'), generation: 1, last_evidence: { native_source: 'claude', native_record: { uuid: 'end-119', parentUuid: 'edge-119' } } } } as FactInput);
  compare();
  assert.deepEqual(packed.ledger.readSince(0, 1000).slice(0, original.length), original);
});
