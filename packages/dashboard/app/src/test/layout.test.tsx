import { SIDEBAR_WIDTH_KEY, SIDEBAR_COLLAPSED_KEY, FILES_SPLIT_KEY, FILES_COLLAPSED_KEY, CHANGES_SPLIT_KEY } from '../lib/layout.ts';
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
  vi.stubGlobal('innerWidth', 1440);
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
    runs: [...roots.map(root => ({ id: `run-${root.id}`, conversation_id: root.id, state: root.state, generation: 1, started_ts: time(72), last_evidence_ts: new Date(NOW - 201000).toISOString() })), { id: 'child-run', conversation_id: 'child', state: 'waiting_approval', generation: 1 }],
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
  expect(running.querySelector('.root-state')?.getAttribute('data-state')).toBe('running');
  expect(running.querySelector('.root-elapsed')?.textContent).toBe('3m 21s');
  expect(running.querySelector('.root-running')).toBeNull();
  expect(running.title).toContain('1 agent running');
  const completed = within(sessions).getByRole('region', { name: 'Recent' });
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
  fireEvent.click(screen.getByRole('menuitem', { name: 'New task' }));
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
  expect(within(screen.getByRole('complementary', { name: 'Panel' })).queryByRole('tabpanel')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
  expect(screen.getByRole('separator', { name: 'Panel width' }).getAttribute('aria-valuenow')).toBe('320');
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
  expect(css).toContain('.mobile-panel .workspace-conversation { display: none; }');
  expect(css).toContain('.mobile-panel .workspace-roots { display: none; }');
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
  const edge = screen.getByRole('separator', { name: 'Panel width' });
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

it('1: counts the current running evidence in seconds, updates it and omits the wall clock', () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mount();
  const row = within(document.querySelector('.sidebar') as HTMLElement).getByRole('link', { name: 'Session active' });
  expect(row.querySelector('.root-elapsed')?.textContent).toBe('3m 21s');
  expect(row.querySelector('time')).toBeNull();
  act(() => vi.advanceTimersByTime(1000));
  expect(row.querySelector('.root-elapsed')?.textContent).toBe('3m 22s');
  vi.useRealTimers();
});

it('2: hides zero counts and keeps closed projects to one row with earlier sessions at the end when opened', () => {
  const target = fixture();
  const state = target.getSnapshot();
  state.projection.projects!.push({ id: 'q', display_name: 'Quiet', root_path: '/quiet', state: 'registered' });
  state.projection.roots!.push({ id: 'quiet-old', name: 'Quiet old', project: 'q', state: 'ended', conversation_ids: ['quiet-old'], last_activity_ts: time(48), running_children: 0, total_children: 0 });
  render(<MemoryRouter initialEntries={['/p/p?root=active']}><App target={target} client={client}/></MemoryRouter>);
  const project = screen.getByRole('button', { name: 'Toggle sessions for Quiet' }).closest('.sidebar-project') as HTMLElement;
  expect(within(project).queryByLabelText('Running sessions')).toBeNull();
  expect(project.children).toHaveLength(1);
  expect(within(project).queryByRole('button', { name: /Earlier/ })).toBeNull();
  fireEvent.click(within(project).getByRole('button', { name: 'Toggle sessions for Quiet' }));
  expect(within(project).getByRole('button', { name: 'Earlier 1' }).getAttribute('aria-expanded')).toBe('false');
  expect(within(project).queryByRole('link', { name: 'Quiet old' })).toBeNull();
  fireEvent.click(within(project).getByRole('button', { name: 'Earlier 1' }));
  expect(within(project).getByRole('link', { name: 'Quiet old' })).toBeTruthy();
  const sessions = document.querySelector('.sidebar-roots .root-list')!;
  expect(sessions.lastElementChild?.getAttribute('aria-label')).toBe('Earlier');
});

it('3: removes the repeated graph band only in the panel', () => {
  const view = mount();
  expect(document.querySelector('.workspace-panel .graph-toolbar')).toBeNull();
  expect(document.querySelector('.workspace-panel .graph-root')).toBeTruthy();
  view.unmount();
  mount('/p/p/graph?root=active');
  expect(document.querySelector('.graph-toolbar')).toBeTruthy();
});

