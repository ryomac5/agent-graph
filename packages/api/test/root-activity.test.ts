import { CHILD, CHILD_START, createRootlineFacts, ROOT, START } from '../../core/test/ledger/fixtures/rootline.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyIncremental, createNativeId, openLedger, readLedgerDatabase, rebuild, type FactInput, type JsonValue } from '../../core/src/ledger/index.ts';
import { createClaudeSessionObserver } from '../src/observe/claude/sessions.ts';
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
    append({ ...event, event_id: 'tool', hook_event_name: 'PostToolUse', source_ts: '2026-10-11T00:11:42Z' });
    feed.refresh();
    const running = feed.snapshot().projection;
    assert.equal(running.runs[0].state, 'running');
    assert.equal(running.roots[0].state, 'running');
    assert.equal(running.runs[0].turn_started_ts, start);
    ledger.append({ source: 'transcript-claude', source_event_id: 'process-absent', source_ts: '2026-10-11T00:11:43Z',
      kind: 'run.state_changed', subject: 'run:claude:root:1', confidence: 'confirmed',
      payload: { conversation_id: 'claude:root', generation: 1, state: 'idle', last_evidence: { kind: 'process_absent' } } });
    feed.refresh();
    const projected = feed.snapshot().projection;
    assert.equal(projected.runs[0].state, 'idle');
    assert.equal(projected.roots[0].state, 'idle');
    assert.equal(projected.runs[0].turn_started_ts, null);
    const observe = createClaudeSessionObserver(ledger, directory);
    const count = readLedgerDatabase(ledger).prepare('SELECT count(*) AS count FROM facts').get()!.count;
    assert.equal(observe('2026-10-11T00:13:00Z'), 0);
    assert.equal(observe('2026-10-11T00:14:00Z'), 0);
    assert.equal(readLedgerDatabase(ledger).prepare('SELECT count(*) AS count FROM facts').get()!.count, count);
    feed.close(); feed = undefined;
    const db = readLedgerDatabase(ledger);
    db.exec('ALTER TABLE conversations DROP COLUMN ai_title; ALTER TABLE runs DROP COLUMN turn_started_ts; UPDATE schema_version SET version = 11; UPDATE runner_projection_version SET version = 5');
    ledger.close(); ledger = openLedger(path);
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    assert.deepEqual(feed.snapshot().projection, projected);
    feed.close(); feed = undefined;
    readLedgerDatabase(ledger).exec("UPDATE runs SET state = 'running', turn_started_ts = '2026-10-11T00:01:00Z'; UPDATE runner_projection_version SET version = 6");
    ledger.close(); ledger = openLedger(path);
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    assert.deepEqual(feed.snapshot().projection, projected);
    assert.equal(readLedgerDatabase(ledger).prepare('SELECT version FROM runner_projection_version').get()?.version, 9);
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

test('本番 seq 262199–262309 の背景完了のターンは、遅れて届く Stop の後も開始から完了まで running になる', () => {
  const directory = mkdtempSync(join(tmpdir(), 'root-background-'));
  const ledger = openLedger(join(directory, 'ledger.db'));
  const db = readLedgerDatabase(ledger);
  try {
    const event: HookEvent = { version: 1, session_id: 'background-root', generation: 1, event_id: 'session',
      hook_event_name: 'SessionStart', source_ts: '2026-10-11T10:19:00.000Z', input: {}, managed: false };
    for (const fact of createHookFacts(event)) ledger.append(fact);
    const rows: { seq: number; source: FactInput['source']; kind: 'run.state_changed' | 'run.updated'; ts: string;
      state?: 'running' | 'idle'; evidence: JsonValue }[] = [
      { seq: 262199, source: 'transcript-claude', kind: 'run.state_changed', ts: '2026-10-11T10:19:45.229Z',
        state: 'running', evidence: { kind: 'turn_started', turn_id: 'background-turn' } },
      { seq: 262202, source: 'hook', kind: 'run.updated', ts: '2026-10-11T10:19:45.042Z',
        state: 'idle', evidence: { hook_event_name: 'Stop', input: { last_assistant_message: 'Response omitted' } } },
      { seq: 262205, source: 'hook', kind: 'run.updated', ts: '2026-10-11T10:19:46.671Z',
        evidence: { hook_event_name: 'SubagentStop', input: { last_assistant_message: 'Response omitted' } } },
      { seq: 262234, source: 'hook', kind: 'run.updated', ts: '2026-10-11T10:20:11.563Z',
        evidence: { hook_event_name: 'SubagentStop', input: { last_assistant_message: 'Response omitted' } } },
      { seq: 262309, source: 'transcript-claude', kind: 'run.state_changed', ts: '2026-10-11T10:20:25.603Z',
        state: 'idle', evidence: { kind: 'turn_completed', turn_id: 'background-end' } },
    ];
    for (const row of rows) {
      ledger.append({ source: row.source, source_event_id: row.source === 'transcript-claude' ? `turn:v3:background-root:${row.seq}` : String(row.seq),
        source_ts: row.ts, kind: row.kind, subject: 'run:claude:background-root:1', confidence: 'confirmed',
        payload: { conversation_id: 'claude:background-root', generation: 1, ...(row.state ? { state: row.state } : {}),
          last_evidence: row.evidence, last_evidence_ts: row.ts } } as FactInput);
      applyIncremental(db, 0);
      const run = db.prepare('SELECT state, turn_started_ts FROM runs').get()!;
      assert.equal(run.state, row.seq === 262309 ? 'idle' : 'running');
      assert.equal(run.turn_started_ts, row.seq === 262309 ? null : rows[0].ts);
      rebuild(db);
      assert.deepEqual(db.prepare('SELECT state, turn_started_ts FROM runs').get(), run);
    }
    const expected = db.prepare('SELECT * FROM runs').all();
    rebuild(db);
    assert.deepEqual(db.prepare('SELECT * FROM runs').all(), expected);
  } finally {
    ledger.close(); rmSync(directory, { recursive: true });
  }
});

