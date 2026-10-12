import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { RootList } from '../components/RootViews.tsx';
import { conversationName, formatStartedAt } from '../lib/format.ts';
import { selectRoots } from '../lib/roots.ts';
import { createStore } from '../lib/store.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); });
function createFixture() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    roots: [{ id: 'root', name: 'repo-001', user_name: 'Custom', project: null, state: 'idle', conversation_ids: ['later', 'first'], last_activity_ts: '2026-10-12T15:00:00Z', running_children: 0, total_children: 0 }],
    conversations: [{ id: 'first', created_ts: new Date(2026, 9, 12, 14, 2).toISOString(), first_request_excerpt: 'Improve conversation titles '.repeat(20) },
      { id: 'later', created_ts: new Date(2026, 9, 13).toISOString(), first_request_excerpt: 'Later request' }],
  } });
  return target;
}
it('prefers user names, then the first conversation request, then the dated kit name', () => {
  const state = createFixture().getSnapshot();
  let root = selectRoots(state)[0];
  expect(root.name).toBe('Custom');
  expect(root.auto_name).toBe(state.projection.conversations![0].first_request_excerpt);
  expect(root.kit_name).toBe('repo-001');
  state.projection.roots![0].user_name = null;
  root = selectRoots(state)[0];
  expect(root.name).toBe(state.projection.conversations![0].first_request_excerpt);
  state.projection.conversations![0].first_request_excerpt = null;
  expect(selectRoots(state)[0].name).toBe('repo-20261012');
});
it('uses Claude evidence and Codex delegation descriptions, and ignores inactive relations', () => {
  const state = createFixture().getSnapshot();
  state.projection.conversations!.push({ id: 'claude', provider: 'claude', name: 'Project' }, { id: 'codex', provider: 'codex', name: 'Project' });
  state.projection.relations = [{ type: 'delegated', to_id: 'claude', evidence: { description: '# Check titles' } },
    { type: 'delegated', to_id: 'codex', evidence: { request_id: 'req' } }];
  state.projection.delegations = [{ request_id: 'req', description: 'Implement dates', title: 'Old title' }];
  expect(conversationName(state, 'claude')).toBe('Check titles');
  expect(conversationName(state, 'codex')).toBe('Implement dates');
  state.projection.relations[0].active = 0;
  expect(conversationName(state, 'claude')).toBe('Project');
  state.projection.delegations = [];
  expect(conversationName(state, 'codex')).toBe('Project');
});
it('finds delegation descriptions through run attempts without a request relation', () => {
  const state = createFixture().getSnapshot();
  state.projection.runs = [{ id: 'run', conversation_id: 'first' }];
  state.projection.delegations = [{ request: { description: 'Review dates' }, attempts: [{ run_id: 'run' }] }];
  expect(conversationName(state, 'first')).toBe('Review dates');
});
it('formats start dates as time, month/day and year/month/day', () => {
  const now = new Date(2026, 9, 12, 18).getTime();
  expect(formatStartedAt(new Date(2026, 9, 12, 14, 2).getTime(), now)).toBe('14:02');
  expect(formatStartedAt(new Date(2026, 9, 11).getTime(), now)).toBe('10/11');
  expect(formatStartedAt(new Date(2025, 9, 11).getTime(), now)).toBe('2025/10/11');
});
it.each(['en', 'ja'] as const)('shows the start time at the row end and full identifiers in the tooltip (%s)', language => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 12, 18));
  const state = createFixture().getSnapshot();
  const roots = selectRoots(state);
  render(<MemoryRouter><RootList roots={roots} state={state} language={language}/></MemoryRouter>);
  const link = screen.getByRole('link', { name: 'Custom' });
  expect(link.querySelector('.root-row-meta > time')?.textContent).toBe('14:02');
  expect(link.title).toContain('repo-001');
  expect(link.title).toContain(new Date(2026, 9, 12, 14, 2).toISOString());
  expect(link.title).toContain('2026-10-12T15:00:00Z');
});
