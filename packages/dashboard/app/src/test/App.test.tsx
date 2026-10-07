import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  expect(screen.getByRole('link', { name: 'demo' }).getAttribute('href')).toBe('/p/demo');
  expect(screen.getByRole('status').textContent).toContain('Runner unavailable');
  expect(screen.getByRole('link', { name: 'Pending approvals1' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  expect(screen.getByText('No notifications yet')).toBeTruthy();
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
it.each([['/p/demo', 'Project workspace'], ['/c/demo', 'Conversation'], ['/inbox', 'Approval inbox'],
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
