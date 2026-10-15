import assert from 'node:assert/strict';
import test from 'node:test';
import { scanCodexSessions } from '../../src/observe/codex/sessions.ts';

const ID = '01a1196d-1d5a-7f91-acbc-8d36fc56b286';
const HOME = '/fixture/.codex';
const FILE = `${HOME}/sessions/rollout-2026-10-08T00-00-00-${ID}.jsonl`;
const PS = ' 41 /vendor/bin/codex\n 42 /vendor/bin/codex-code-mode-host\n';
const START = 'Thu Oct 15 00:00:00 2026';
const NOW = Date.parse(START) + 1000;
const starts = async () => new Map([[41, START]]);

test('Codex の open file と OS の開始値を対応し、補助ホストを混ぜない', async () => {
  const scan = await scanCodexSessions(HOME, { listProcesses: () => PS, readOpenFiles: pids => {
    assert.deepEqual(pids, [41]); return `p41\nn${FILE}\n`;
  } }, () => NOW, starts);
  assert.equal(scan.status, 'succeeded'); assert.equal(scan.at, NOW); assert.equal(scan.provider, 'codex');
  assert.deepEqual(scan.sessions, [{ sessionId: ID, pid: 41, procStart: String(Date.parse(START)), startedAt: Date.parse(START) }]);
});

test('UTC の ps を epoch にした値でも Codex の startedAt は有限の同じ時刻になる', async () => {
  const epoch = Date.parse('2026-10-14T04:50:09Z');
  const scan = await scanCodexSessions(HOME, { listProcesses: () => PS, readOpenFiles: () => `p41\nn${FILE}\n` }, () => epoch + 1,
    async () => new Map([[41, String(epoch)]]));
  assert.equal(scan.sessions[0].startedAt, epoch); assert.equal(scan.processes[0].procStart, String(epoch));
});

for (const files of ['p41\nn/dev/null\n', `p41\nn${HOME}/archived_sessions/${FILE.split('/').at(-1)}\n`, `p41\nn/other/sessions/${FILE.split('/').at(-1)}\n`]) test(`対象外のファイルは所持を作らない: ${files.trim()}`, async () => {
  const scan = await scanCodexSessions(HOME, { listProcesses: () => PS, readOpenFiles: () => files }, () => NOW, starts);
  assert.equal(scan.status, 'succeeded'); assert.deepEqual(scan.sessions, []);
});
for (const failure of ['ps', 'lsof', 'bad-ps', 'bad-pid', 'missing-pid', 'bad-line', 'starts']) test(`不完全な Codex 走査 ${failure} は failed と完了時刻を返す`, async () => {
  const scan = await scanCodexSessions(HOME, {
    listProcesses: () => { if (failure === 'ps') throw new Error('Denied'); return failure === 'bad-ps' ? 'broken' : PS; },
    readOpenFiles: () => { if (failure === 'lsof') throw new Error('Denied'); return failure === 'bad-pid' ? 'p999\n' : failure === 'missing-pid' ? '' : failure === 'bad-line' ? 'x\n' : `p41\nn${FILE}\n`; },
  }, () => NOW, async () => { if (failure === 'starts') throw new Error('Denied'); return starts(); });
  assert.equal(scan.status, 'failed'); assert.equal(scan.at, NOW);
});

test('非同期走査の完了時刻を採り、取得中に主スレッドを塞がない', async () => {
  let finish!: (value: string) => void; let now = NOW;
  const pending = scanCodexSessions(HOME, { listProcesses: () => new Promise(resolve => { finish = resolve; }), readOpenFiles: () => `p41\nn${FILE}\n` }, () => now, starts);
  await new Promise(resolve => setImmediate(resolve)); now += 2000; finish(PS);
  assert.equal((await pending).at, NOW + 2000);
});
