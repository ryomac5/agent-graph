import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openLedger, applyIncremental } from '../packages/core/src/ledger/index.ts';
import { verifyCandidates, applyCandidates } from './hide-verification-conversations.mjs';

test('検証は読み取り専用、適用は冪等な追記だけで、変更された履歴と保護対象には追記しない', t => {
  const home = mkdtempSync(join(tmpdir(), 'hide-verification-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, 'ledger.db');
  const folder = join(home, '.claude/projects/repo');
  mkdirSync(folder, { recursive: true });
  const ledger = openLedger(dbPath);
  const id = JSON.stringify(['claude', 'test']);
  ledger.append({ source: 'hook', source_event_id: 'create', kind: 'conversation.created', subject: `conversation:${id}`,
    payload: { provider: 'claude', native_id: 'test', origin: 'observed', type: 'interactive', history_format: 'jsonl' },
    source_ts: '2026-10-14T00:00:00Z', confidence: 'confirmed' });
  const db = new DatabaseSync(dbPath);
  applyIncremental(db, 0); db.close(); ledger.close();
  const transcript = '{"type":"user","message":{"content":"test"}}\n';
  const path = join(folder, 'test.jsonl');
  writeFileSync(path, transcript);
  const candidates = [{ provider: 'claude', nativeId: 'test', sha256: createHash('sha256').update(transcript).digest('hex') }];
  const before = readFileSync(dbPath);
  assert.equal(verifyCandidates(dbPath, home, candidates)[0].status, 'ready');
  assert.deepEqual(readFileSync(dbPath), before);
  applyCandidates(dbPath, home, candidates);
  applyCandidates(dbPath, home, candidates);
  assert.equal(verifyCandidates(dbPath, home, candidates)[0].status, 'already-hidden');
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  const facts = reader.prepare('SELECT * FROM facts ORDER BY seq').all();
  assert.equal(facts.length, 2);
  assert.equal(facts[1].kind, 'conversation.hidden');
  assert.equal(reader.prepare('SELECT last_seq FROM projection_state').get().last_seq, 1, 'apply does not write projections');
  writeFileSync(path, transcript + '{"type":"user","message":{"content":"a real request"}}\n');
  assert.throws(() => applyCandidates(dbPath, home, candidates), /transcript changed/);
  assert.throws(() => applyCandidates(dbPath, home, [{ ...candidates[0], nativeId: '354000b1-protected' }]), /Protected conversation/);
  assert.deepEqual(reader.prepare('SELECT * FROM facts ORDER BY seq').all(), facts);
  reader.close();
});
