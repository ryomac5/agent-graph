import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, renderHook, screen, fireEvent } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';
import { createStore } from "./current-fixture.ts";
import { buildRootTree, isCompletedGraph, selectRoots, useRootIndex } from '../lib/roots.ts';
import { RootTree } from '../components/RootViews.tsx';
import { GraphPage } from '../pages/graph/GraphPage.tsx';
import { buildRows, readCurrentWork, readReport, readSegments } from '../pages/graph/rows.ts';
const NOW = Date.parse('2026-10-08T12:00:00Z');

// 本文と識別子は架空にし、系列、状態、関係の向き、時刻の欠落を写す。
function createProjectionFixture() {
  const target = createStore();
  const children = [
    { id: 'old-a', parent: 'first', time: '2026-09-25T08:00:00Z' },
    { id: 'old-b', parent: 'first', time: '2026-09-25T09:00:00Z' },
    { id: 'old-c', parent: 'middle', time: '2026-10-06T08:00:00Z' },
    { id: 'recent-a', parent: 'latest', time: '2026-10-08T11:00:00Z' },
    { id: 'recent-b', parent: 'latest', time: '2026-10-08T10:00:00Z' },
    { id: 'recent-c', parent: 'latest', time: '2026-10-08T09:00:00Z' },
    { id: 'recent-d', parent: 'latest', time: '2026-10-08T08:00:00Z' },
    { id: 'recent-e', parent: 'middle', time: '2026-10-08T07:00:00Z' },
    { id: 'recent-f', parent: 'middle', time: '2026-10-08T06:00:00Z' },
  ];
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'repo-001', project: 'repo', state: 'running', conversation_ids: ['first', 'latest', 'middle'],
      last_activity_ts: '2026-10-08T11:30:00Z', running_children: 0, total_children: 10 }],
    conversations: [
      { id: 'first', provider: 'claude', created_ts: '2026-09-25T07:00:00Z' },
      { id: 'middle', provider: 'claude', created_ts: '2026-10-06T07:00:00Z' },
      { id: 'latest', provider: 'claude', created_ts: '2026-10-08T07:00:00Z' },
      ...children.map(child => ({ id: child.id, provider: 'claude', type: 'subagent' })),
      { id: 'unresolved', provider: 'codex', type: 'subagent' },
    ],
    runs: [
      { id: 'root-run', conversation_id: 'latest', generation: 2, state: 'running', model: 'claude-opus-5-5', last_evidence_ts: '2026-10-08T11:30:00Z' },
      ...children.map(child => ({ id: 'run-' + child.id, conversation_id: child.id, generation: 1, state: 'idle', ended_ts: null,
        started_ts: child.time, last_evidence_ts: child.time, model: 'claude-opus-5-5' })),
    ],
    relations: [
      { id: 'continued-a', type: 'continued', from_id: 'first', to_id: 'latest', active: 1 },
      { id: 'continued-b', type: 'continued', from_id: 'latest', to_id: 'middle', active: 1 },
      ...children.map(child => ({ id: 'relation-' + child.id, type: 'delegated', from_id: child.parent, to_id: child.id, active: 1,
        confidence: 'confirmed', evidence: JSON.stringify({ agentType: 'general-purpose', description: child.id }) })),
      { id: 'duplicate', type: 'delegated', from_id: 'first', to_id: 'old-a', active: 1, evidence: '{}' },
      { id: 'unresolved-relation', type: 'delegated', from_id: 'middle', to_id: 'unresolved', active: 1, evidence: '{"role":"implement"}' },
      { id: 'inactive', type: 'delegated', from_id: 'latest', to_id: 'removed', active: 0 },
    ],
    delegations: [
      { id: 'kit-a', root_id: 'root', state: 'done', title: 'Finished task A', role: 'implement', kit: '{"graph":"batch"}', attempts: '[{"attempt":1,"state":"done","run_id":"missing-a"}]' },
      { id: 'kit-b', root_id: 'root', state: 'done', title: 'Finished task B', role: 'implement', kit: '{"graph":"batch"}', attempts: '[{"attempt":1,"state":"done","run_id":"missing-b"}]' },
      { id: 'kit-c', root_id: 'root', state: 'done', title: 'Finished task C', role: 'implement', kit: '{"graph":"batch"}', attempts: '[{"attempt":1,"state":"done","run_id":"missing-c"}]' },
      { id: 'kit-failed', root_id: 'root', state: 'failed', title: 'Failed task', role: 'implement', kit: '{"graph":"batch"}', attempts: '[{"attempt":1,"state":"failed","run_id":"missing-failed"}]' },
    ],
    approvals: [], tasks: [],
  } });
  return target;
}


beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(NOW));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('projects the complete root series without duplicate children and preserves planner groups without exposing identifiers', () => {
  const target = createProjectionFixture(); const state = target.getSnapshot();
  const { result } = renderHook(() => useRootIndex(state));
  const built = buildRootTree(selectRoots(state, 'repo')[0], result.current);
  expect(built.nodes.filter(node => node.id === 'old-a')).toHaveLength(1);
  expect(built.nodes.find(node => node.role === 'planner')?.label).toBe('');
  const rows = buildRows(built, { now: NOW });
  expect(rows.all.filter(row => row.role === 'implement')).toHaveLength(14);
  expect(rows.rows.some(row => row.id === 'graph:batch')).toBe(true);
});
it('selects hidden old children from the URL and leaves undated planner times blank', () => {
  render(<MemoryRouter initialEntries={['/p/repo/graph?root=root&child=old-a']}><GraphPage embedded project="repo" target={createProjectionFixture()} client={{ command: vi.fn() }}/></MemoryRouter>);
  expect(screen.getByRole('treeitem', { name: /old-a/ }).getAttribute('aria-selected')).toBe('true');
  const batch = screen.getByRole('treeitem', { name: 'Task graph · Task graph' });
  expect(batch.querySelector('.graph-row-end')?.textContent).toBe('');
  expect(screen.queryByText('Unknown time')).toBeNull();
});
it('reads the final tool call only from its own active conversation membership', () => {
  const state = createProjectionFixture().getSnapshot();
  state.projection.messages = [
    { id: 'first-call', source_ts: '2026-10-08T10:00:00Z', role: 'assistant', body: [{ type: 'tool_use', name: 'Read', input: { file_path: 'old.ts' } }] },
    { id: 'last-call', source_ts: '2026-10-08T11:00:00Z', role: 'assistant', body: JSON.stringify([{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/roles.ts' } }]) },
    { id: 'other-call', source_ts: '2026-10-08T11:30:00Z', role: 'assistant', body: [{ type: 'tool_use', name: 'Bash', input: { command: 'secret-other-command' } }] },
    { id: 'report', source_ts: '2026-10-08T11:40:00Z', role: 'assistant', body: 'Finished the review.\nMore detail' },
  ];
  state.projection.message_memberships = [{ message_id: 'first-call', conversation_id: 'child', active: 1 }, { message_id: 'last-call', conversation_id: 'child', active: 1 }, { message_id: 'other-call', conversation_id: 'child', active: 0 }, { message_id: 'report', conversation_id: 'child', active: 1 }];
  expect(readCurrentWork(state, 'child', 'en')).toBe('Editing roles.ts');
  expect(readCurrentWork(state, 'child', 'ja')).toBe('roles.tsを編集中');
  expect(readReport(state, 'child')).toBe('Finished the review.');
});
it('keeps successive attempts in one row with independent time segments ending at now', () => {
  const state = createProjectionFixture().getSnapshot();
  state.projection.runs = [{ id: 'one', started_ts: '2026-10-08T10:00:00Z', ended_ts: '2026-10-08T10:30:00Z', state: 'ended' }, { id: 'two', started_ts: '2026-10-08T11:00:00Z', state: 'running' }];
  const { result } = renderHook(() => useRootIndex(state));
  const node = buildRootTree(selectRoots(state, 'repo')[0], result.current).nodes[0];
  node.attempts = [{ run_id: 'one' }, { run_id: 'two' }];
  const segments = readSegments(node, NOW, state);
  expect(segments).toHaveLength(2); expect(segments[1].end).toBe(NOW);
});
it('uses known review targets as parents and marks reviews without targets as inferred', () => {
  const target = createProjectionFixture(); const state = target.getSnapshot();
  state.projection.relations!.push({ id: 'review', type: 'review_of', from_id: 'recent-a', to_id: 'recent-b', active: 1 });
  render(<MemoryRouter><GraphPage embedded project="repo" target={target} client={{ command: vi.fn() }}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Code review 1' }));
  const row = document.querySelector('[data-node-id="recent-a"]')!;
  expect(row.querySelector('[data-role="review"]')).toBeTruthy();
  expect(document.querySelector('[data-child="recent-a"][data-parent="recent-b"]')).toBeTruthy();
});

it.each([true, false])('opens task details on a single click (embedded=%s)', embedded => {
  render(<MemoryRouter><GraphPage project="repo" target={createProjectionFixture()} client={{ command: vi.fn() }} embedded={embedded}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('treeitem', { name: /^Earlier 4/ }));
  const row = screen.getByRole('treeitem', { name: /Finished task A/ });
  expect(row.tagName).toBe('BUTTON');
  fireEvent.click(row);
  const detail = screen.getByRole('complementary', { name: 'Request' });
  expect(detail.textContent).toContain('Finished task A');
  expect(detail.querySelector('a')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(screen.queryByRole('complementary', { name: 'Request' })).toBeNull();
});

it.each([
  { change: 'child', url: '/p/repo?root=root&child=recent-b', selected: 'recent-b' },
  { change: 'main conversation', url: '/p/repo?root=root', selected: 'root' },
  { change: 'root query', url: '/p/repo?root=other-root', selected: 'other-root' },
  { change: 'root prop', url: '/p/repo?root=root&child=old-a', selected: 'other-root' },
])('resets embedded task details when switching the $change without remounting', ({ change, url, selected }) => {
  const target = createProjectionFixture();
  target.getSnapshot().projection.roots!.push({ id: 'other-root', name: 'repo-002', project: 'repo', state: 'idle', conversation_ids: ['other-main'] });
  target.getSnapshot().projection.conversations!.push({ id: 'other-main', provider: 'claude' });
  const client = { command: vi.fn() };
  const view = (rootId?: string) => <MemoryRouter initialEntries={['/p/repo?root=root&child=old-a']}>
    <Link to={url}>Switch conversation</Link>
    <GraphPage embedded project="repo" rootId={rootId} target={target} client={client}/>
  </MemoryRouter>;
  const { container, rerender } = render(view(change === 'root prop' ? 'root' : undefined));
  const graph = container.querySelector('.graph-page');
  fireEvent.click(screen.getByRole('treeitem', { name: /^Earlier 4/ }));
  const task = screen.getByRole('treeitem', { name: /Finished task A/ });
  fireEvent.click(task);
  expect(task.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('complementary', { name: 'Request' }).textContent).toContain('Finished task A');

  if (change === 'root prop') rerender(view('other-root'));
  else fireEvent.click(screen.getByRole('link', { name: 'Switch conversation' }));

  expect(container.querySelector('.graph-page')).toBe(graph);
  expect(screen.queryByRole('complementary', { name: 'Request' })).toBeNull();
  const selectedRows = screen.getAllByRole('treeitem', { selected: true });
  expect(selectedRows).toHaveLength(1);
  expect(selectedRows[0].closest('[data-node-id]')?.getAttribute('data-node-id')).toBe(selected);
  expect(selectedRows[0].getAttribute('aria-current')).toBe('page');
});

it('renders planner batches as task graphs without inventing an advisor, model or execution state', () => {
  const target = createProjectionFixture();
  render(<MemoryRouter><GraphPage embedded project="repo" target={target} client={{ command: vi.fn() }}/></MemoryRouter>);
  const batch = screen.getByRole('treeitem', { name: 'Task graph · Task graph' });
  expect(batch.querySelector('.graph-row-who')?.textContent).toBe('Task graph');
  expect(batch.querySelector('.graph-row-end')?.textContent).toBe('');
  expect(batch.getAttribute('aria-label')).not.toContain(' ·  · ');
  expect(screen.queryByRole('button', { name: /^Advisor/ })).toBeNull();
  const unknown = screen.getByRole('treeitem', { name: /unresolved|Codex.*Unknown/ });
  expect(unknown.getAttribute('aria-label')).not.toContain(' ·  · ');
});

it('uses a known child run model and falls through an empty run model to relation evidence', () => {
  const target = createProjectionFixture();
  const state = target.getSnapshot();
  state.projection.runs!.find(run => run.conversation_id === 'recent-a')!.model = '';
  state.projection.relations!.find(row => row.to_id === 'recent-a')!.evidence = { agentType: 'general-purpose', description: 'recent-a', model: 'claude-fable-5-1' };
  const catalogs = { claude: { state: 'known', models: [{ model: 'claude-fable-5-1', displayName: 'Fable 5.1' }] } };
  render(<MemoryRouter><GraphPage embedded project="repo" target={target} client={{ command: vi.fn() }} catalogs={catalogs}/></MemoryRouter>);
  expect(screen.getByRole('treeitem', { name: /^recent-a/ }).querySelector('.graph-row-who')?.textContent).toBe('Implementation · Claude Fable 5.1');
  expect(screen.getByRole('treeitem', { name: /^recent-b/ }).querySelector('.graph-row-who')?.textContent).toBe('Implementation · Claude Opus 5.5');
});

it('uses the same catalog spelling in the graph row and right detail panel', () => {
  const target = createProjectionFixture();
  const state = target.getSnapshot();
  state.projection.conversations!.find(row => row.id === 'recent-a')!.provider = 'codex';
  const run = state.projection.runs!.find(run => run.conversation_id === 'recent-a')!;
  run.model = 'gpt-6.1-sol';
  run.launch = { model: { model: 'gpt-6-astra' } };
  const catalogs = { codex: { state: 'known', models: [{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }] } };
  render(<MemoryRouter><GraphPage project="repo" target={target} client={{ command: vi.fn() }} catalogs={catalogs}/></MemoryRouter>);
  const row = screen.getByRole('treeitem', { name: /^recent-a/ });
  expect(row.querySelector('.graph-row-who')?.textContent).toBe('Implementation · Codex GPT-6.1-Sol');
  fireEvent.click(row);
  expect(screen.getByRole('complementary', { name: 'Request' }).querySelector('.graph-detail-provider')?.textContent).toBe('GPT-6.1-Sol');
});

it.each([
  { node_id: 'codex-41' }, { node_id: 'codex-001' }, { node_id: 'T1', origin: 'single' },
])('places single requests directly under the root: %j', kit => {
  const state = createProjectionFixture().getSnapshot();
  state.projection.delegations = [{ id: 'single', root_id: 'root', kit: { ...kit, session: 'repo-027' },
    title: '単発の依頼の説明', state: 'running' }];
  const { result } = renderHook(() => useRootIndex(state));
  const tree = buildRootTree(selectRoots(state)[0], result.current);
  expect(tree.nodes.some(node => node.role === 'planner')).toBe(false);
  expect(tree.nodes[0].children).toContain('delegation:single');
  expect(tree.edges.find(edge => edge.target === 'delegation:single')).toMatchObject({ source: 'root', title: '単発の依頼の説明' });
});

it('renders a legacy single request from serialized kit evidence directly under the root', () => {
  const target = createProjectionFixture();
  target.getSnapshot().projection.delegations = [{ id: 'legacy-single', root_id: 'root',
    kit: JSON.stringify({ session: 'repo-027', node_id: 'codex-41' }),
    title: 'Legacy single request', state: 'running' }];
  render(<MemoryRouter><GraphPage embedded project="repo" target={target} client={{ command: vi.fn() }}/></MemoryRouter>);
  const row = screen.getByRole('treeitem', { name: /^Legacy single request/ });
  expect(row.closest('[data-node-id]')?.getAttribute('data-node-id')).toBe('delegation:legacy-single');
  expect(document.querySelector('[data-child="delegation:legacy-single"][data-parent="root"]')).toBeTruthy();
  expect(screen.queryByRole('treeitem', { name: /Task graph/ })).toBeNull();
});

it.each([{ node_id: 'D1' }, { node_id: 'codex-41', origin: 'graph' }])('names graph batches from the goal and collapses finished children immediately: %j', kit => {
  const target = createProjectionFixture();
  target.getSnapshot().projection.delegations = ['done', 'failed', 'interrupted', 'denied'].map((state, index) => ({
    id: 'graph-task-' + index, root_id: 'root', kit: { ...kit, session: 'repo-027', goal: '画面の改善\n詳細な目標' },
    title: 'Task ' + index, state, completed_ts: new Date(NOW).toISOString(),
  }));
  render(<MemoryRouter><GraphPage embedded project="repo" target={target} client={{ command: vi.fn() }}/></MemoryRouter>);
  const group = screen.getByRole('treeitem', { name: '画面の改善 · Task graph' });
  expect(group.querySelector('.graph-row-title')?.getAttribute('title')).toBe('repo-027');
  expect(screen.queryByRole('treeitem', { name: /^Task 0/ })).toBeNull();
  const earlier = document.querySelector('[data-node-id="earlier:graph:repo-027"] button')!;
  expect(earlier.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(earlier);
  expect(screen.getByRole('treeitem', { name: /^Task 0/ })).toBeTruthy();
});

it.each(['running', 'waiting_approval', 'waiting_input', 'received', 'unknown'])('keeps graph batches open while a child is %s', status => {
  const state = createProjectionFixture().getSnapshot();
  state.projection.delegations![0].state = status;
  const { result } = renderHook(() => useRootIndex(state));
  const tree = buildRootTree(selectRoots(state)[0], result.current);
  const graph = tree.nodes.find(node => node.role === 'planner')!;
  expect(isCompletedGraph(graph, new Map(tree.nodes.map(node => [node.id, node])))).toBe(false);
  expect(buildRows(tree, { now: NOW }).rows.some(row => row.id === 'delegation:kit-a')).toBe(true);
});

it('collapses completed graphs in the root request view and allows opening them', () => {
  const state = createProjectionFixture().getSnapshot();
  state.projection.relations = [];
  state.projection.delegations!.forEach(row => { row.kit = { session: 'repo-027', goal: '完了した目標' }; row.completed_ts = new Date(NOW).toISOString(); });
  const { result } = renderHook(() => useRootIndex(state));
  const tree = buildRootTree(selectRoots(state)[0], result.current);
  render(<RootTree tree={tree} onSelect={vi.fn()}/>);
  expect(screen.queryByRole('heading', { name: /完了した目標/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Earlier/ }));
  expect(screen.getByRole('heading', { name: /完了した目標/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Finished task A/ })).toBeTruthy();
});
