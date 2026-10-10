import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>; }
function mount(path: string) {
  const target = createStore();
  target.setSnapshot({ seq: 0, generation: 0, projection: {
    projects: [{ id: 'first', state: 'registered', display_name: 'First' }, { id: 'last', state: 'registered', display_name: 'Last' }],
    roots: [{ id: 'root', project: 'last', name: 'Session name', state: 'ended', conversation_ids: ['conversation'], last_activity_ts: null, total_children: 0, running_children: 0 }],
    conversations: [{ id: 'conversation', origin: 'observed', provider: 'codex' }],
  } });
  render(<MemoryRouter initialEntries={[path]}><App target={target}/><Location/></MemoryRouter>);
}
it.each([['Settings', 'Settings'], ['Overview', 'Overview'], ['Approvals', 'Approvals'], ['Search', 'Search']])('returns from %s to the exact prior URL and preserves the session sidebar', (link, heading) => {
  const url = '/p/last?root=root&child=conversation#position';
  mount(url);
  fireEvent.click(within(screen.getByRole('complementary', { name: '' })).getByRole('link', { name: link }));
  expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Last sessions' }).textContent).toContain('Session name');
  fireEvent.click(screen.getByRole('button', { name: '← Back' }));
  expect(screen.getByTestId('location').textContent).toBe(url);
});
it('supports Escape outside inputs and uses the last project for direct Settings visits', () => {
  localStorage.setItem('agent-graph-last-workspace', '/p/last?root=root');
  mount('/settings');
  fireEvent.keyDown(screen.getByLabelText('Theme'), { key: 'Escape' });
  expect(screen.getByTestId('location').textContent).toBe('/settings');
  const input = screen.getAllByRole('textbox')[0];
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByTestId('location').textContent).toBe('/settings');
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(screen.getByTestId('location').textContent).toBe('/p/last');
});
it('localizes the Back control', () => {
  localStorage.setItem('agent-graph-language', 'ja'); mount('/settings');
  expect(screen.getByRole('button', { name: '← 戻る' })).toBeTruthy();
});
