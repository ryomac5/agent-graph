import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPagedIdentityFeed, PAGE_SIZE, TURN_START } from './fixtures/paged-identities.ts';
import { deriveRunId } from '../src/service/screen-identities.ts';

test('snapshot 全対応表と後続ページと既存 run の patch が旧形式の識別子を解決する', t => {
  const directory = mkdtempSync(join(tmpdir(), 'paged-identities-'));
  const fixture = createPagedIdentityFeed(join(directory, 'ledger.db'));
  t.after(() => { fixture.close(); rmSync(directory, { recursive: true }); });
  const snapshot = fixture.feed.snapshot();
  assert.equal(snapshot.projection.runs.length, PAGE_SIZE);
  const page = fixture.feed.list('runs', String(snapshot.pages.runs.next));
  assert.equal(page.rows.length, 2);
  const patch = fixture.updateRuns();
  for (const { legacy, canonical } of fixture.targets) {
    assert.ok(!snapshot.projection.runs.some(row => row.conversation_id === legacy));
    for (const identities of [snapshot.identities, page.identities, patch.identities]) {
      assert.equal(identities?.conversations[legacy], canonical);
      assert.equal(identities?.runs[`${legacy}:1`], undefined);
      assert.equal(deriveRunId(`${legacy}:1`, identities!.conversations), `${canonical}:1`);
    }
    assert.equal(page.rows.find(row => row.conversation_id === legacy)?.turn_started_ts, TURN_START);
    assert.equal(patch.changes.runs.upsert.find(row => row.conversation_id === legacy)?.turn_started_ts, TURN_START);
  }
  assert.deepEqual(fixture.feed.scopePatch(patch, new Set()).identities, patch.identities);
  assert.deepEqual(fixture.feed.replay(snapshot.seq, snapshot.generation), [patch]);
  const created = fixture.createRuns();
  for (const { legacy, canonical } of fixture.targets) {
    assert.equal(created.identities?.conversations[legacy], canonical);
    assert.equal(created.identities?.runs[`${legacy}:2`], `${canonical}:2`);
    assert.equal(created.changes.runs.upsert.find(row => row.conversation_id === legacy)?.turn_started_ts, TURN_START);
  }
  assert.equal(snapshot.identities.conversations[fixture.targets[0].legacy], fixture.targets[0].canonical);
});
