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
  assert.equal(before.projection.send_watches[0].state, 'received_candidate');
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

test('関係の独自 ID と ID に一致しない訂正値は省略せずに配る', t => {
  const directory = mkdtempSync(join(tmpdir(), 'compact-relation-'));
  const f = createCompactSnapshotFeed(join(directory, 'ledger.db'));
  t.after(() => { f.close(); rmSync(directory, { recursive: true }); });
  const rows = f.db.prepare('SELECT * FROM relations ORDER BY id').all();
  f.db.prepare('UPDATE relations SET evidence = ? WHERE id = ?').run('corrected evidence', rows[0].id);
  f.db.prepare('UPDATE relations SET id = ? WHERE id = ?').run('custom-relation', rows[1].id);
  const page = f.feed.list('relations');
  const corrected = page.rows.find(row => row.id === rows[0].id)!;
  assert.equal(corrected.evidence, 'corrected evidence');
  assert.equal(corrected.type, undefined);
  assert.deepEqual({ ...page.rows.find(row => row.id === 'custom-relation') }, { ...rows[1], id: 'custom-relation' });
});

test('会話の null の ai_title は全配信経路で省き、値と解除を保つ', t => {
  const directory = mkdtempSync(join(tmpdir(), 'compact-title-'));
  const f = createCompactSnapshotFeed(join(directory, 'ledger.db'));
  t.after(() => { f.close(); rmSync(directory, { recursive: true }); });
  const read = (rows: Record<string, unknown>[]) => rows.find(row => row.id === ROOT)!;
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.equal('ai_title' in read(wire(f.snapshot()).projection.conversations), false);
  assert.equal('ai_title' in read(wire(f.feed.list('conversations')).rows), false);
  assert.equal('ai_title' in read(wire(f.feed.conversation(ROOT)).projection.conversations), false);
  f.append('conversation.updated', `conversation:${ROOT}`, { ai_title: 'New title' });
  const patch = f.feed.refresh();
  assert.ok(patch && patch !== 'resync');
  assert.equal(read(patch.changes.conversations.upsert).ai_title, 'New title');
  f.append('conversation.updated', `conversation:${ROOT}`, { ai_title: null });
  const cleared = f.feed.refresh();
  assert.ok(cleared && cleared !== 'resync');
  assert.equal('ai_title' in read(wire(cleared).changes.conversations.upsert), false);
  const rows = f.snapshot().projection.conversations;
  const original = rows.map(row => ({ ...row, ai_title: row.ai_title ?? null }));
  assert.equal(Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(rows)), rows.length * 16);
});
