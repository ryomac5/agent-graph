import { expect, it } from 'vitest';
import { createStore, type Row, type ScreenState } from "./current-fixture.ts";
import { resolveParticipants } from '../components/conversation/participants.ts';
import { selectRoots, startedAt } from '../lib/roots.ts';
import { collectNotifications } from '../components/notifications/model.ts';

const LABELS = { user: 'You', assistant: 'Agent', parent: 'Parent' };
const ROWS = 1000;
const RELATIONS = 720;
const REPEATS = 30;
const TIME = '2026-10-13T00:00:00Z';
function createState(projection: Record<string, Row[]>): ScreenState {
  return { seq: 1, generation: 1, projection, connection: 'connected', deltas: {} };
}

it('indexes 1000 conversations, 1000 runs and 720 relations once instead of nested scans', () => {
  let reads = 0;
  const state = createState({
    conversations: Array.from({ length: ROWS }, (_, i) => ({ get id() { reads++; return `c${i}`; }, provider: 'claude' })),
    runs: Array.from({ length: ROWS }, (_, i) => ({ get id() { reads++; return `r${i}`; }, conversation_id: `c${i}` })),
    relations: Array.from({ length: RELATIONS }, (_, i) => ({ id: `link${i}`, type: 'delegated', from_id: 'c0', to_id: `r${i + 1}`, active: 1, confidence: 'confirmed', evidence: { role: 'implement' } })),
  });
  // 改修前の parentLink が根を探すときの比較を、同じデータで数える。
  for (const relation of state.projection.relations) {
    const id = relation.to_id;
    const conversation = state.projection.conversations.some(row => row.id === id) ? id
      : state.projection.runs.find(row => row.id === id)?.conversation_id;
    expect(conversation).not.toBe('c0');
  }
  const before = reads;
  reads = 0;
  const root = resolveParticipants(state, 'c0', LABELS);
  const child = resolveParticipants(state, 'c720', LABELS);
  const after = reads;
  expect(root).toEqual({ child: false, parent: 'You', self: 'Claude' });
  expect(child).toEqual({ child: true, parent: 'Claude · root', self: 'Claude · implement' });
  expect(after).toBe(ROWS * 2);
  expect(after).toBeLessThan(before / 100);
  for (let i = 0; i < REPEATS; i++) expect(resolveParticipants(state, 'c720', LABELS)).toBe(child);
  expect(reads).toBe(after);
  expect(resolveParticipants({ ...state, seq: 2 }, 'c720', LABELS)).toBe(child);
  expect(reads).toBe(after);
  console.info(`participants id reads: ${before} -> ${after}; ${REPEATS} repeats: 0`);
});

it('invalidates participant indexes for identities, corrected relations, run ownership and labels', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, identities: { conversations: {}, runs: { legacy: 'r' } }, projection: {
    conversations: [{ id: 'p', provider: 'claude' }, { id: 'q', provider: 'codex' }, { id: 'c', provider: 'codex', type: 'subagent' }],
    runs: [{ id: 'r', conversation_id: 'c' }],
    relations: [{ id: 'rel', type: 'delegated', from_id: 'p', to_id: 'legacy', active: 1, confidence: 'confirmed', evidence: { role: 'implement' } }],
  } });
  expect(resolveParticipants(target.getSnapshot(), 'c', LABELS).parent).toBe('Claude · root');
  target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 1, changes: { relations: { remove: [], upsert: [
    { id: 'rel', type: 'delegated', from_id: 'q', to_id: 'legacy', active: 1, confidence: 'confirmed', evidence: { role: 'review' } },
  ] } } });
  expect(resolveParticipants(target.getSnapshot(), 'c', LABELS)).toEqual({ child: true, parent: 'Codex · root', self: 'Codex · review' });
  target.applyPatch({ type: 'patch', from_seq: 2, seq: 3, generation: 1, changes: { runs: { remove: [], upsert: [{ id: 'r', conversation_id: 'q' }] } } });
  expect(resolveParticipants(target.getSnapshot(), 'c', { ...LABELS, parent: '親' }).parent).toBe('親');
  const state = target.getSnapshot();
  const aliased = { ...state, identities: { conversations: { missing: 'p' }, runs: {} }, projection: { ...state.projection,
    relations: [{ id: 'rel', type: 'delegated', from_id: 'missing', to_id: 'c', active: 1, confidence: 'confirmed' }],
  } };
  expect(resolveParticipants(aliased, 'c', LABELS).parent).toBe('Claude · root');
});

it('preserves relation priority, inactive corrections, reviews and delegation attempts', () => {
  const state = createState({ conversations: [{ id: 'p', provider: 'claude' }, { id: 'q', provider: 'codex' }, { id: 'c', provider: 'claude' }],
    runs: [{ id: 'child-run', conversation_id: 'c' }, { id: 'parent-run', conversation_id: 'p' }],
    relations: [
      { type: 'delegated', from_id: 'q', to_id: 'c', active: 1, confidence: 'inferred' },
      { type: 'review_of', from_id: 'c', to_id: 'p', active: 1, confidence: 'confirmed' },
    ],
  });
  expect(resolveParticipants(state, 'c', LABELS)).toEqual({ child: true, parent: 'Claude · root', self: 'Claude · review' });
  const corrected = { ...state, projection: { ...state.projection, relations: state.projection.relations.map(row => ({ ...row, active: 0 })),
    delegations: [{ parent_run_id: 'parent-run', role: 'verify', attempts: JSON.stringify([{ run_id: 'child-run' }]) }],
  } };
  expect(resolveParticipants(corrected, 'c', LABELS)).toEqual({ child: true, parent: 'Claude · root', self: 'Claude · verify' });
});

