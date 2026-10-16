import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompactSnapshotFeed, CHILD, LEGACY, ROOT, START } from '../../../../api/test/fixtures/compact-snapshot.ts';
import { createStore, type Snapshot } from '../lib/store.ts';
import type { ConversationPageData } from '../lib/projection-client.ts';
import { resolveRow, resolveRunId } from '../lib/identities.ts';
import { selectRoots } from '../lib/roots.ts';
import { recordTransitions, resolveWorkingTurn, selectTurns, workingElapsed } from '../lib/turns.ts';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { resolveParticipants } from '../components/conversation/participants.ts';
import { buildDelegationTree } from '../pages/tree/model.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

it('restores relation fields without identities and preserves explicit corrections, custom IDs and run aliases', () => {
  const parts = ['delegated', LEGACY, CHILD, '{"description":"Review"}'];
  const id = JSON.stringify(parts);
  expect(resolveRow('relations', { id, active: 1 })).toEqual({ id, active: 1,
    type: parts[0], from_id: LEGACY, to_id: CHILD, evidence: parts[3] });
  expect(resolveRow('relations', { id, from_id: null, evidence: 'corrected' }).evidence).toBe('corrected');
  expect(resolveRow('relations', { id, from_id: null }).from_id).toBeNull();
  const custom = { id: 'custom', type: 'copied', from_id: ROOT, to_id: CHILD, evidence: '{}' };
  expect(resolveRow('relations', custom)).toBe(custom);
  for (const id of ['not-json', '["two","parts"]', '[1,2,3,4]']) {
    expect(resolveRow('relations', { ...custom, id }).evidence).toBe('{}');
  }
  const identities = { conversations: { [LEGACY]: ROOT }, runs: { 'custom-host-run': `${CHILD}:1`, [`${LEGACY}:2`]: `${CHILD}:3` } };
  expect(resolveRunId(`${LEGACY}:1`, identities)).toBe(`${ROOT}:1`);
  expect(resolveRunId(`${LEGACY}:2`, identities)).toBe(`${CHILD}:3`);
  expect(resolveRunId('custom-host-run', identities)).toBe(`${CHILD}:1`);
  expect(resolveRunId('missing:1', identities)).toBe('missing:1');
});

it('resolves referenced runs and removes a legacy run without a transmitted run mapping', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 2, identities: { conversations: { [LEGACY]: ROOT }, runs: {} }, projection: {
    runs: [{ id: `${LEGACY}:1`, conversation_id: LEGACY, generation: 1 }],
    approvals: [{ id: 'approval', run_id: `${LEGACY}:1` }],
    delegations: [{ id: 'request', attempts: JSON.stringify([{ run_id: `${LEGACY}:1` }]) }],
  } });
  expect(target.getSnapshot().projection.approvals[0].run_id).toBe(`${ROOT}:1`);
  expect(target.getSnapshot().projection.delegations[0].attempts).toEqual([{ run_id: `${ROOT}:1` }]);
  expect(target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 2,
    changes: { runs: { upsert: [], remove: [`${LEGACY}:1`] } } })).toBe(true);
  expect(target.getSnapshot().projection.runs).toEqual([]);
  target.setSnapshot({ seq: 0, generation: 3, identities: { conversations: {}, runs: {} }, projection: {} });
  expect(target.applyPatch({ type: 'patch', from_seq: 2, seq: 3, generation: 2, changes: {} })).toBe(false);
  target.appendDelta({ runId: `${LEGACY}:1`, text: 'new generation' });
  expect(Object.values(target.getSnapshot().deltas)[0].runId).toBe(`${LEGACY}:1`);
});

