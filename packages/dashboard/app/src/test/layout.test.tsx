import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
import { READY_KEY, READ_KEY } from '../lib/turns.ts';
import { PANEL_COLLAPSED_KEY, PANEL_WIDTH_KEY } from '../pages/workspace/WorkspacePanel.tsx';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const time = (hours: number) => new Date(NOW - hours * 3600000).toISOString();
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const target = createStore();
  const roots = [
    ['active', 'running', 2], ['approval', 'waiting_approval', 2], ['input', 'waiting_input', 2],
    ['unread', 'idle', 2], ['recent', 'ended', 23], ['boundary', 'ended', 24], ['old', 'ended', 25],
  ].map(([id, state, hours]) => ({ id, name: `Session ${id}`, state, project: 'p', last_activity_ts: time(Number(hours)), conversation_ids: [id], running_children: id === 'active' ? 1 : 0, total_children: 1 }));
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }], roots,
    conversations: [...roots.map(root => ({ id: root.id, name: root.name, origin: 'managed', provider: 'codex' })), { id: 'child', provider: 'codex', origin: 'managed', type: 'subagent' }],
    runs: [...roots.map(root => ({ id: `run-${root.id}`, conversation_id: root.id, state: root.state, generation: 1, started_ts: time(2) })), { id: 'child-run', conversation_id: 'child', state: 'waiting_approval', generation: 1 }],
    relations: [{ id: 'edge', type: 'delegated', from_id: 'active', to_id: 'child', evidence: { description: 'Child work', agentType: 'implement' } }],
    approvals: [{ id: 'pending', conversation_id: 'child', run_id: 'child-run', state: 'pending', available_decisions: ['accept', 'decline'], request: { command: 'git status' } }],
    messages: [{ id: 'root-message', role: 'assistant', body: 'Root response' }, { id: 'child-message', role: 'assistant', body: 'Child response' }],
    message_memberships: [{ id: 'rm', message_id: 'root-message', conversation_id: 'active', active: 1 }, { id: 'cm', message_id: 'child-message', conversation_id: 'child', active: 1 }],
  } });
  target.setConnection('connected');
  return target;
}
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };
function Location() { const location = useLocation(); return <output data-testid="route">{location.pathname}{location.search}</output>; }
function mount(route = '/p/p?root=active', language = 'en') {
  localStorage.setItem('agent-graph-language', language);
  return render(<MemoryRouter initialEntries={[route]}><App target={fixture()} client={client}/><Location/></MemoryRouter>);
}
it('1: groups sessions by turns and the current 24-hour boundary, collapses projects and marks selection', async () => {
  localStorage.setItem(READY_KEY, JSON.stringify({ unread: time(2) }));
  localStorage.setItem(READ_KEY, '{}');
  mount();
  const sidebar = document.querySelector('.sidebar') as HTMLElement;
  const sessions = within(sidebar).getByRole('region', { name: 'Project sessions' });
  const turn = await within(sessions).findByRole('region', { name: 'Your turn' });
  expect(within(turn).getByRole('link', { name: 'Session approval' })).toBeTruthy();
  expect(within(turn).getByRole('link', { name: 'Session input' })).toBeTruthy();
  expect(within(turn).getByRole('link', { name: 'Session unread' })).toBeTruthy();
  const running = within(sessions).getByRole('link', { name: 'Session active' });
  expect(running.getAttribute('aria-current')).toBe('page');
  expect(running.querySelector('.root-row-meta')?.textContent).toContain('Running');
  expect(running.querySelector('.root-elapsed')?.textContent).toBe('120m');
  expect(running.querySelector('.root-running')?.textContent).toBe('1 child');
  const completed = within(sessions).getByRole('region', { name: 'Completed' });
  expect(within(completed).getByRole('link', { name: 'Session boundary' })).toBeTruthy();
  expect(within(completed).getByRole('link', { name: 'Session recent' })).toBeTruthy();
  expect(within(sessions).queryByRole('link', { name: 'Session old' })).toBeNull();
  fireEvent.click(within(sessions).getByRole('button', { name: /Earlier/ }));
  expect(within(sessions).getByRole('link', { name: 'Session old' })).toBeTruthy();
  expect(within(sidebar).getByLabelText('Running sessions').textContent).toBe('1');
  expect(sidebar.querySelector('.explorer-tree')).toBeNull();
  fireEvent.click(within(sidebar).getByRole('button', { name: 'Toggle sessions for Project' }));
  expect(within(sidebar).queryByRole('region', { name: 'Project sessions' })).toBeNull();
});
it('2: keeps only the conversation header in the middle and starts tasks from the project plus', () => {
  mount();
  expect(document.querySelector('.workspace-header')).toBeNull();
  expect(document.querySelector('.workspace-requests')).toBeNull();
  const middle = document.querySelector('.workspace-conversation') as HTMLElement;
  expect(within(middle).getByRole('heading', { name: 'Session active' })).toBeTruthy();
  expect(within(middle).getByRole('button', { name: 'Details' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'New task: Project' }));
  expect(screen.getByRole('form', { name: 'New task' })).toBeTruthy();
  expect(screen.getByTestId('route').textContent).toBe('/p/p?create=1');
});
it('3: stores tabs in the URL, clamps and remembers width, and remembers collapse', () => {
  const view = mount();
  expect(screen.getByRole('tab', { name: 'Graph' }).getAttribute('aria-selected')).toBe('true');
  const resize = screen.getByRole('separator', { name: 'Panel width' });
  expect(resize.getAttribute('aria-valuenow')).toBe('420');
  for (let i = 0; i < 30; i++) fireEvent.keyDown(resize, { key: 'ArrowLeft' });
  expect(resize.getAttribute('aria-valuenow')).toBe('720');
  for (let i = 0; i < 30; i++) fireEvent.keyDown(resize, { key: 'ArrowRight' });
  expect(resize.getAttribute('aria-valuenow')).toBe('320');
  expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe('320');
  fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
  expect(screen.getByTestId('route').textContent).toContain('panel=changes');
  expect(screen.getByRole('link', { name: 'Open full screen' }).getAttribute('href')).toContain('/p/p/changes?root=active');
  expect(document.querySelector('.workspace-panel .git-changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
  expect(localStorage.getItem(PANEL_COLLAPSED_KEY)).toBe('1');
  view.unmount(); mount('/p/p?root=active&panel=changes');
  expect(screen.queryByRole('tabpanel')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
  expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('320');
  expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
});
it('3: opens a child in the middle while keeping graph selection and can deny its approval', async () => {
  mount('/p/p?root=active&panel=graph');
  const panel = screen.getByRole('complementary', { name: 'Panel' });
  expect(panel.querySelector('.graph-canvas')?.className).toContain('graph-tree');
  fireEvent.click(within(panel).getByRole('link', { name: /Child work/ }));
  expect(screen.getByTestId('route').textContent).toContain('child=child');
  expect(screen.getByTestId('route').textContent).toContain('panel=graph');
  expect(screen.getByText('Child response')).toBeTruthy();
  await act(async () => fireEvent.click(within(panel).getByRole('button', { name: 'Deny' })));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'pending', decision: 'decline' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to Session active' }));
  expect(screen.getByText('Root response')).toBeTruthy();
});
it('4: switches narrow-screen views and defines the 900px breakpoint with one visible pane', () => {
  mount();
  const views = screen.getByRole('navigation', { name: 'Views' });
  fireEvent.click(within(views).getByRole('button', { name: 'Sessions' }));
  expect(document.querySelector('.app-shell')?.className).toContain('mobile-sessions');
  fireEvent.click(within(views).getByRole('button', { name: 'Panel' }));
  expect(document.querySelector('.app-shell')?.className).toContain('mobile-panel');
  fireEvent.click(within(views).getByRole('button', { name: 'Conversation' }));
  expect(document.querySelector('.app-shell')?.className).toContain('mobile-conversation');
  const css = readFileSync('app/src/styles.css', 'utf8');
  expect(css).toContain('@media (max-width: 899px)');
  expect(css).toContain('.mobile-sessions > .main-column { display: none; }');
  expect(css).toContain('.mobile-conversation .workspace-panel { display: none; }');
  expect(css).toContain('.mobile-panel .workspace-conversation, .mobile-panel .workspace-roots { display: none; }');
});
it.each(['/p/p', '/c/active', '/p/p/graph', '/p/p/changes'])('5: retains route %s and uses three panes for project and standalone conversations', route => {
  mount(route);
  expect(screen.getByTestId('route').textContent).toBe(route);
  if (route.endsWith('/graph') || route.endsWith('/changes')) {
    expect(document.querySelector('.workspace-header')).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: 'Panel' })).toBeNull();
  } else {
    expect(document.querySelector('.sidebar')).toBeTruthy();
    expect(document.querySelector('.workspace-conversation')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Panel' })).toBeTruthy();
    expect(screen.getByText('Root response')).toBeTruthy();
  }
});
it('uses Japanese for session groups, panel tabs and mobile navigation', () => {
  mount('/p/p', 'ja');
  expect(screen.getByRole('tab', { name: 'グラフ' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: '変更' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'ファイル' })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'あなたの番' })).toBeTruthy();
  expect(within(screen.getByRole('navigation', { name: '画面' })).getByRole('button', { name: 'セッション' })).toBeTruthy();
  expect(document.querySelector('.sidebar')?.textContent).not.toContain('委譲');
});
it('3: resizes from the left edge by pointer movement and stops after release', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  mount();
  const edge = screen.getByRole('separator');
  fireEvent.pointerDown(edge, { clientX: 700 });
  fireEvent.pointerMove(window, { clientX: 600 });
  expect(edge.getAttribute('aria-valuenow')).toBe('520');
  fireEvent.pointerUp(window);
  fireEvent.pointerMove(window, { clientX: 500 });
  expect(edge.getAttribute('aria-valuenow')).toBe('520');
});
it('5: opens a direct child conversation and returns to its root workspace', () => {
  mount('/c/child?panel=graph');
  expect(screen.getByText('Child response')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Session active' }));
  expect(screen.getByTestId('route').textContent).toBe('/p/p?panel=graph&root=active');
  expect(screen.getByText('Root response')).toBeTruthy();
});
