import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSmokeSession } from './session.mjs';
import { selectCodexRoot } from './select-codex-root.mjs';
import { SMOKE_DIRECTORY, SMOKE_PROJECT_ID } from '../../packages/api/src/verification.ts';

function createRoot(id, total_children, project = 'project') {
  return { id, project, total_children, conversation_ids: [id] };
}

test('Codex の子を持つ根が複数なら、その中で total_children 最大を選ぶ', () => {
  const roots = [createRoot('claude-only', 100), createRoot('small', 2), createRoot('large', 10),
    createRoot('smoke', 200), createRoot('other', 300, 'other-project')];
  const snapshot = { projection: { roots, conversations: [{ id: 'codex-child', provider: 'codex' }],
    relations: ['small', 'large', 'smoke', 'other'].map(from_id => ({ type: 'delegated', from_id, to_id: 'codex-child' })) } };
  const before = structuredClone(snapshot);
  assert.equal(selectCodexRoot(snapshot, 'project', 'smoke'), roots[2]);
  assert.deepEqual(snapshot, before);
});

test('Codex の子が無ければ従来どおり最多の根を選ぶ', () => {
  const roots = [createRoot('small', 1), createRoot('large', 10), createRoot('smoke', 20)];
  const snapshot = { projection: { roots, conversations: [{ id: 'small', provider: 'codex' }], relations: [
    { type: 'delegated', from_id: 'small', to_id: '["codex","inactive"]', active: 0 },
    { type: 'delegated', from_id: 'small', to_id: '["codex","disabled"]', active: false },
    { type: 'forked', from_id: 'small', to_id: '["codex","fork"]' },
  ] } };
  assert.equal(selectCodexRoot(snapshot, 'project', 'smoke'), roots[1]);
  assert.equal(selectCodexRoot(snapshot, 'missing-project', 'smoke'), undefined);
});

test('total_children と入力の順序にかかわらず Codex の子を持つ根を優先する', () => {
  for (const counts of [[1, 100], [100, 1]]) {
    const codexRoot = createRoot('codex-parent', counts[0]);
    const claudeRoot = createRoot('claude-parent', counts[1]);
    for (const roots of [[codexRoot, claudeRoot], [claudeRoot, codexRoot]]) {
      const snapshot = { projection: { roots, relations: [
        { type: 'delegated', from_id: 'codex-parent', to_id: '["codex","child"]' },
      ] } };
      assert.equal(selectCodexRoot(snapshot, 'project', 'smoke'), codexRoot);
    }
  }
});

test('省略された関係・別名・系列内の別会話・孫を辿り、循環で止まらない', () => {
  const root = { ...createRoot('root', 3), conversation_ids: ['root', 'continued'] };
  const snapshot = { identities: { conversations: { alias: 'continued' } }, projection: {
    roots: [createRoot('larger', 20), root], relations: [
      { id: JSON.stringify(['delegated', 'alias', 'middle', 'evidence']) },
      { type: 'delegated', from_id: 'middle', to_id: 'continued' },
      { type: 'delegated', from_id: 'middle', to_id: '["codex","grandchild"]' },
    ],
  } };
  assert.equal(selectCodexRoot(snapshot, 'project', 'smoke'), root);
});

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