test('本番の根と審査役の別名の並びを分離し、子の再開の時計を snapshot と patch と再構築に保つ', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rootline-'));
  const path = join(directory, 'ledger.db');
  let ledger = openLedger(path);
  let feed: ProjectionFeed | undefined;
  try {
    const facts = createRootlineFacts();
    for (const fact of facts.slice(0, -1)) ledger.append(fact);
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    assert.equal(feed.snapshot().projection.roots[0].state, 'idle');
    ledger.append(facts.at(-1)!);
    const patch = feed.refresh();
    assert.ok(patch && patch !== 'resync');
    assert.deepEqual(patch.changes.roots.upsert[0].conversation_ids, [ROOT]);
    assert.equal(patch.changes.roots.upsert[0].current_conversation_id, ROOT);
    assert.equal(patch.changes.roots.upsert[0].state, 'running');
    const snapshot = feed.snapshot().projection;
    assert.equal(snapshot.roots.length, 1);
    assert.deepEqual(snapshot.roots[0].conversation_ids, [ROOT]);
    assert.equal(snapshot.runs.find(row => row.conversation_id === ROOT)?.turn_started_ts, START);
    assert.equal(snapshot.runs.find(row => row.conversation_id === CHILD)?.turn_started_ts, CHILD_START);
    const db = readLedgerDatabase(ledger);
    db.exec("UPDATE runs SET turn_started_ts = NULL; UPDATE runner_projection_version SET version = 7");
    feed.close();
    ledger.close(); ledger = openLedger(path);
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    assert.deepEqual(feed.snapshot().projection, snapshot);
    assert.equal(readLedgerDatabase(ledger).prepare('SELECT version FROM runner_projection_version').get()?.version, 9);
    rebuild(readLedgerDatabase(ledger));
    assert.equal(feed.refresh(), 'resync');
    assert.deepEqual(feed.snapshot().projection, snapshot);
  } finally {
    feed?.close(); ledger.close(); rmSync(directory, { recursive: true });
  }
});

test('fork の関係の有無で根の系列を保ち、snapshot と patch と再構築の操作先が一致する', () => {
  const directory = mkdtempSync(join(tmpdir(), 'root-kit-fork-'));
  const ledger = openLedger(join(directory, 'ledger.db'));
  const db = readLedgerDatabase(ledger);
  let feed: ProjectionFeed | undefined;
  try {
    const appendSession = (native: string, ts: string) => {
      const event: HookEvent = { version: 1, session_id: native, generation: 1, event_id: 'session:' + native,
        hook_event_name: 'SessionStart', source_ts: ts, input: {}, managed: false };
      for (const fact of createHookFacts(event)) ledger.append(fact);
      ledger.append({ source: 'kit', source_event_id: 'alias:' + native, kind: 'alias.created', subject: `alias:${native}`,
        source_ts: ts, confidence: 'confirmed', payload: { entity_id: createNativeId('claude', native), kind: 'kit', name: 'example-001' } });
    };
    appendSession('root', '2026-10-11T00:00:00Z');
    feed = new ProjectionFeed(join(directory, 'ledger.db'), () => applyIncremental(db, 0));
    appendSession('fork', '2026-10-11T00:01:00Z');
    const patch = feed.refresh();
    assert.ok(patch && patch !== 'resync');
    const root = createNativeId('claude', 'root');
    const fork = createNativeId('claude', 'fork');
    assert.deepEqual(patch.changes.roots.upsert[0].conversation_ids, [root, fork]);
    assert.equal(patch.changes.roots.upsert[0].current_conversation_id, fork);
    const snapshot = feed.snapshot().projection;
    assert.equal(snapshot.roots.length, 1);
    assert.equal(snapshot.roots[0].id, root);
    assert.equal(snapshot.roots[0].current_conversation_id, fork);
    assert.equal(snapshot.relations.length, 0);
    ledger.append({ source: 'host-claude', source_event_id: 'recorded-fork', kind: 'relation.created', subject: 'relation:recorded-fork',
      source_ts: '2026-10-11T00:02:00Z', confidence: 'confirmed', payload: { from_id: root, to_id: fork, type: 'forked',
        evidence: { native_id: 'fork' }, confidence: 'confirmed', active: true } });
    const recordedPatch = feed.refresh();
    assert.ok(recordedPatch && recordedPatch !== 'resync');
    const recorded = feed.snapshot().projection;
    assert.equal(recorded.relations.length, 1);
    assert.deepEqual(recorded.roots, snapshot.roots);
    rebuild(db);
    assert.equal(feed.refresh(), 'resync');
    assert.deepEqual(feed.snapshot().projection, recorded);
  } finally {
    feed?.close(); ledger.close(); rmSync(directory, { recursive: true });
  }
});
