import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { dictionaries } from '../lib/i18n.ts';
import { createStore } from '../lib/store.ts';
let dark = false;
let change: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); dark = false;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return dark; },
    addEventListener: (_: string, listener: () => void) => { change = listener; }, removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('publishes paginated graph tables together after the last response and retains live patches', async () => {
  const target = createStore();
  const children = Array.from({ length: 50 }, (_, index) => `child-${index}`);
  const pages = { conversations: { total: 51, next: 'c1' }, runs: { total: 50, next: 'r1' } };
  target.setSnapshot({ seq: 1, generation: 1, pages, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Large root', project: 'repo', state: 'idle', conversation_ids: ['root'], total_children: 50 }],
    conversations: [{ id: 'root', provider: 'claude' }],
    relations: children.map(id => ({ id: `rel-${id}`, from_id: 'root', to_id: id, type: 'delegated', active: 1 })),
  } });
  let finishRuns!: (response: Response) => void;
  const runsResponse = new Promise<Response>(resolve => { finishRuns = resolve; });
  const fetch = vi.fn(async (url: URL) => url.searchParams.get('table') === 'runs' ? runsResponse : new Response(JSON.stringify({ generation: 1, rows: children.map(id => ({ id, provider: 'codex' })), next: null })));
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter initialEntries={['/p/repo/graph?root=root']}><App target={target}/></MemoryRouter>);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(target.getSnapshot().projection.conversations).toHaveLength(1);
  expect(screen.queryByRole('tree')).toBeNull();
  expect(document.querySelector('.graph-page')?.getAttribute('aria-busy')).toBe('true');
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 1, changes: { conversations: { upsert: [{ id: 'child-0', provider: 'codex', name: 'Live name' }], remove: [] } } }));
  await act(async () => finishRuns(new Response(JSON.stringify({ generation: 1, rows: children.map(id => ({ id: `run-${id}`, conversation_id: id, state: 'ended', started_ts: '2026-09-01T10:00:00Z', ended_ts: '2026-09-01T11:00:00Z' })), next: null }))));
  await waitFor(() => expect(screen.getByRole('treeitem', { name: /^Earlier 50/ })).toBeTruthy());
  expect(target.getSnapshot().projection.conversations).toHaveLength(51);
  expect(target.getSnapshot().projection.conversations?.find(row => row.id === 'child-0')?.name).toBe('Live name');
  expect(target.getSnapshot().pages?.runs.next).toBeNull();
  expect(document.querySelector('.graph-page')?.getAttribute('aria-busy')).toBe('false');
});
it.each(['request', 'advance', 'first request'])('renders the collected graph and an error after a pagination %s failure', async failure => {
  const target = createStore();
  const snapshot = { seq: 1, generation: 1, pages: {
    conversations: { total: 3, next: 'c1' }, runs: { total: 1, next: 'r1' },
  }, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Partial root', project: 'repo', state: 'idle', conversation_ids: ['root'] }],
    conversations: [{ id: 'root', provider: 'claude' }],
    relations: [{ id: 'rel', from_id: 'root', to_id: 'child', type: 'delegated', active: 1 }],
  } };
  target.setSnapshot(snapshot);
  let finishPage!: (response: Response) => void;
  const pendingPage = new Promise<Response>(resolve => { finishPage = resolve; });
  let finishRuns!: (response: Response) => void;
  const pendingRuns = new Promise<Response>(resolve => { finishRuns = resolve; });
  const fetch = vi.fn(async (url: URL | string) => {
    if (typeof url === 'string') return new Response('', { status: 404 });
    if (url.searchParams.get('table') === 'runs') return pendingRuns;
    if (url.searchParams.get('after') === 'c2' || failure === 'first request') return pendingPage;
    return new Response(JSON.stringify({ generation: 1, rows: [{ id: 'child', provider: 'codex', name: 'Fetched child' }], next: 'c2' }));
  });
  vi.stubGlobal('fetch', fetch);
  render(<MemoryRouter initialEntries={['/p/repo/graph?root=root']}><App target={target}/></MemoryRouter>);
  await waitFor(() => expect(fetch.mock.calls.flatMap(([url]) => url instanceof URL
    ? [`${url.searchParams.get('table')}:${url.searchParams.get('after')}`] : [])).toEqual(failure === 'first request'
    ? ['conversations:c1'] : ['conversations:c1', 'conversations:c2']));
  expect(document.querySelector('.graph-page')?.getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByRole('tree')).toBeNull();
  await act(async () => finishPage(failure === 'advance'
    ? new Response(JSON.stringify({ generation: 1, rows: [{ id: 'second-child', provider: 'codex' }], next: 'c2' }))
    : new Response('Page unavailable', { status: 500 })));
  const error = failure === 'advance' ? 'Unable to advance activity list' : '500';
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(error));
  expect(document.querySelector('.graph-page')?.getAttribute('aria-busy')).toBe('false');
  expect(screen.queryByText('Loading…')).toBeNull();
  expect(screen.getByRole('tree')).toBeTruthy();
  expect(target.getSnapshot().pages?.conversations.next).toBeNull();
  expect(target.getSnapshot().pages?.runs.next).toBe('r1');
  expect(target.getSnapshot().projectionError).toContain(error);
  expect(target.getSnapshot().projection.conversations).toHaveLength(failure === 'advance' ? 3 : failure === 'request' ? 2 : 1);
  if (failure !== 'first request') expect(screen.getByRole('tree').textContent).toContain('Fetched child');
  await act(async () => finishRuns(new Response(JSON.stringify({ generation: 1, rows: [{ id: 'run', conversation_id: 'root', state: 'idle' }], next: null }))));
  await waitFor(() => expect(target.getSnapshot().pages?.runs.next).toBeNull());
  expect(document.querySelector('.graph-page')?.getAttribute('aria-busy')).toBe('false');
  expect(screen.getByRole('alert').textContent).toContain(error);
  act(() => target.setSnapshot({ ...snapshot, pages: undefined }));
  expect(target.getSnapshot().projectionError).toBeUndefined();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('renders navigation, projects, pending approvals, connection state and bell', () => {
  const store = createStore();
  store.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'demo', display_name: 'demo', state: 'registered' }], tasks: [{ id: 't', project: 'demo' }], approvals: [{ id: 'a', state: 'pending' }, { id: 'b', state: 'expired' }] } });
  store.setConnection('runner_unavailable');
  render(<MemoryRouter><App target={store}/></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Overview' })).toBeTruthy();
  expect(within(screen.getByRole('complementary')).getByRole('link', { name: 'demo' }).getAttribute('href')).toBe('/p/demo');
  expect(screen.getByRole('status').textContent).toContain('Runner offline');
  expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Approvals' }).querySelector('.nav-count')?.textContent).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  expect(screen.getByRole('heading', { name: 'Approval pending' })).toBeTruthy();
});
it('uses the OS theme, reacts to changes, allows explicit overrides and Japanese', () => {
  render(<MemoryRouter initialEntries={['/settings']}><App/></MemoryRouter>);
  expect(screen.getByLabelText('Theme').closest('label')?.querySelector('small')).toBeNull();
  expect(screen.getByLabelText('Language').closest('label')?.querySelector('small')).toBeNull();
  expect(document.documentElement.dataset.theme).toBe('light');
  dark = true; change?.(); expect(document.documentElement.dataset.theme).toBe('dark');
  fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
  expect(document.documentElement.dataset.theme).toBe('light');
  expect(localStorage.getItem('agent-graph-theme')).toBe('light');
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ja' } });
  expect(screen.getByRole('heading', { name: '設定' })).toBeTruthy();
  expect(document.documentElement.lang).toBe('ja');
  expect(screen.getByLabelText('テーマ').closest('label')?.querySelector('small')).toBeNull();
  expect(screen.getByLabelText('言語').closest('label')?.querySelector('small')).toBeNull();
});
it.each([['/p/demo', null], ['/c/demo', 'Conversation'], ['/inbox', 'Approvals'],
  ['/p/demo/tree', 'Other'], ['/p/demo/changes', 'Other'], ['/search', 'Search']])('renders route %s', (path, heading) => {
  render(<MemoryRouter initialEntries={[path]}><App/></MemoryRouter>);
  if (heading) expect(screen.getByRole('heading', { name: heading })).toBeTruthy(); else { expect(document.querySelector('.workspace-header')).toBeNull(); expect(screen.getByRole('tab', { name: 'Graph' })).toBeTruthy(); }
});
it('shows unknown as a grey dot and a word, keeps the reason in the title and links to details', async () => {
  const { StateBadge } = await import('../components/StateBadge.tsx');
  render(<MemoryRouter><StateBadge detailed state="unknown" evidenceUrl="/c/demo" evidence="Disconnect" evidenceTime="2026-10-07" reason="Observation interrupted"/></MemoryRouter>);
  const link = screen.getByRole('link', { name: 'Unknown · Details' });
  expect(link.className).toContain('status-unknown');
  expect(link.textContent).toBe('Unknown'); expect(link.querySelector('.status-dot')).toBeTruthy();
  expect(link.title).toContain('Observation interrupted'); expect(link.getAttribute('href')).toBe('/c/demo');
});
it('shares live activity, approval counts, commands and notices across all stage 5 routes', async () => {
  const target = createStore();
  const client = { command: vi.fn(async (_command: string, _payload?: unknown) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: '/repo/demo', display_name: 'demo', root_path: '/repo/demo', state: 'registered' }],
    roots: [{ id: 'c', name: 'Console conversation', project: '/repo/demo', state: 'running', last_activity_ts: null, conversation_ids: ['c'], running_children: 0, total_children: 0 }],
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
  fireEvent.click(within(screen.getByRole('complementary')).getByRole('link', { name: 'demo' }));
  expect(document.querySelector('.workspace-header')).toBeNull();
  expect(screen.getByRole('button', { name: 'New task: demo' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Graph' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('region', { name: 'demo sessions' })).getByRole('link', { name: /Console conversation/ }));
  expect(screen.getByRole('tab', { name: 'Console conversation' })).toBeTruthy();
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Approvals' }));
  expect(screen.getByRole('heading', { name: 'Approvals' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Approval pending' })).toBeTruthy();
  const inbox = screen.getByRole('region', { name: 'Approvals' });
  await act(async () => fireEvent.click(within(inbox).getByRole('button', { name: 'Allow' })));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'a', decision: 'allow' });
  act(() => target.applyPatch({ type: 'patch', from_seq: 2, seq: 3, generation: 0, changes: {
    approvals: { remove: [], upsert: [{ id: 'a', run_id: 'r', state: 'resolved' }] },
  } }));
  expect(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('link', { name: 'Approvals' }).querySelector('.nav-count')).toBeNull();
});

it('opens Changes from the root workspace and sends review commands', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: '/repo', display_name: 'repo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'c', name: 'Review task', project: '/repo', state: 'ended', last_activity_ts: null, conversation_ids: ['c'], running_children: 0, total_children: 0 }],
    tasks: [{ id: 'task', name: 'Review task', project: '/repo' }],
    conversations: [{ id: 'c', task_id: 'task', origin: 'managed', provider: 'codex' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'ended', generation: 1 }],
    artifacts: [{ id: 'a', run_id: 'r', version: 1, patch_hash: 'hash', diff: 'diff --git a/code.txt b/code.txt\n--- a/code.txt\n+++ b/code.txt\n@@ -1 +1 @@\n-old\n+new\n' }],
  } });
  target.setConnection('connected');
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'approve', ok: true })) };
  render(<MemoryRouter initialEntries={['/p/%2Frepo']}><App target={target} client={client}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
  const link = screen.getByRole('link', { name: 'Open full screen' });
  expect(link.getAttribute('href')).toContain('/p/%2Frepo/changes');
  fireEvent.click(link);
  expect(screen.getByRole('button', { name: 'Comment on code.txt new line 1' })).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })));
  expect(client.command).toHaveBeenCalledWith('review.approve', { artifactId: 'a' });
  expect(screen.getByRole('navigation', { name: 'Project' }).textContent).toBe('ConversationsGraphChanges');
});

it('connects sidebar search to the authenticated search client', async () => {
  const search = vi.fn(async (_query: unknown) => ({ mode: 'fts5' as const, total: 0, results: [], unsupported: [] }));
  render(<MemoryRouter><App searchClient={{ search }}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('link', { name: 'Search' }));
  fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'review marker' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Search' })));
  expect(search.mock.calls[0][0]).toMatchObject({ query: 'review marker' });
  expect(screen.getByText('No results')).toBeTruthy();
});

it.each(['en', 'ja'] as const)('omits explanatory translation keys and empty-view paragraphs in %s', language => {
  for (const key of ['themeHint', 'languageHint', 'emptyBody', 'futureBody', 'selectConversation']) {
    expect(dictionaries[language]).not.toHaveProperty(key);
  }
  localStorage.setItem('agent-graph-language', language);
  const { container } = render(<MemoryRouter initialEntries={['/missing']}><App/></MemoryRouter>);
  expect(screen.getByRole('heading', { name: language === 'ja' ? 'ページが見つかりません' : 'Page not found' })).toBeTruthy();
  expect(container.querySelector('.empty-state p')).toBeNull();
});
