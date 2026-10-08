import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore } from '../lib/store.ts';
import { buildRootTree, selectRoots, useRootIndex } from '../lib/roots.ts';
import { GraphPage } from '../pages/graph/GraphPage.tsx';
import { calculateLayout, foldEarlier, prepareGraphTree } from '../pages/graph/layout.ts';

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

function renderProjection(entry = '/p/repo/graph?root=root') {
  const target = createProjectionFixture();
  render(<MemoryRouter initialEntries={[entry]}><GraphPage project="repo" target={target} language="ja"
    client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'test', ok: true })) }}/></MemoryRouter>);
  return target;
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); vi.stubGlobal('innerWidth', 1200); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('passes multiple conversations, idle children and undated planner tasks through the screen selectors', () => {
  const state = createProjectionFixture().getSnapshot();
  const root = selectRoots(state, 'repo')[0];
  const { result } = renderHook(() => useRootIndex(state));
  const built = buildRootTree(root, result.current);
  expect(root.name).toBe('Repo-20260925');
  expect(built.nodes).toHaveLength(16);
  expect(built.nodes.find(node => node.id === 'old-a')!.state).toBe('ended');
  expect(built.nodes.find(node => node.id === 'graph:batch')!.conversationId).toBeUndefined();
  expect(built.edges.find(edge => edge.target === 'recent-f')!.source).toBe('root');
  const visible = foldEarlier(built, new Set(), NOW);
  expect(visible.nodes).toHaveLength(11);
  expect(visible.edges).toHaveLength(10);
  expect(visible.nodes.find(node => node.id === 'completed:graph:batch')!.earlier!.count).toBe(3);
  for (const edge of visible.edges) {
    expect(visible.nodes.some(node => node.id === edge.source)).toBe(true);
    expect(visible.nodes.some(node => node.id === edge.target)).toBe(true);
  }
});

