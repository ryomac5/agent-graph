import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type ScreenStore } from '../src/lib/store.ts';
import { HomePage } from '../src/pages/home/HomePage.tsx';

afterEach(cleanup);
export function createActivityStore(): ScreenStore {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    tasks: [{ id: 't1', name: 'Implement API', project: '/repo/alpha', state: 'running' }, { id: 't2', name: 'Review UI', project: '/repo/beta', state: 'idle' }],
    conversations: [
      { id: 'c1', task_id: 't1', provider: 'codex', origin: 'managed', type: 'interactive', history_format: 'jsonl' },
      { id: 'c2', task_id: 't2', provider: 'claude', origin: 'managed', type: 'interactive', history_format: 'jsonl' },
      { id: 'external', provider: 'claude', origin: 'observed', type: 'interactive', history_format: 'jsonl', project: '/repo/alpha' },
      { id: 'exec', provider: 'codex', origin: 'observed', type: 'unattended', history_format: 'jsonl' },
      { id: 'unsupported', provider: 'codex', origin: 'observed', history_format: 'paginated' },
    ],
    runs: [{ id: 'r1', conversation_id: 'c1', generation: 1, state: 'running', started_ts: '2026-10-07T01:00:00Z' },
      { id: 'r2', conversation_id: 'c2', generation: 1, state: 'idle' },
      { id: 'r3', conversation_id: 'external', state: 'unknown', started_ts: '2026-10-07T01:00:00Z', last_evidence: { kind: 'disconnect' }, last_evidence_ts: '2026-10-07T01:05:00Z', reason: 'Observation interrupted' }],
    messages: [{ id: 'm1', role: 'user', body: 'Build the API. Keep it small.' }, { id: 'm2', role: 'assistant', body: 'Added the endpoint' },
      { id: 'm3', role: 'user', body: [{ text: 'Investigate latency. Then report.' }] }],
    message_memberships: [{ id: 'l1', message_id: 'm1', conversation_id: 'c1', active: 1 }, { id: 'l2', message_id: 'm2', conversation_id: 'c1', active: 1 }, { id: 'l3', message_id: 'm3', conversation_id: 'external', active: 1 }],
    delegations: [{ id: 'd1', attempts: [{ run_id: 'r1', assignment: { executor: 'codex', model: 'test-model' } }] }],
    artifacts: [{ id: 'a1', run_id: 'r1', version: 1, diff: 'diff --git a/api.ts b/api.ts\n--- a/api.ts\n+++ b/api.ts\n-old\n+new\n+added' }],
  } });
  target.setConnection('connected');
  return target;
}
it('groups managed tasks by project and keeps external, unattended and unsupported conversations in separate sections', () => {
  render(<MemoryRouter><HomePage target={createActivityStore()}/></MemoryRouter>);
  expect(within(screen.getByRole('region', { name: '/repo/alpha' })).getByRole('article', { name: 'Implement API' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: '/repo/beta' })).getByRole('article', { name: 'Review UI' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'External conversations' })).getByRole('article', { name: 'Investigate latency.' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Unattended runs' })).getAllByRole('article')).toHaveLength(1);
  expect(within(screen.getByRole('region', { name: 'Unsupported conversations' })).getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Take over' }).getAttribute('href')).toBe('/c/external?adopt=1');
  const implement = screen.getByRole('article', { name: 'Implement API' });
  expect(within(implement).getByText('Codex')).toBeTruthy();
  expect(within(implement).getByText('test-model')).toBeTruthy();
  expect(within(implement).getByText('Added the endpoint')).toBeTruthy();
  expect(within(implement).getByText('1 file · +2 −1')).toBeTruthy();
  // 記録のないモデルと成果物は Unknown と書かず、記録なしと示す。
  const review = screen.getByRole('article', { name: 'Review UI' });
  expect(within(review).getByText('No model recorded')).toBeTruthy();
  expect(within(review).queryByText('Unknown')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Build the API.' })).toBeNull();
});
it('combines state, provider and project filters and can clear them', () => {
  render(<MemoryRouter><HomePage target={createActivityStore()}/></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'unknown' } });
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: '/repo/alpha' } });
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getByRole('article', { name: 'Investigate latency.' })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'running' } });
  expect(screen.queryAllByRole('article')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(screen.getAllByRole('article')).toHaveLength(5);
});
it('shows unknown with last evidence, exact time, relative time and reason, without inferring completion from elapsed time', () => {
  const target = createActivityStore();
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  const row = screen.getByRole('article', { name: 'Investigate latency.' });
  const evidence = within(row).getByRole('link', { name: 'Unknown · Evidence' });
  expect(evidence.textContent).toContain('disconnect');
  expect(evidence.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-07T01:05:00Z');
  expect(evidence.textContent).toContain('Observation interrupted');
  expect(evidence.className).toContain('status-unknown');
  expect(evidence.getAttribute('href')).toBe('/c/external');
  expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-07T01:05:00Z');
  expect(within(screen.getByRole('article', { name: 'Implement API' })).getByRole('link', { name: 'Running · Evidence' })).toBeTruthy();
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: { runs: { upsert: [{ id: 'r1', conversation_id: 'c1', state: 'failed', cause: 'Build failed' }], remove: [] } } }));
  expect(screen.getByText('Build failed')).toBeTruthy();
});
it('keeps unnamed and task-only activity visible and uses the first sentence as a provisional name', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    tasks: [{ id: 'pending', purpose: 'Waiting task', project: '/repo' }],
    conversations: [{ id: 'new', origin: 'managed', provider: 'codex' }],
    messages: [{ id: 'm', body: 'First sentence. Second sentence.' }],
    message_memberships: [{ id: 'l', message_id: 'm', conversation_id: 'new', active: 1 }],
  } });
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  expect(screen.getByRole('article', { name: 'First sentence.' })).toBeTruthy();
  expect(screen.getByRole('article', { name: 'Waiting task' })).toBeTruthy();
});
it('decodes SQLite JSON bodies, evidence and assignment attempts from the actual snapshot format', () => {
  const target = createActivityStore();
  const snapshot = target.getSnapshot();
  const projection = { ...snapshot.projection,
    messages: snapshot.projection.messages.map(row => ({ ...row, body: JSON.stringify(row.body) })),
    runs: snapshot.projection.runs.map(row => ({ ...row, last_evidence: row.last_evidence ? JSON.stringify(row.last_evidence) : null })),
    delegations: snapshot.projection.delegations.map(row => ({ ...row, attempts: JSON.stringify(row.attempts) })),
  };
  target.setSnapshot({ seq: 1, generation: 0, projection });
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  expect(screen.getByText('Added the endpoint')).toBeTruthy();
  expect(screen.getByRole('article', { name: 'Investigate latency.' })).toBeTruthy();
  expect(screen.getByText('test-model')).toBeTruthy();
  expect(screen.getByText('disconnect')).toBeTruthy();
});
