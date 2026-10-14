import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSmokeSession } from './session.mjs';
import { SMOKE_DIRECTORY, SMOKE_PROJECT_ID } from '../../packages/api/src/verification.ts';

test('古い保存先と実際の cwd の不一致を拒否し、非表示の確認会話だけ再利用する', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smoke-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session.json');
  const conversationId = JSON.stringify(['claude', '00000000-0000-0000-0000-000000000000']);
  let reads = 0;
  const detail = async () => { reads++; return { projection: { conversations: [{ id: conversationId, cwd: SMOKE_DIRECTORY, hidden: 1 }] } }; };
  assert.equal(await readSmokeSession(path, detail), undefined);
  const saved = { version: 2, cwd: SMOKE_DIRECTORY, project: SMOKE_PROJECT_ID, conversationId };
  await writeFile(path, JSON.stringify({ conversationId, project: 'user-project' }));
  await assert.rejects(readSmokeSession(path, detail), /Unsafe saved/);
  assert.equal(reads, 0);
  await writeFile(path, JSON.stringify(saved));
  await assert.rejects(readSmokeSession(path, async () => ({ projection: { conversations: [{ id: conversationId, cwd: '/user/repo', hidden: 1 }] } })), /not isolated/);
  await assert.rejects(readSmokeSession(path, async () => ({ projection: { conversations: [{ id: conversationId, cwd: SMOKE_DIRECTORY }] } })), /not isolated/);
  assert.deepEqual(await readSmokeSession(path, detail), saved);
});