it('draws eleven nodes and ten edges with one edge per folded group and aligned child tops', () => {
  renderProjection();
  const cards = [...document.querySelectorAll<HTMLElement>('.graph-card')];
  expect(cards).toHaveLength(11);
  expect(document.querySelectorAll('.graph-edge')).toHaveLength(10);
  expect(screen.getByRole('button', { name: 'ほかの完了 2 件' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.getByRole('button', { name: 'ほかの完了 3 件' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('link', { name: /old-a/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Failed task' })).toBeNull();
  expect(screen.getByRole('button', { name: '以前の依頼 1 件' })).toBeTruthy();
  const root = cards.find(card => card.dataset.nodeId === 'root')!;
  const firstColumn = cards.filter(card => card.style.left === '320px');
  expect(Math.min(...firstColumn.map(card => parseFloat(card.style.top)))).toBe(parseFloat(root.style.top));
  expect(firstColumn[0].style.width).toBe('240px');
  expect(firstColumn[0].style.height).toBe('76px');
  const group = cards.find(card => card.dataset.nodeId === 'completed:graph:batch')!;
  const endpoint = ' ' + group.style.left.replace('px', '') + ' ' + (parseFloat(group.style.top) + parseFloat(group.style.height) / 2);
  expect([...document.querySelectorAll('.graph-edge > path')].filter(path => path.getAttribute('d')!.endsWith(endpoint))).toHaveLength(1);
});

it('expands only the requested group and can reveal a child from an earlier conversation', () => {
  renderProjection();
  fireEvent.click(screen.getByRole('button', { name: 'ほかの完了 3 件' }));
  expect(document.querySelectorAll('.graph-card')).toHaveLength(14);
  expect(document.querySelectorAll('.graph-edge')).toHaveLength(13);
  expect(screen.getByRole('button', { name: '以前の依頼 3 件' }).getAttribute('aria-expanded')).toBe('false');
  cleanup(); renderProjection('/p/repo/graph?root=root&child=old-a');
  expect(screen.getByRole('link', { name: /old-a/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ほかの完了 3 件' }).getAttribute('aria-expanded')).toBe('false');
});

it('reserves a second title line only for long titles and uses measured title height', () => {
  const state = createProjectionFixture().getSnapshot();
  const { result } = renderHook(() => useRootIndex(state));
  const tree = buildRootTree(selectRoots(state, 'repo')[0], result.current);
  tree.nodes[0].label = 'Short title';
  tree.nodes[1].label = '長い題が二行になったときだけカードの高さを伸ばして表示する';
  const layout = calculateLayout(tree, 1200);
  expect(layout.nodes.find(node => node.id === 'root')!.height).toBe(76);
  expect(layout.nodes.find(node => node.id === 'old-a')!.height).toBe(96);
  const measured = calculateLayout(tree, 1200, undefined, new Map([[tree.nodes[1].label, 20]]));
  expect(measured.nodes.find(node => node.id === 'old-a')!.height).toBe(76);
});

// キットのまとまりと、参照先の実行も時刻もない試行を実データの形から写す。
function createBatchFixture(states = ['done', 'done', 'failed'], providers = ['codex', 'codex', 'codex']) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Repo', project: 'repo', state: 'running', conversation_ids: ['root'], running_children: 0, total_children: 3 }],
    conversations: [{ id: 'root', provider: 'claude' }],
    delegations: states.map((state, index) => ({ id: `request-${index}`, root_id: 'root', role: 'implement', state,
      provider: providers[index], title: `Request ${index}`, kit: { session: 'agent-graph-001', node_id: `codex-${index}` },
      attempts: JSON.stringify([{ attempt: 1, state, run_id: `missing-${index}`, assignment: { model: null, effort: null, executor: null, provider: null } }]) })),
    runs: [], relations: [], approvals: [],
  } });
  return target;
}

it.each(['en', 'ja'] as const)('shows the batch name, count and Codex mark in %s without changing the shared tree', language => {
  const target = createBatchFixture();
  const state = target.getSnapshot();
  const { result } = renderHook(() => useRootIndex(state));
  const built = buildRootTree(selectRoots(state, 'repo')[0], result.current);
  const original = structuredClone(built);
  const prepared = prepareGraphTree(built, NOW, language);
  expect(prepared.nodes.find(node => node.role === 'planner')).toMatchObject({ batchCount: 3, provider: 'codex', state: 'ended' });
  expect(built).toEqual(original);
  render(<MemoryRouter><GraphPage project="repo" target={target} language={language} client={{ command: vi.fn() }}/></MemoryRouter>);
  const batch = screen.getByRole('button', { name: language === 'ja' ? 'まとめて出した依頼' : 'Batched requests' });
  expect(batch.querySelector('.graph-card-model')!.textContent).toBe(language === 'ja' ? '3 件' : '3 requests');
  expect(batch.querySelector('.provider-codex')).toBeTruthy();
  expect(batch.querySelector('[data-state="ended"]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Request 2' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '以前の依頼 1 件' : '1 earlier request' }));
  expect(screen.getByRole('button', { name: 'Request 2' })).toBeTruthy();
});

it.each(['running', 'waiting_approval', 'waiting_input', 'failed', 'done'])('derives batch state %s and latest child time', state => {
  const target = createBatchFixture(['done', 'failed', state]);
  const snapshot = target.getSnapshot();
  snapshot.projection.delegations![1].updated_ts = '2026-10-06T10:00:00Z';
  snapshot.projection.delegations![2].updated_ts = '2026-10-08T11:00:00Z';
  const { result } = renderHook(() => useRootIndex(snapshot));
  const built = buildRootTree(selectRoots(snapshot, 'repo')[0], result.current);
  const batch = prepareGraphTree(built, NOW).nodes.find(node => node.role === 'planner')!;
  expect(batch.state).toBe(state === 'done' ? 'ended' : state);
  expect(batch.activity).toBe('2026-10-08T11:00:00Z');
});

it('uses a neutral group mark for mixed providers and prioritizes active children over recent failures', () => {
  const target = createBatchFixture(['failed', 'waiting_input', 'running'], ['codex', 'claude', 'codex']);
  target.getSnapshot().projection.delegations![0].updated_ts = '2026-10-08T11:00:00Z';
  render(<MemoryRouter><GraphPage project="repo" target={target} language="ja" client={{ command: vi.fn() }}/></MemoryRouter>);
  const batch = screen.getByRole('button', { name: 'まとめて出した依頼' });
  expect(batch.querySelector('.provider-unknown')!.getAttribute('title')).toBe('まとめて出した依頼');
  expect(batch.querySelector('[data-state="running"]')).toBeTruthy();
});

it('derives batch approval status from pending approvals and uses the latest attempt time', () => {
  const target = createBatchFixture(['done', 'done', 'done']);
  const snapshot = target.getSnapshot();
  Object.assign(snapshot.projection.delegations![0], { conversation_id: 'child', created_ts: '2026-10-06T10:00:00Z',
    updated_ts: '2026-10-07T10:00:00Z', attempts: '[{"attempt":1,"state":"done","run_id":null,"ended_ts":"2026-10-08T11:00:00Z"}]' });
  snapshot.projection.conversations!.push({ id: 'child', provider: 'codex' });
  snapshot.projection.approvals!.push({ id: 'approval', conversation_id: 'child', state: 'requested' });
  render(<MemoryRouter><GraphPage project="repo" target={target} language="ja" client={{ command: vi.fn() }}/></MemoryRouter>);
  const batch = screen.getByRole('button', { name: 'まとめて出した依頼' });
  expect(batch.querySelector('[data-state="waiting_approval"]')).toBeTruthy();
  expect(batch.querySelector('time')!.dateTime).toBe('2026-10-08T11:00:00Z');
});

it.each([
  { updated_ts: '2026-10-06T10:00:00Z' },
  { created_ts: '2026-10-06T10:00:00Z' },
  { attempts: '[{"attempt":1,"state":"failed","run_id":null,"updated_ts":"2026-10-06T10:00:00Z"}]' },
  { attempts: '[{"attempt":1,"state":"failed","run_id":null,"created_ts":"2026-10-06T10:00:00Z"}]' },
])('folds dated failures and displays their recorded time on expansion: %j', record => {
  const target = createBatchFixture(['running', 'done', 'failed']);
  Object.assign(target.getSnapshot().projection.delegations![2], record);
  render(<MemoryRouter><GraphPage project="repo" target={target} language="ja" client={{ command: vi.fn() }}/></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Request 2' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '以前の依頼 1 件' }));
  const failure = screen.getByRole('button', { name: 'Request 2' });
  expect(failure.querySelector('time')!.dateTime).toBe('2026-10-06T10:00:00Z');
  expect(failure.querySelector('[data-state="failed"]')).toBeTruthy();
});
