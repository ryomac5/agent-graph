import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanSessions } from '../../src/service/session-scan.ts';

const NOW = Date.parse('2026-10-15T00:00:00Z');
for (const fault of ['missing', 'invalid-json', 'unreadable', 'invalid-pid', 'invalid-start', 'ps-denied']) test(`走査失敗 ${fault} を空の成功へ変換しない`, async t => {
  const home = mkdtempSync(join(tmpdir(), 'scan-claude-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, 'sessions');
  if (fault !== 'missing') mkdirSync(directory);
  if (fault === 'unreadable') mkdirSync(join(directory, '1.json'));
  if (fault === 'invalid-json') writeFileSync(join(directory, '1.json'), '{');
  if (fault === 'invalid-pid' || fault === 'invalid-start') writeFileSync(join(directory, '1.json'), JSON.stringify({ sessionId: 'session', pid: fault === 'invalid-pid' ? 0 : 1, startedAt: fault === 'invalid-start' ? 'yesterday' : NOW }));
  const scan = await scanSessions(directory, async () => { if (fault === 'ps-denied') throw new Error('Denied'); return new Map(); }, () => NOW);
  assert.equal(scan.status, ['missing', 'ps-denied'].includes(fault) ? 'failed' : 'partial');
  assert.equal(scan.at, NOW); assert.ok(scan.error);
});

test('mtime が同じ書き換えも再読し、PID の再利用と busy の元の時計を保つ', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'scan-claude-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, '1.json');
  const row = { sessionId: 'session', pid: 1, startedAt: NOW - 1000, procStart: 'old', status: 'busy', statusUpdatedAt: NOW - 200 };
  writeFileSync(path, JSON.stringify(row)); const mtime = statSync(path).mtime;
  const scan = await scanSessions(directory, async () => new Map([[1, 'new']]), () => NOW);
  assert.equal(scan.status, 'succeeded'); assert.equal(scan.sessions[0].procStart, 'old'); assert.equal(scan.processes[0].procStart, 'new');
  assert.equal(scan.sessions[0].statusUpdatedAt, NOW - 200);
  writeFileSync(path, '{'); utimesSync(path, mtime, mtime);
  assert.equal((await scanSessions(directory, async () => new Map([[1, 'new']]), () => NOW + 1)).status, 'partial');
});

test('死んだ PID の登録が残っていても走査は成功し、不在の根拠を返す', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'scan-claude-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, '1.json'), JSON.stringify({ sessionId: 'session', pid: 1, startedAt: NOW - 1000 }));
  const scan = await scanSessions(directory, async () => new Map(), () => NOW);
  assert.equal(scan.status, 'succeeded'); assert.deepEqual(scan.sessions, []); assert.deepEqual(scan.processes, []);
});