it('4: moves commands and notifications into the brand row and removes the top band', () => {
  mount();
  expect(document.querySelector('.topbar')).toBeNull();
  const brand = document.querySelector('.sidebar-brand-row') as HTMLElement;
  expect(within(brand).getByRole('link', { name: 'agent-graph' })).toBeTruthy();
  expect(within(brand).getByRole('button', { name: 'Notifications' })).toBeTruthy();
  expect(within(brand).getByRole('button', { name: 'Search and commands' })).toBeTruthy();
  fireEvent.click(within(brand).getByRole('button', { name: 'Search and commands' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it.each(['en', 'ja'])('keeps the brand on one line and moves the command shortcut into the icon title in %s', language => {
  mount('/p/p?root=active', language);
  const row = document.querySelector('.sidebar-brand-row') as HTMLElement;
  const button = within(row).getByRole('button', { name: language === 'ja' ? 'コマンドと検索' : 'Search and commands' });
  expect(button.textContent).toBe('');
  expect(button.querySelector('kbd')).toBeNull();
  expect(button.querySelector('svg')?.getAttribute('width')).toBe('16');
  expect(button.className).toBe('icon-button');
  expect(button.title).toContain('Cmd+K');
  const css = readFileSync('app/src/styles.css', 'utf8');
  expect(css.match(/\.sidebar-brand-row \.brand \{([^}]+)\}/)?.[1]).toContain('white-space: nowrap');
  expect(css.match(/\.sidebar-actions \{([^}]+)\}/)?.[1]).toContain('flex: none');
  fireEvent.click(button);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('5: opens the compact conversation menu and centers three equal mobile tabs', () => {
  vi.stubGlobal('innerWidth', 390);
  mount();
  const menu = screen.getByRole('button', { name: 'Conversation menu' });
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(menu);
  expect(document.querySelector('.conv-action-menu')?.className).toContain('open');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByRole('region', { name: 'Details' })).toBeTruthy();
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  const css = readFileSync('app/src/styles.css', 'utf8');
  expect(css).toContain('.mobile-tabs button { flex: 1 1 0; min-width: 0; text-align: center;');
  const conversationCss = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  expect(conversationCss).toContain('.conversation-page .conv-title-row .conv-title { flex: 1; }');
  expect(conversationCss).toContain('.conv-action-menu { display: none;');
});

it.each([[1440, 420, false], [1024, 360, false], [960, 360, true]] as const)('uses the specified initial panel layout at %ipx', (viewport, width, collapsed) => {
  vi.stubGlobal('innerWidth', viewport);
  mount();
  if (collapsed) {
    expect(within(screen.getByRole('complementary', { name: 'Panel' })).queryByRole('tabpanel')).toBeNull();
    expect((document.querySelector('.workspace-panel') as HTMLElement).style.width).toBe('0px');
    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
  }
  const resize = screen.getByRole('separator', { name: 'Panel width' });
  expect(resize.getAttribute('aria-valuenow')).toBe(String(width));
  for (let index = 0; index < 50; index++) fireEvent.keyDown(resize, { key: 'ArrowLeft' });
  expect(resize.getAttribute('aria-valuenow')).toBe(String(viewport / 2));
  expect(resize.getAttribute('aria-valuemax')).toBe(String(viewport / 2));
  vi.stubGlobal('innerWidth', 900);
  fireEvent(window, new Event('resize'));
  expect(resize.getAttribute('aria-valuenow')).toBe('450');
  expect(resize.getAttribute('aria-valuemax')).toBe('450');
});

it('resizes the sidebar within bounds, resets and restores its size', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  let view = mount();
  const edge = screen.getByRole('separator', { name: 'Sidebar width' });
  fireEvent.pointerDown(edge, { clientX: 248 }); fireEvent.pointerMove(window, { clientX: 320 }); fireEvent.pointerUp(window);
  expect(edge.getAttribute('aria-valuenow')).toBe('320');
  expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('320');
  view.unmount(); view = mount();
  const restored = screen.getByRole('separator', { name: 'Sidebar width' });
  expect(restored.getAttribute('aria-valuenow')).toBe('320');
  fireEvent.pointerDown(restored, { clientX: 320 }); fireEvent.pointerMove(window, { clientX: 1000 }); fireEvent.pointerCancel(window);
  expect(restored.getAttribute('aria-valuenow')).toBe('400');
  fireEvent.pointerDown(restored, { clientX: 400 }); fireEvent.pointerMove(window, { clientX: 0 }); fireEvent.pointerUp(window);
  expect(restored.getAttribute('aria-valuenow')).toBe('200');
  fireEvent.doubleClick(restored); expect(restored.getAttribute('aria-valuenow')).toBe('248');
});
it('toggles the sidebar with Cmd+B and its buttons, remembers collapse and keeps the mobile view', () => {
  let view = mount();
  fireEvent.keyDown(document, { key: 'b', metaKey: true });
  expect(document.querySelector('.app-shell')?.className).toContain('sidebar-collapsed');
  expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1');
  view.unmount(); view = mount();
  expect(document.querySelector('.app-shell')?.className).toContain('sidebar-collapsed');
  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
  expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
  fireEvent.keyDown(document, { key: 'b', metaKey: true });
  expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
});
it('toggles the right panel with Cmd+Alt+B independently and resets its width', () => {
  mount();
  const edge = screen.getByRole('separator', { name: 'Panel width' });
  fireEvent.keyDown(edge, { key: 'ArrowLeft' }); fireEvent.doubleClick(edge);
  expect(edge.getAttribute('aria-valuenow')).toBe('420');
  fireEvent.keyDown(document, { key: 'b', metaKey: true, altKey: true });
  expect(localStorage.getItem(PANEL_COLLAPSED_KEY)).toBe('1');
  expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0');
  fireEvent.keyDown(document, { key: 'b', metaKey: true, altKey: true });
  expect(screen.getByRole('separator', { name: 'Panel width' })).toBeTruthy();
});
it('drags, restores and resets the file tree height and remembers its collapse', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  let view = mount('/p/p?root=active&panel=files');
  const edge = screen.getByRole('separator', { name: 'File tree height' });
  vi.spyOn(edge.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 420, 606));
  fireEvent.pointerDown(edge, { clientY: 270 }); fireEvent.pointerMove(window, { clientY: 330 }); fireEvent.pointerUp(window);
  expect(edge.getAttribute('aria-valuenow')).toBe('55');
  expect(JSON.parse(localStorage.getItem(FILES_SPLIT_KEY)!)[0]).toBeCloseTo(0.55);
  view.unmount(); view = mount('/p/p?root=active&panel=files');
  expect(screen.getByRole('separator', { name: 'File tree height' }).getAttribute('aria-valuenow')).toBe('55');
  fireEvent.doubleClick(screen.getByRole('separator', { name: 'File tree height' }));
  expect(screen.getByRole('separator', { name: 'File tree height' }).getAttribute('aria-valuenow')).toBe('45');
  fireEvent.click(screen.getByRole('button', { name: 'Collapse file tree' }));
  expect(screen.queryByRole('separator', { name: 'File tree height' })).toBeNull();
  expect(localStorage.getItem(FILES_COLLAPSED_KEY)).toBe('1');
  view.unmount(); mount('/p/p?root=active&panel=files');
  expect(screen.queryByRole('separator', { name: 'File tree height' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand file tree' }));
  expect(screen.getByRole('separator', { name: 'File tree height' })).toBeTruthy();
});
it('resizes both boundaries of the three change sections and restores their ratios', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const view = mount('/p/p?root=active&panel=changes');
  const history = screen.getByRole('separator', { name: 'Commit list height' });
  vi.spyOn(history.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 420, 612));
  fireEvent.pointerDown(history, { clientY: 210 }); fireEvent.pointerMove(window, { clientY: 240 }); fireEvent.pointerUp(window);
  expect(history.getAttribute('aria-valuenow')).toBe('40');
  const files = screen.getByRole('separator', { name: 'Changed files height' });
  fireEvent.pointerDown(files, { clientY: 360 }); fireEvent.pointerMove(window, { clientY: 420 }); fireEvent.pointerUp(window);
  expect(files.getAttribute('aria-valuenow')).toBe('30');
  const ratios = JSON.parse(localStorage.getItem(CHANGES_SPLIT_KEY)!);
  [0.4, 0.3, 0.3].forEach((value, index) => expect(ratios[index]).toBeCloseTo(value));
  view.unmount(); mount('/p/p?root=active&panel=changes');
  expect(screen.getByRole('separator', { name: 'Commit list height' }).getAttribute('aria-valuenow')).toBe('40');
  expect(screen.getByRole('separator', { name: 'Changed files height' }).getAttribute('aria-valuenow')).toBe('30');
  fireEvent.doubleClick(screen.getByRole('separator', { name: 'Commit list height' }));
  expect(screen.getByRole('separator', { name: 'Changed files height' }).getAttribute('aria-valuenow')).toBe('25');
});
