import { projectRoots } from '../src/test/root-fixture.ts';
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type ScreenStore } from '../src/lib/store.ts';
import { HomePage } from '../src/pages/home/HomePage.tsx';

afterEach(cleanup);
export function createActivityStore(): ScreenStore {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: '/repo/alpha', display_name: 'alpha', root_path: '/repo/alpha', state: 'registered' }, { id: '/repo/beta', display_name: 'beta', root_path: '/repo/beta', state: 'registered' }],
    tasks: [{ id: 't1', name: 'Implement API', project: '/repo/alpha', state: 'running' }, { id: 't2', name: 'Review UI', project: '/repo/beta', state: 'idle' }],
    conversations: [
      // api は core の投影の名前と依頼の抜粋を会話の行に載せる。
      { id: 'c1', task_id: 't1', provider: 'codex', origin: 'managed', type: 'interactive', history_format: 'jsonl', name: 'Implement API', name_is_provisional: false, first_request_excerpt: 'Build the API.' },
      { id: 'c2', task_id: 't2', provider: 'claude', origin: 'managed', type: 'interactive', history_format: 'jsonl', name: 'Review UI', name_is_provisional: false, first_request_excerpt: null },
      { id: 'external', provider: 'claude', origin: 'observed', type: 'interactive', history_format: 'jsonl', project: '/repo/alpha', name: 'Investigate latency.', name_is_provisional: true, first_request_excerpt: 'Investigate latency.' },
      { id: 'exec', provider: 'codex', origin: 'observed', type: 'unattended', history_format: 'jsonl', name: null, name_is_provisional: false, first_request_excerpt: null },
      { id: 'unsupported', provider: 'codex', origin: 'observed', history_format: 'paginated', name: null, name_is_provisional: false, first_request_excerpt: null },
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
  projectRoots(target, ['c1', 'c2', 'external']);
  target.setConnection('connected');
  return target;
}
// 外の会話と無人実行と形式未対応の区画は既定で畳まれている。行を確かめる試験では開く。
export function openFolds(...names: string[]) {
  for (const name of names) fireEvent.click(screen.getByRole('button', { name }));
}
it('groups roots by project and leaves conversations that are not roots out', () => {
 render(<MemoryRouter><HomePage target={createActivityStore()}/></MemoryRouter>);
 const api = within(screen.getByRole('region', { name: 'alpha' })).getByRole('link', { name: 'Implement API' });
 expect(api.querySelector('.root-name')?.textContent).toBe('Implement API');
 expect(api.querySelector('.root-state')?.getAttribute('data-state')).toBe('running');
 expect(screen.getByRole('link', { name: /Review UI/ })).toBeTruthy();
 expect(screen.queryByText('External conversations')).toBeNull(); expect(screen.queryByText('Unsupported conversations')).toBeNull();
 expect(screen.queryByText('Background')).toBeNull(); expect(document.querySelector('a[href="/c/exec"]')).toBeNull();
});it('orders running roots first and links each root to its project', () => {
 render(<MemoryRouter><HomePage target={createActivityStore()}/></MemoryRouter>);
 const alpha = screen.getByRole('region', { name: 'alpha' }); const rows = alpha.querySelectorAll('.root-row');
 expect(rows[0].textContent).toContain('Implement API'); expect(rows[1].textContent).toContain('Investigate latency.');
 expect(rows[0].getAttribute('href')).toBe('/p/%2Frepo%2Falpha?root=c1');
});it('shows projected root state and activity time and applies root patches', () => {
 const target = createActivityStore(); render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
 const row = screen.getByRole('link', { name: /Investigate latency/ }); expect(row.querySelector('.root-state')?.getAttribute('data-state')).toBe('unknown');
 expect(row.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-07T01:05:00Z');
 act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: { roots: { remove: [], upsert: [{ ...target.getSnapshot().projection.roots[0], state: 'failed' }] } } }));
 expect(screen.getByRole('link', { name: /Implement API/ }).textContent).toContain('Failed');
});it('uses the projected root name and leaves unrelated conversations out of the list', () => {
 const target = createActivityStore(); const snapshot = target.getSnapshot();
 target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, roots: [{ ...snapshot.projection.roots[0], name: 'agent-graph-001' }] } });
 render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
 expect(screen.getByRole('link', { name: /alpha-20261007/ })).toBeTruthy();
 expect(screen.queryByText('Added the endpoint')).toBeNull(); expect(screen.queryByRole('link', { name: /Investigate latency/ })).toBeNull();
});it('keeps JSON conversation bodies out of root rows', () => {
 const target = createActivityStore(); const snapshot = target.getSnapshot();
 target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, messages: snapshot.projection.messages.map(row => ({ ...row, body: JSON.stringify(row.body) })) } });
 render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
 expect(screen.getByRole('link', { name: /Implement API/ })).toBeTruthy(); expect(screen.queryByText('Added the endpoint')).toBeNull();
});