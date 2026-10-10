import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore, type ScreenState } from '../lib/store.ts';
import { selectRoots, startedAt, type Root } from '../lib/roots.ts';
import { formatAgo, formatClock, formatWhen, modelName } from '../lib/format.ts';
import { RootList, RootTree } from '../components/RootViews.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { stateTone } from '../components/StateBadge.tsx';
import { Notifications } from '../components/notifications/Notifications.tsx';
import { collectNotifications, notificationDetail } from '../components/notifications/model.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { SearchPage } from '../pages/search/SearchPage.tsx';
import type { DelegationTree, TreeNode } from '../pages/tree/model.ts';
import type { SearchResponse } from '../pages/search/model.ts';

const NOW = new Date(2026, 9, 8, 15, 30).getTime();
const RECENT = new Date(NOW - 90 * 60_000).toISOString();
const OLD = new Date(NOW - 48 * 60 * 60_000).toISOString();
const root: Root = { id: 'root', name: 'Repo-001', project: 'repo', state: 'idle', last_activity_ts: RECENT,
  conversation_ids: ['c'], running_children: 0, total_children: 0 };
const client = { command: vi.fn(async (command: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true,
  result: command === 'files.worktrees' ? { worktree: '/repo', worktrees: [
    { path: '/repo', branch: 'main' }, { path: '/active', branch: 'active' }, { path: '/old', branch: 'old' },
  ] } : command === 'files.list' ? { entries: [{ name: 'a.ts', path: 'a.ts', kind: 'file', git: [] }] } : {} })) };
