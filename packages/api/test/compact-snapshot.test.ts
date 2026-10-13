import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCompactSnapshotFeed, CHILD, LEGACY, ROOT } from './fixtures/compact-snapshot.ts';

test('snapshot・頁・patch は関係の重複欄だけ省き、独自 run 別名と根と待ち行列を保つ', t => {
  const directory = mkdtempSync(join(tmpdir(), 'compact-snapshot-'));
  const f = createCompactSnapshotFeed(join(directory, 'ledger.db'));
  t.after(() => { f.close(); rmSync(directory, { recursive: true }); });
  const before = f.snapshot();
  assert.equal(before.identities.runs[`${LEGACY}:1`], undefined);
  assert.equal(before.identities.runs['custom-host-run'], `${CHILD}:1`);
  assert.equal(before.identities.conversations[LEGACY], ROOT);
  assert.equal(before.projection.roots[0].state, 'running');
  assert.equal(before.projection.send_watches[0].state, 'pending');
  assert.equal((before.projection.conversations.find(row => row.id === ROOT)?.pending_inputs as unknown[]).length, 1);
  assert.deepEqual(f.feed.conversation(LEGACY), f.feed.conversation(ROOT));
  assert.deepEqual(f.feed.list('relations').rows, before.projection.relations);
  for (const row of before.projection.relations) {
    assert.equal(row.type, undefined);
    assert.equal(row.from_id, undefined);
    assert.equal(row.to_id, undefined);
    assert.equal(row.evidence, undefined);
    const original = f.db.prepare('SELECT * FROM relations WHERE id = ?').get(String(row.id))!;
    assert.deepEqual(JSON.parse(String(row.id)), [original.type, original.from_id, original.to_id, original.evidence]);
  }
  // 根拠の訂正は新 ID の追加と旧 ID の削除で届く。ID とページの cursor は変換しない。
  const old = before.projection.relations.find(row => JSON.parse(String(row.id))[0] === 'delegated')!;
  f.append('relation.updated', 'relation:delegated', { evidence: { description: 'Corrected review' } });
  const patch = f.feed.refresh();
  assert.ok(patch && patch !== 'resync');
  assert.ok(patch.changes.relations.remove.includes(String(old.id)));
  assert.equal(patch.changes.relations.upsert[0].evidence, undefined);
  assert.deepEqual(f.feed.replay(before.seq, before.generation), [patch]);
  assert.deepEqual(f.feed.scopePatch(patch, new Set([ROOT])).changes.relations, patch.changes.relations);
  assert.equal(before.projection.relations.some(row => row.evidence), false);
});
