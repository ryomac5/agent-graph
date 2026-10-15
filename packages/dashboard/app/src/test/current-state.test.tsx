import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore } from '../lib/store.ts';
import { resolveActivity } from '../lib/activity.ts';
import { resolveWorkingTurn, workingElapsed, publishTurns, selectTurns } from '../lib/turns.ts';
import { toExecutionState } from '../pages/tree/model.ts';
import { RootList } from '../components/RootViews.tsx';
import { selectRoots } from '../lib/roots.ts';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); publishTurns({ history: { read: {}, ready: {}, recent: [] }, turns: [] }); });
const states = ['unresolved', 'stopped', 'waiting_approval', 'waiting_input', 'running', 'waiting_agents', 'closed', 'not_hosted', 'idle', 'unknown'];
const labels = ['Unresolved', 'Stopped', 'Needs approval', 'Waiting', 'Working', 'Waiting for agents', 'Closed', 'Not hosted', 'Idle', 'Unknown'];
function fixture() {
  const target = createStore();
  target.setSnapshot({ seq: 10, generation: 1, evaluated_at: 1000, projection: {
    roots: [{ id: 'root', name: 'Current', conversation_ids: ['c'], current_conversation_id: 'c', state: 'idle', activity_rank: 7 }],
    conversations: [{ id: 'c', provider: 'codex', origin: 'managed', state: 'idle', current_run_id: 'r', activity_rank: 7 }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle', generation: 1, decision_id: 'proof', last_evidence: { hook_event_name: 'UserPromptSubmit' }, started_ts: '2026-10-15T00:00:00Z' }],
    state_decisions: [{ id: 'proof', evaluatedAt: 1000, turn: { value: 'completed', reason: 'turn_finished', evidenceIds: ['esc'] }, display: { label: 'Idle', details: [] } }],
    messages: [{ id: 'same-body', role: 'user', body: 'Same text' }],
    message_memberships: [{ id: 'membership', message_id: 'same-body', conversation_id: 'c', active: 1 }],
  } });
  target.setConnection('connected');
  return target;
}

it('uses the API state and clock even when unread markers and raw start evidence disagree', () => {
  const target = fixture();
  publishTurns({ history: { read: {}, ready: { c: '2026-10-15T00:00:01Z' }, recent: [] }, turns: [{ id: 'ready', kind: 'idle', conversationId: 'c', time: '2026-10-15T00:00:01Z', to: '/c/c' }] });
  const state = target.getSnapshot();
  expect(resolveActivity(state, ['c'], 'running', new Set(['c'])).state).toBe('idle');
  expect(selectTurns({ ...state, projection: { ...state.projection,
    runs: [...state.projection.runs, { id: 'other-run', conversation_id: 'c', generation: 99, state: 'waiting_input' }] } }, { read: {}, ready: {}, recent: [] })).toEqual([]);
  expect(workingElapsed(resolveWorkingTurn({ ...state.projection.runs[0], state: 'running' }), Date.parse('2026-10-15T00:01:00Z'))).toBe('');
  render(<MemoryRouter><RootList state={state} roots={selectRoots(state)}/></MemoryRouter>);
  expect(screen.getByRole('link', { name: 'Current' }).querySelector('[data-state="idle"]')).toBeTruthy();
  expect(screen.queryByText('Waiting')).toBeNull();
});

it('applies an expiry decision without a new ledger seq and rejects an older evaluation', () => {
  const target = fixture();
  const patch = { type: 'patch' as const, from_seq: 10, seq: 10, generation: 1, evaluated_at: 2000, changes: {
    runs: { upsert: [{ id: 'r', conversation_id: 'c', state: 'unknown', decision_id: 'expired' }], remove: [] },
    conversations: { upsert: [{ id: 'c', state: 'unknown', current_run_id: 'r' }], remove: [] },
    roots: { upsert: [{ id: 'root', name: 'Current', conversation_ids: ['c'], current_conversation_id: 'c', state: 'unknown' }], remove: [] },
    state_decisions: { upsert: [{ id: 'expired', evaluatedAt: 2000, turn: { value: 'unknown', reason: 'progress_expired', evidenceIds: ['progress'] } }], remove: [] },
  } };
  expect(target.applyPatch(patch)).toBe(true);
  expect(target.getSnapshot().seq).toBe(10);
  expect(resolveActivity(target.getSnapshot(), ['c']).state).toBe('unknown');
  expect(target.getSnapshot().projection.state_decisions).toEqual(patch.changes.state_decisions.upsert);
  target.applyPatch({ ...patch, evaluated_at: 1500, changes: { runs: { upsert: [{ id: 'r', state: 'running' }], remove: [] } } });
  expect(target.getSnapshot().projection.runs[0].state).toBe('unknown');
});

it('orders all display states by the API rank and uses the contract labels', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    roots: states.map((state, activity_rank) => ({ id: state, name: state, state, activity_rank, conversation_ids: [state], current_conversation_id: state })).reverse(),
    conversations: states.map(state => ({ id: state, name: state, state })),
  } });
  const state = target.getSnapshot();
  expect(states.map(toExecutionState)).toEqual(states);
  render(<MemoryRouter><RootList state={state} roots={selectRoots(state)}/></MemoryRouter>);
  const rows = screen.getAllByRole('link');
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(states);
  expect(rows.map(row => row.querySelector('.root-row-meta .status-label')?.textContent)).toEqual(labels);
});

it('keeps equal text from another terminal separate until the API supplies the received message ID', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projection: {}, generation: 1 }) })));
  const target = fixture();
  const watch = { id: 'send', conversation_id: 'c', body: 'Same text', decision: { display: 'Unconfirmed', reason: 'ambiguous_candidates' } };
  target.setSendWatches([watch]);
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getAllByText('Same text')).toHaveLength(2);
  expect(screen.getByText('Unconfirmed')).toBeTruthy();
  act(() => target.setSendWatches([{ ...watch, message_id: 'same-body', decision: { display: 'Delivered', reason: 'correlated_receipt' } }]));
  expect(screen.getAllByText('Same text')).toHaveLength(1);
  expect(screen.getByText('Delivered')).toBeTruthy();
});