it('reads message times once for repeated root selections and elapsed rows', () => {
  let reads = 0;
  const state = createState({ conversations: [{ id: 'c', provider: 'claude' }],
    roots: [{ id: 'root', name: 'Work', conversation_ids: ['c'], state: 'idle', project: null }],
    messages: Array.from({ length: ROWS }, (_, i) => ({ get id() { reads++; return `m${i}`; }, source_ts: TIME })),
    message_memberships: Array.from({ length: ROWS }, (_, i) => ({ message_id: `m${i}`, conversation_id: 'c', active: 1 })),
  });
  for (let i = 0; i < REPEATS * 2; i++) new Map(state.projection.messages.map(row => [row.id, row]));
  const before = reads;
  reads = 0;
  const roots = selectRoots(state);
  for (let i = 0; i < REPEATS; i++) {
    expect(selectRoots(state)).toBe(roots);
    expect(startedAt(state, roots[0])).toBe(Date.parse(TIME));
  }
  expect(reads).toBe(ROWS);
  expect(selectRoots({ ...state, seq: 2, projection: { ...state.projection, artifacts: [{ id: 'a' }] } })).toBe(roots);
  expect(reads).toBe(ROWS);
  const changed = { ...state, projection: { ...state.projection, messages: [...state.projection.messages, { id: 'old', source_ts: '2026-10-12T00:00:00Z' }],
    message_memberships: [...state.projection.message_memberships, { message_id: 'old', conversation_id: 'c', active: 1 }],
  } };
  expect(startedAt(changed, selectRoots(changed)[0])).toBe(Date.parse('2026-10-12T00:00:00Z'));
  console.info(`root time message reads for ${REPEATS} selections + ${REPEATS} rows: ${before} -> ${ROWS}`);
});

it('does not scan message times again when only run evidence changes', () => {
  let reads = 0;
  const state = createState({
    conversations: [{ id: 'c', provider: 'claude' }],
    roots: [{ id: 'root', name: 'Work', conversation_ids: ['c'], state: 'idle', project: null }],
    messages: Array.from({ length: ROWS }, (_, i) => ({ get id() { reads++; return `m${i}`; }, source_ts: TIME })),
    message_memberships: Array.from({ length: ROWS }, (_, i) => ({ message_id: `m${i}`, conversation_id: 'c', active: 1 })),
  });
  selectRoots(state);
  reads = 0;
  for (let i = 0; i < REPEATS; i++) {
    const next = { ...state, seq: i + 2, projection: { ...state.projection,
      runs: [{ id: 'r', conversation_id: 'c', state: 'running', last_evidence_ts: new Date(Date.parse(TIME) + i * 1000).toISOString() }],
    } };
    expect(selectRoots(next)[0].state).toBe('idle');
    expect(startedAt(next, selectRoots(next)[0])).toBe(Date.parse(TIME));
  }
  expect(reads).toBe(0);
  console.info(`${REPEATS} run updates: message-time index reads ${ROWS * REPEATS} -> ${reads}`);
});

it('compares 1000 notification runs by id and checks state only for changed rows', () => {
  let reads = 0;
  let states = 0;
  const rows = Array.from({ length: ROWS }, (_, i) => ({ get id() { reads++; return `r${i}`; }, conversation_id: `c${i}`,
    get state() { states++; return 'running'; }, last_evidence_ts: TIME }));
  const previous = createState({ runs: rows });
  const next = { ...previous, seq: 2, projection: { runs: [...rows.slice(0, -1), { id: `r${ROWS - 1}`, conversation_id: `c${ROWS - 1}`, state: 'idle', decision_id: 'failure', last_evidence_ts: TIME }], state_decisions: [{ id: 'failure', result: { value: 'failed' } }] } };
  for (const row of next.projection.runs) previous.projection.runs.find(entry => entry.id === row.id);
  const before = reads;
  reads = 0; states = 0;
  expect(collectNotifications(previous, next, 'en', Date.parse(TIME))).toMatchObject([{ kind: 'failed', conversationId: 'c999' }]);
  const after = reads;
  expect(after).toBeLessThanOrEqual(ROWS * 2);
  expect(states).toBe(1);
  reads = 0; states = 0;
  for (let i = 0; i < REPEATS; i++) expect(collectNotifications(previous, { ...previous, seq: i + 2 })).toEqual([]);
  expect(reads).toBe(0); expect(states).toBe(0);
  console.info(`notification id reads: ${before} -> ${after}; unchanged state checks: 999 -> 0`);
});