it('keeps roots, conversation, Working, unread, Queued and send watches through compact snapshot, page, patch and resync', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'screen-compact-snapshot-'));
  const f = createCompactSnapshotFeed(join(directory, 'ledger.db'));
  try {
    const target = createStore();
    const snapshot = wire(f.snapshot()) as Snapshot;
    expect(snapshot.identities!.runs[`${LEGACY}:1`]).toBeUndefined();
    expect(snapshot.projection.relations.every(row => !('evidence' in row))).toBe(true);
    target.setSnapshot(snapshot);
    target.setConnection('connected');
    const state = target.getSnapshot();
    expect(state.projection.relations).toEqual(wire(f.db.prepare('SELECT * FROM relations ORDER BY id').all()));
    expect(state.projection.runs.find(row => row.conversation_id === ROOT)?.id).toBe(`${ROOT}:1`);
    const roots = selectRoots(state);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ id: ROOT, state: 'running', total_children: 1 });
    expect(workingElapsed(resolveWorkingTurn(state.projection.runs.find(row => row.conversation_id === ROOT)), Date.parse(START) + 192_000)).toBe('3m 12s');
    expect(state.projection.send_watches).toEqual(snapshot.projection.send_watches);
    const delegated = { ...state, projection: { ...state.projection, relations: [], delegations: [{ id: 'request',
      parent_run_id: `${LEGACY}:1`, parent: { confidence: 'confirmed' },
      attempts: [{ attempt: 1, run_id: 'custom-host-run' }], role: 'review', state: 'idle' }] } };
    expect(resolveParticipants(delegated, CHILD, { user: 'User', assistant: 'Assistant', parent: 'Parent' }).parent).toBe('Claude · root');
    const tree = buildDelegationTree(delegated);
    expect(tree.edges).toContainEqual(expect.objectContaining({ source: `conversation:${ROOT}`, target: `run:${CHILD}:1`, kind: 'delegated', confidence: 'confirmed' }));
    target.appendDelta({ runId: `${LEGACY}:1`, text: 'progress' });
    expect(Object.values(target.getSnapshot().deltas)[0].runId).toBe(`${ROOT}:1`);
    target.clearDeltas();
    const page = wire(f.feed.list('relations'));
    const paged = createStore();
    paged.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, relations: [] } });
    paged.mergeProjection({ relations: page.rows }, page.generation, page.identities);
    expect(paged.getSnapshot().projection.relations).toEqual(state.projection.relations);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })),
      fetchConversation: vi.fn(async () => wire(f.feed.conversation(LEGACY, '', { latest: true })) as ConversationPageData) };
    render(<MemoryRouter><ConversationPage target={target} conversationId={ROOT} client={client} language="en"/></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByText('Existing reply')).toBeTruthy();
    expect(screen.getByText('Next step')).toBeTruthy();
    expect(screen.getByText('Queued — Claude will read this after the current step')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy();
    expect(screen.getByText('Compaction')).toBeTruthy();
    f.append('relation.updated', 'relation:delegated', { evidence: { description: 'Corrected review' } });
    f.append('run.state_changed', `run:${LEGACY}:1`, { state: 'idle', last_evidence: { kind: 'turn_completed' }, last_evidence_ts: '2026-10-13T00:04:00.000Z' });
    const patch = f.feed.refresh();
    if (!patch || patch === 'resync') throw new Error('Expected patch');
    act(() => { expect(target.applyPatch(wire(patch))).toBe(true); });
    expect(target.getSnapshot().projection.relations.toSorted((a, b) => String(a.id).localeCompare(String(b.id))))
      .toEqual(wire(f.db.prepare('SELECT * FROM relations').all()).sort((a, b) => String(a.id).localeCompare(String(b.id))));
    const history = recordTransitions(roots, selectRoots(target.getSnapshot()), { read: {}, ready: {}, recent: [] });
    expect(selectTurns(target.getSnapshot(), history).map(turn => turn.conversationId)).toContain(ROOT);
    expect(selectTurns(target.getSnapshot(), { ...history, read: { [ROOT]: history.ready[ROOT] } })).toEqual([]);
    expect(screen.queryByText('Queued — Claude will read this after the current step')).toBeNull();
    act(() => target.setSnapshot(wire(f.snapshot()) as Snapshot));
    expect(target.getSnapshot().projection.relations).toEqual(wire(f.db.prepare('SELECT * FROM relations ORDER BY id').all()));
    expect(target.getSnapshot().projection.send_watches).toEqual(snapshot.projection.send_watches);
  } finally { cleanup(); f.close(); rmSync(directory, { recursive: true }); }
});
