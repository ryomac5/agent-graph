import assert from 'node:assert/strict';
import test from 'node:test';
import { openLedger, createFactId, project, type FactInput } from '../../src/ledger/index.ts';
import { readLedgerDatabase, applyIncremental, rebuild, projectEntityRecords } from '../../src/ledger/index.ts';
import { packNativeEvidence, expandNativeEvidence } from '../../src/ledger/native-evidence.ts';
import { planMaintenance } from '../../src/ledger/retention.ts';
import { orderActiveFacts } from '../../src/ledger/projections/connections.ts';

const TS = '2026-01-01T00:00:00.000Z';
function native(index: number, at = index): FactInput {
  return { source: 'transcript-claude', source_event_id: `native-record:file:${index}:hash-${index}`, subject: 'run:r', kind: 'run.updated',
    source_ts: new Date(Date.parse(TS) + at).toISOString(), observed_ts: TS, confidence: 'confirmed', cursor: JSON.stringify({ offset: index }),
    payload: { conversation_id: 'c', generation: 1, last_evidence_ts: new Date(Date.parse(TS) + at).toISOString(),
      last_evidence: { native_source: 'claude', file_id: 'file', native_record: { type: 'assistant', uuid: `uuid-${index}`, parentUuid: `uuid-${index - 1}`,
        message: { content: [{ type: 'tool_use', id: `tool-${index}`, name: 'Bash', input: {} }] } } } } };
}

test('P6: 古い証拠128行は一つの追記事実に圧縮し、識別・時刻・連鎖・訂正を保つ', t => {
  const plain = openLedger(':memory:'); const packed = openLedger(':memory:');
  t.after(() => { plain.close(); packed.close(); });
  const base = { ...native(0), kind: 'run.created', source_event_id: 'create', payload: { conversation_id: 'c', generation: 1, model: 'original' } } as FactInput;
  const inputs = Array.from({ length: 128 }, (_, i) => native(i + 1));
  for (const ledger of [plain, packed]) ledger.append(base);
  for (const input of inputs) plain.append(input);
  packed.append(packNativeEvidence(inputs));
  const facts = plain.readSince(0, 1000), archive = packed.readSince(0, 1000);
  const identity = (fact: typeof facts[number]) => ({ id: fact.fact_id, event: fact.source_event_id, at: fact.source_ts, observed: fact.observed_ts, cursor: fact.cursor, payload: fact.payload });
  assert.deepEqual(archive.flatMap(expandNativeEvidence).map(identity), facts.map(identity));
  assert.equal(archive.length, 2);
  assert.deepEqual(project(archive), project(facts));
  assert.deepEqual(projectEntityRecords(archive, 'run'), projectEntityRecords(facts, 'run'));
  const db = readLedgerDatabase(packed);
  let seq = applyIncremental(db, 0).last_seq;
  const dependencies = Number(db.prepare('SELECT count(*) AS n FROM fact_projection_dependencies').get()!.n);
  assert.ok(dependencies < 128 * 4, `dependencies=${dependencies}`);
  assert.ok(Number(db.prepare('SELECT count(*) AS n FROM search_references').get()!.n) <= 6);
  // まとめた行の中の一つを、別 subject の訂正からも名指せる。
  const correction = { ...native(2), subject: 'run:replacement', source_event_id: 'correction', supersedes: createFactId('transcript-claude', inputs[1].source_event_id),
    source_ts: new Date(Date.parse(TS) + 200).toISOString(), payload: { conversation_id: 'other', generation: 1, model: 'corrected' } } as FactInput;
  for (const ledger of [plain, packed]) ledger.append(correction);
  applyIncremental(db, seq);
  const rows = db.prepare('SELECT * FROM runs ORDER BY id').all();
  assert.deepEqual(project(packed.readSince(0, 1000)), project(plain.readSince(0, 1000)));
  rebuild(db); assert.deepEqual(db.prepare('SELECT * FROM runs ORDER BY id').all(), rows);
  assert.deepEqual(packed.readSince(0, 1000).slice(0, 2), archive, 'existing facts stay immutable');
  const replacement = { ...native(300), source_event_id: 'whole-archive-correction', supersedes: archive[1].fact_id,
    payload: { conversation_id: 'c', generation: 1, last_evidence: { reason: 'retracted' } } } as FactInput;
  packed.append(replacement);
  const corrected = packed.readSince(0, 1000);
  assert.equal(orderActiveFacts(corrected).filter(fact => fact.source_event_id.startsWith('native-record:')).length, 0);
  applyIncremental(db, seq); const correctedRows = db.prepare('SELECT * FROM runs ORDER BY id').all();
  rebuild(db); assert.deepEqual(db.prepare('SELECT * FROM runs ORDER BY id').all(), correctedRows);
});

test('P6: 圧縮した証拠の印は本文保持の対象にせず、秘匿を通す', t => {
  const ledger = openLedger(':memory:', { storageScope: 'metadata', redactionRules: { patterns: ['private-id'] } });
  t.after(() => ledger.close());
  const inputs = [native(1), native(2)];
  for (const input of inputs) ((input.payload as Record<string, unknown>).last_evidence as Record<string, unknown>).native_record = {
    type: 'user', uuid: 'private-id', promptId: 'turn', message: { content: 'secret body' },
  };
  ledger.append(packNativeEvidence(inputs));
  const facts = ledger.readSince(0, 100);
  const text = JSON.stringify(facts);
  assert.equal(text.includes('secret body'), false); assert.equal(text.includes('private-id'), false);
  assert.ok(text.includes('observed'));
  assert.deepEqual(planMaintenance(readLedgerDatabase(ledger), { kind: 'retention', retentionDays: 1, now: '2026-10-16T00:00:00Z' }).changes, []);
  assert.equal(expandNativeEvidence(facts[0]).length, 2);
});
