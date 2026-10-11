import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyIncremental, openLedger, readLedgerDatabase, rebuild } from '../../core/src/ledger/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';
import { createHookFacts, type HookEvent } from '../src/hook/index.ts';

test('hook の根の状態と開始時刻を snapshot と patch に配り、旧 DB と台帳から再構築できる', () => {
  const directory = mkdtempSync(join(tmpdir(), 'root-activity-'));
  const path = join(directory, 'ledger.db');
  let ledger = openLedger(path);
  let feed: ProjectionFeed | undefined;
  try {
    const event: HookEvent = { version: 1, session_id: 'root', generation: 1, event_id: 'session',
      hook_event_name: 'SessionStart', source_ts: '2026-10-11T00:00:00Z', input: {}, managed: false };
    const append = (event: HookEvent) => { for (const fact of createHookFacts(event)) ledger.append(fact); };
    append(event);
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    const start = '2026-10-11T00:01:00Z';
    append({ ...event, event_id: 'prompt', hook_event_name: 'UserPromptSubmit', source_ts: start });
    const patch = feed.refresh();
    assert.ok(patch && patch !== 'resync');
    assert.equal(patch.changes.runs.upsert[0].state, 'running');
    assert.equal(patch.changes.runs.upsert[0].turn_started_ts, start);
    ledger.append({ source: 'transcript-claude', source_event_id: 'child-stop', source_ts: '2026-10-11T00:11:42Z',
      kind: 'run.state_changed', subject: 'run:claude:root:1', confidence: 'confirmed',
      payload: { conversation_id: 'claude:root', generation: 1, state: 'idle', last_evidence: { kind: 'turn_completed' } } });
    ledger.append({ source: 'transcript-claude', source_event_id: 'process-absent', source_ts: '2026-10-11T00:11:43Z',
      kind: 'run.state_changed', subject: 'run:claude:root:1', confidence: 'confirmed',
      payload: { conversation_id: 'claude:root', generation: 1, state: 'idle', last_evidence: { kind: 'process_absent' } } });
    append({ ...event, event_id: 'tool', hook_event_name: 'PostToolUse', source_ts: '2026-10-11T00:11:42Z' });
    feed.refresh();
    const projected = feed.snapshot().projection;
    assert.equal(projected.runs[0].state, 'running');
    assert.equal(projected.roots[0].state, 'running');
    assert.equal(projected.runs[0].turn_started_ts, start);
    feed.close(); feed = undefined;
    const db = readLedgerDatabase(ledger);
    db.exec('ALTER TABLE runs DROP COLUMN turn_started_ts; UPDATE schema_version SET version = 11; UPDATE runner_projection_version SET version = 5');
    ledger.close(); ledger = openLedger(path);
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    assert.deepEqual(feed.snapshot().projection, projected);
    const before = feed.snapshot().generation;
    rebuild(readLedgerDatabase(ledger));
    assert.equal(feed.refresh(), 'resync');
    assert.equal(feed.snapshot().generation, before + 1);
    assert.deepEqual(feed.snapshot().projection, projected);
    append({ ...event, event_id: 'stop', hook_event_name: 'Stop', source_ts: '2026-10-11T00:12:00Z' });
    feed.refresh();
    assert.equal(feed.snapshot().projection.roots[0].state, 'idle');
    assert.equal(feed.snapshot().projection.runs[0].turn_started_ts, null);
  } finally {
    feed?.close(); ledger.close(); rmSync(directory, { recursive: true });
  }
});