function state(projection: ScreenState['projection']): ScreenState {
  return { seq: 1, generation: 1, connection: 'connected', deltas: {}, projection };
}
function target(projection: ScreenState['projection'] = {}) {
  const store = createStore(); store.setSnapshot(state({ projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }], ...projection }));
  store.setConnection('connected'); return store;
}
beforeEach(() => {
  localStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  client.command.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('1: ignores unknown runs and shows only four notification kinds with a conversation sentence in Japanese', () => {
  const previous = state({ runs: [{ id: 'run', conversation_id: 'c', state: 'running' }] });
  const projection = { roots: [{ ...root }], conversations: [{ id: 'c', provider: 'codex', first_message_ts: RECENT }],
    runs: Array.from({ length: 105 }, (_, index) => ({ id: String(index), conversation_id: 'c', state: 'unknown', reason: 'unconfirmed_end_evidence' })) };
  expect(collectNotifications(previous, state(projection))).toEqual([]);
  const store = target({ ...projection, runs: [...projection.runs, { id: 'run', conversation_id: 'c', state: 'running' }] });
  render(<MemoryRouter><Notifications target={store} client={client} language="ja" compact initiallyOpen={false}/></MemoryRouter>);
  expect(document.querySelector('.bell-count')).toBeNull();
  act(() => store.setSnapshot(state({ ...projection, runs: [{ id: 'run', conversation_id: 'c', state: 'ended', last_evidence_ts: OLD }] })));
  fireEvent.click(screen.getByRole('button', { name: '通知' }));
  expect(screen.getByRole('heading', { name: '完了' })).toBeTruthy();
  expect(screen.getByText('Repo-20261008は完了しました。')).toBeTruthy();
  expect(screen.getByText(formatWhen(OLD, 'ja', NOW))).toBeTruthy();
  expect(screen.getByRole('button', { name: 'すべて消す' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: '承認待ち' })).toBeTruthy();
  expect(document.body.textContent).not.toContain('unconfirmed_end_evidence');
  const notices = collectNotifications(previous, state({ ...projection, approvals: [{ id: 'approval', state: 'pending', conversation_id: 'c' }],
    runs: [{ id: 'input', conversation_id: 'c', state: 'waiting_input', last_evidence_ts: new Date(NOW).toISOString() }, { id: 'failed', conversation_id: 'c', state: 'failed', last_evidence_ts: new Date(NOW).toISOString() },
      { id: 'done', conversation_id: 'c', state: 'ended', last_evidence_ts: new Date(NOW).toISOString() }] }), 'en', NOW);
  expect(notices.map(n => n.kind)).toEqual(['approval', 'input', 'failed', 'completed']);
  expect(notificationDetail(notices[0], state(projection), 'en')).toBe('Repo-20261008 is waiting for approval.');
});

it('2: Files starts collapsed, remembers its toggle, groups old worktrees and fits complete rows', async () => {
  localStorage.setItem('agent-graph-language', 'ja');
  let resize: ResizeObserverCallback | undefined;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {} disconnect() {}
  });
  const store = target({ runs: [{ id: 'run', state: 'running', cwd: '/active/subdirectory' }] });
  const view = render(<MemoryRouter initialEntries={['/p/repo']}><App target={store} client={client}/></MemoryRouter>);
  expect(screen.queryByRole('tree')).toBeNull();
  expect(client.command.mock.calls.some(([command]) => command === 'files.list')).toBe(false);
  fireEvent.click(screen.getByRole('tab', { name: 'ファイル' }));
  await screen.findByRole('tree', { name: 'ファイル' });
  const select = screen.getByRole('combobox', { name: '作業ツリー' });
  expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['main · repo', 'active · active']);
  expect(screen.getByPlaceholderText('名前で絞り込む')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ほかの作業ツリー 1 件' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'ほかの作業ツリー 1 件' }));
  expect(within(select).getAllByRole('option')).toHaveLength(3);
  act(() => resize?.([{ contentRect: { height: 103 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect((document.querySelector('.explorer-scroll') as HTMLElement).style.height).toBe('78px');
  view.unmount();
  render(<MemoryRouter initialEntries={['/p/repo?panel=files']}><App target={store} client={client}/></MemoryRouter>);
  await screen.findByRole('tree', { name: 'ファイル' });
  fireEvent.click(screen.getByRole('tab', { name: 'グラフ' }));
  expect(screen.queryByRole('tree')).toBeNull();
});

function node(id: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return { id, kind: 'delegation', label: id, role: 'implement', provider: 'codex', model: 'gpt-6.1-sol', state: 'failed', attempts: [], children: [],
    run: { id: `${id}:1`, last_evidence_ts: OLD }, ...overrides };
}
it('3: folds old failures inside a planner group, gives the group a time and keeps retry off the rows', () => {
  const tree: DelegationTree = { roots: ['root'], unresolved: [], edges: [{ id: 'old-edge', source: 'planner', target: 'old', title: 'old', confidence: 'confirmed', kind: 'delegated' }], nodes: [node('root', { children: ['planner'] }),
    node('planner', { role: 'planner', run: undefined, children: ['old', 'active'] }), node('old', { delegation: { id: 'old', state: 'failed' } }),
    node('active', { state: 'running', run: { last_evidence_ts: RECENT } })] };
  render(<RootTree tree={tree} onSelect={vi.fn()} onRetry={vi.fn()} language="ja"/>);
  expect(screen.queryByRole('button', { name: /old/ })).toBeNull();
  expect(screen.queryByRole('button', { name: '再試行' })).toBeNull();
  expect(screen.getByRole('heading', { name: /planner/ }).querySelector('time')?.textContent).toBe(formatWhen(RECENT, 'ja', NOW));
  fireEvent.click(screen.getByRole('button', { name: /以前/ }));
  expect(screen.getByRole('button', { name: /old/ }).textContent).toContain(formatWhen(OLD, 'ja', NOW));
});
it('3: preserves recorded roles and makes retry available after opening the failed request', async () => {
  const store = target({ roots: [{ ...root, name: 'Root' }], conversations: [{ id: 'c' }, { id: 'child', provider: 'codex' }],
    runs: [{ id: 'child:1', conversation_id: 'child', state: 'failed', last_evidence_ts: RECENT }],
    delegations: [{ id: 'request', root_id: 'root', title: 'Implement UI', role: 'implement', state: 'failed', attempts: [{ run_id: 'child:1' }] }],
    relations: [{ id: 'relation', type: 'delegated', from_id: 'c', to_id: 'child', evidence: { agentType: 'review' } }] });
  render(<MemoryRouter><WorkspacePage project="repo" target={store} client={client} language="ja" renderConversation={() => <p>Child details</p>}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'パネル' });
  const row = within(flow).getByRole('link', { name: /Implement UI/ });
  expect(row.textContent).not.toContain('review');
  expect(screen.queryByRole('button', { name: '再試行' })).toBeNull();
  fireEvent.click(row);
  fireEvent.click(screen.getByRole('button', { name: '再試行' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('intake.retry', { requestId: 'request' }));
});

it('4: list, tree and detail time wrappers use the same Japanese timestamp without conflicting rounding', () => {
  expect(formatAgo(RECENT, 'ja', NOW)).toBe(formatWhen(RECENT, 'ja', NOW));
  render(<MemoryRouter><RootList roots={[root]} language="ja"/><RelativeTime value={RECENT} now={NOW} language="ja"/></MemoryRouter>);
  expect(screen.getAllByText(formatWhen(RECENT, 'ja', NOW))).toHaveLength(2);
  expect(formatWhen(new Date(2026, 9, 7, 15, 30), 'ja', NOW)).toBe('昨日 15:30');
  expect(formatWhen(new Date(2026, 8, 30, 6, 4), 'ja', NOW)).toBe('9月30日 6:04');
  document.documentElement.lang = 'ja';
  expect(formatClock(OLD)).toBe(formatWhen(OLD, 'ja', NOW));
});
it('5: names the series after its first statement and lists its last statement instead of observation time', () => {
  const first = new Date(2026, 8, 26, 8, 0).toISOString();
  const snapshot = state({ projects: [{ id: 'repo', display_name: 'Repo', state: 'registered' }], roots: [{ ...root, conversation_ids: ['c', 'continued'], last_activity_ts: new Date(NOW).toISOString() }],
    conversations: [{ id: 'c', created_ts: new Date(NOW).toISOString(), first_message_ts: first, last_message_ts: first }, { id: 'continued', created_ts: RECENT, last_message_ts: RECENT }] });
  expect(selectRoots(snapshot)[0]).toMatchObject({ name: 'Repo-20260926', last_activity_ts: RECENT });
  delete snapshot.projection.conversations![0].first_message_ts;
  snapshot.projection.runs = [{ conversation_id: 'c', started_ts: first }];
  expect(startedAt(snapshot, { ...root, conversation_ids: ['c', 'continued'] })).toBe(Date.parse(first));
  snapshot.projection.messages = [{ id: 'm', source_ts: first }];
  snapshot.projection.message_memberships = [{ message_id: 'm', conversation_id: 'c', active: 1 }];
  expect(selectRoots(snapshot)[0].name).toBe('Repo-20260926');
  snapshot.projection.conversations![0].message_count = 500;
  snapshot.projection.messages![0].source_ts = RECENT;
  expect(selectRoots(snapshot)[0].name).toBe('Repo-20260926');
});
it('6: idle rows show their status and time and the five visible states have distinct colours and labels', () => {
  const states = ['running', 'waiting_approval', 'waiting_input', 'failed', 'ended'];
  expect(new Set(states.map(stateTone)).size).toBe(5);
  render(<MemoryRouter><RootList roots={[root, ...states.map((state, index) => ({ ...root, id: `r${index}`, name: state, state }))]} language="ja"/></MemoryRouter>);
  expect(screen.getByRole('link', { name: new RegExp(root.name) }).querySelector('.root-state')?.getAttribute('data-state')).toBe('idle');
  for (const label of ['実行中', '承認待ち', '返答待ち', '失敗', '完了']) expect(screen.getByRole('img', { name: label })).toBeTruthy();
  const style = document.createElement('style');
  style.textContent = readFileSync('app/src/styles.css', 'utf8'); document.head.append(style);
  const backgrounds = [...document.querySelectorAll('.root-row .status-dot')].map(dot => getComputedStyle(dot).background);
  expect(new Set(backgrounds).size).toBe(6);
  style.remove();
});

it('7: command palette and shortcut settings follow Japanese and the html language', () => {
  localStorage.setItem('agent-graph-language', 'ja');
  render(<MemoryRouter initialEntries={['/settings']}><App target={target()} client={client}/></MemoryRouter>);
  expect(document.documentElement.lang).toBe('ja');
  expect(screen.getByRole('heading', { name: 'キー操作' })).toBeTruthy();
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
  expect(screen.getByRole('dialog', { name: '検索と操作' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '会話を検索' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '閉じる' })).toBeTruthy();
  expect(modelName('GPT-6.1-Sol')).toBe(modelName('GPT-6.1 Sol'));
});
it('7: search uses request titles, cleans markdown, formats Japanese dates and offers Japanese date input', async () => {
  const store = target({ conversations: [{ id: 'child', name: 'done', provider: 'codex' }],
    delegations: [{ title: 'Fix sidebar', attempts: [{ run_id: 'child:1' }] }] });
  const response: SearchResponse = { mode: 'fts5', total: 1, unsupported: [], results: [{ id: 'result', kind: 'message', fact_id: 'fact', subject: 'message:m', body: '**sidebar** fixed',
    reason: null, conversation_id: 'child', run_id: 'child:1', message_id: 'm', project: 'repo', provider: 'codex', source_ts: OLD, confidence: 'confirmed' }] };
  render(<MemoryRouter><SearchPage target={store} language="ja" client={{ search: async () => response }}/></MemoryRouter>);
  expect(screen.getAllByPlaceholderText('年/月/日 時:分')).toHaveLength(2);
  fireEvent.change(screen.getAllByPlaceholderText('年/月/日 時:分')[0], { target: { value: '2026/09/30 06:04' } });
  expect((screen.getAllByPlaceholderText('年/月/日 時:分')[0] as HTMLInputElement).value).toBe('2026/09/30 06:04');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sidebar' } });
  fireEvent.click(screen.getByRole('button', { name: '検索' }));
  await screen.findByRole('link', { name: 'Fix sidebar' });
  expect(document.querySelector('.search-excerpt')?.textContent).toBe('sidebar fixed');
  expect(document.querySelector('.search-results time')?.textContent).toBe(formatWhen(OLD, 'ja', NOW));
  expect(document.querySelector('.search-results')?.textContent).not.toContain('done');
});
