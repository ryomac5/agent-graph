import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, applyIncremental, rebuild, project } from '../../src/ledger/index.ts';
import { connectRootDelegations } from '../../src/ledger/projections/roots.ts';

test('user name wins without changing kit, membership, delegation or automatic name and survives rebuild', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ag-name-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite'); const ledger = openLedger(path); t.after(() => ledger.close());
  const db = new DatabaseSync(path); t.after(() => db.close());
  ledger.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  applyIncremental(db, 0);
  const before = project(ledger.readSince(0, 100)).roots[0];
  ledger.append({ source: 'ui', source_event_id: 'rename', kind: 'conversation.renamed', subject: `conversation:${before.id}`, source_ts: '2026-10-02T00:00:00Z', confidence: 'confirmed', payload: { user_name: 'Custom' } });
  applyIncremental(db, 1);
  const rows = () => db.prepare('SELECT id, user_name, kit_name FROM conversations').all();
  assert.equal(rows()[0].user_name, 'Custom'); const saved = rows(); rebuild(db); assert.deepEqual(rows(), saved);
  const facts = ledger.readSince(0, 100); const root = project(facts).roots[0];
  assert.equal(root.name, 'Custom'); assert.equal(root.auto_name, 'repo-001'); assert.deepEqual(root.conversation_ids, before.conversation_ids);
  assert.equal(connectRootDelegations([{ kit: { session: 'repo-001' } }], [root])[0].root_id, root.id);
  assert.deepEqual(project([...facts].reverse()).roots, [root]);
  ledger.append({ source: 'ui', source_event_id: 'clear', kind: 'conversation.renamed', subject: `conversation:${before.id}`, source_ts: '2026-10-03T00:00:00Z', confidence: 'confirmed', payload: { user_name: null } });
  applyIncremental(db, 2); assert.equal(rows()[0].user_name, null);
  assert.equal(project(ledger.readSince(0, 100)).roots[0].name, 'repo-001');
});
