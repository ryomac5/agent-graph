import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
let dark = false;
let change: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); dark = false;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return dark; },
    addEventListener: (_: string, listener: () => void) => { change = listener; }, removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('renders navigation, projects, pending approvals, connection state and bell', () => {
  const store = createStore();
  store.setSnapshot({ seq: 1, generation: 0, projection: { tasks: [{ id: 't', project: 'demo' }], approvals: [{ id: 'a', state: 'pending' }, { id: 'b', state: 'expired' }] } });
  store.setConnection('runner_unavailable');
  render(<MemoryRouter><App target={store}/></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
  expect(within(screen.getByRole('complementary')).getByRole('link', { name: 'demo' }).getAttribute('href')).toBe('/p/demo');
  expect(screen.getByRole('status').textContent).toContain('Runner unavailable');
  expect(screen.getByRole('link', { name: 'Pending approvals1' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  expect(screen.getByRole('heading', { name: 'Approval pending' })).toBeTruthy();
});
it('uses the OS theme, reacts to changes, allows explicit overrides and Japanese', () => {
  render(<MemoryRouter initialEntries={['/settings']}><App/></MemoryRouter>);
  expect(document.documentElement.dataset.theme).toBe('light');
  dark = true; change?.(); expect(document.documentElement.dataset.theme).toBe('dark');
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'light' } });
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('agent-graph-theme')).toBe('light');
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } });
  expect(screen.getByRole('heading', { name: '設定' })).toBeTruthy();
  expect(document.documentElement.lang).toBe('ja');
});
it.each([['/p/demo', 'demo'], ['/c/demo', 'Conversation'], ['/inbox', 'Approval inbox'],
  ['/p/demo/tree', 'Delegation tree'], ['/p/demo/changes', 'Changes'], ['/search', 'Search']])('renders route %s', (path, heading) => {
  render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>);
  expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
});
it('shows unknown with evidence, time, reason and a link instead of relying on color', async () => {
  const { StateBadge } = await import('../components/StateBadge.tsx');
  render(<MemoryRouter><StateBadge state="unknown" evidenceUrl="/c/demo" evidence="Disconnect" evidenceTime="2026-10-07" reason="Observation interrupted"/></MemoryRouter>);
  const link = screen.getByRole('link', { name: 'Unknown · Evidence' });
  expect(link.className).toContain('status-unknown');
  expect(link.textContent).toContain('Disconnect'); expect(link.textContent).toContain('2026-10-07');
  expect(link.textContent).toContain('Observation interrupted'); expect(link.getAttribute('href')).toBe('/c/demo');
});
it('shares live activity, approval counts, commands and notices across all stage 5 routes', async () => {
  const target = createStore();
  const client = { command: vi.fn(async (_command: string, _payload?: unknown) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    tasks: [{ id: 't', name: 'Build console', project: '/repo/demo' }],
    conversations: [{ id: 'c', task_id: 't', name: 'Console conversation', origin: 'managed', provider: 'claude' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'running', generation: 1 }],
  } });
  target.setConnection('connected');
  render(<MemoryRouter><App target={target} client={client}/></MemoryRouter>);
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    approvals: { remove: [], upsert: [{ id: 'a', run_id: 'r', state: 'requested', request: '{"command":"echo approval"}', available_decisions: '["allow","deny"]' }] },
  } }));
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  expect(screen.getByRole('heading', { name: 'Approval pending' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('complementary')).getByRole('link', { name: '/repo/demo' }));
  expect(screen.getByRole('heading', { name: 'demo' })).toBeTruthy();
  expect(screen.getByText('Project workspace')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('region', { name: 'Tasks' })).getByRole('link', { name: 'Running · Evidence' }));
  expect(screen.getByRole('heading', { name: 'Console conversation' })).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Pending approvals1' }));
  expect(screen.getByRole('heading', { name: 'Approval inbox' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Approval pending' })).toBeTruthy();
  const inbox = screen.getByRole('region', { name: 'Approval inbox' });
  await act(async () => fireEvent.click(within(inbox).getByRole('button', { name: 'Allow' })));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'a', decision: 'allow' });
  act(() => target.applyPatch({ type: 'patch', from_seq: 2, seq: 3, generation: 0, changes: {
    approvals: { remove: [], upsert: [{ id: 'a', run_id: 'r', state: 'resolved' }] },
  } }));
  expect(screen.getByRole('link', { name: 'Pending approvals0' })).toBeTruthy();
});
