import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { GraphPage } from '../pages/graph/GraphPage.tsx';
import { calculateLayout, curvePath, foldEarlier, type GraphNode, type GraphTree } from '../pages/graph/layout.ts';
import { createStore } from '../lib/store.ts';
import { App } from '../App.tsx';

const now = Date.parse('2026-10-08T12:00:00Z');
function node(id: string, state = 'idle', children: string[] = [], activity = '2026-10-08T11:00:00Z'): GraphNode {
  return { id, kind: 'conversation', label: id, conversationId: id, provider: 'codex', model: 'gpt-6.1-sol', role: 'task', state, children, attempts: [], activity, run: { id: `run-${id}`, ended_ts: activity } };
}
function tree(nodes: GraphNode[]): GraphTree {
  return { nodes, roots: ['root'], unresolved: [], edges: nodes.flatMap(parent => parent.children.map(child => ({ id: `${parent.id}:${child}`, source: parent.id, target: child, title: child, confidence: 'confirmed', kind: 'delegated' as const }))) };
}
function fixture() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Ship the console', project: 'repo', state: 'running', last_activity_ts: '2026-10-08T11:00:00Z', conversation_ids: ['root'], running_children: 1, total_children: 4 }],
    conversations: ['root', 'child', 'approval', 'old', 'nested'].map(id => ({ id, provider: id === 'root' ? 'claude' : 'codex', type: id === 'root' ? 'interactive' : 'subagent' })),
    runs: [
      { id: 'run-root', conversation_id: 'root', state: 'running', model: 'claude-opus-4-6', last_evidence_ts: '2026-10-08T11:00:00Z' },
      { id: 'run-child', conversation_id: 'child', state: 'running', model: 'gpt-6.1-sol', last_evidence_ts: '2026-10-08T11:00:00Z' },
      { id: 'run-approval', conversation_id: 'approval', state: 'waiting_approval', last_evidence_ts: '2026-10-08T11:00:00Z' },
      { id: 'run-old', conversation_id: 'old', state: 'ended', ended_ts: '2026-10-06T11:00:00Z' },
      { id: 'run-nested', conversation_id: 'nested', state: 'ended', ended_ts: '2026-10-06T11:00:00Z' },
    ],
    relations: [
      ...['child', 'approval', 'old'].map(id => ({ id: `relation-${id}`, type: 'delegated', from_id: 'root', to_id: id, evidence: { description: id === 'child' ? 'Build the screen' : id === 'approval' ? 'Verify the build' : 'Earlier implementation' } })),
      { id: 'nested', type: 'delegated', from_id: 'old', to_id: 'nested', evidence: { description: 'Earlier review' } },
    ],
    approvals: [{ id: 'a', run_id: 'run-approval', state: 'requested', request: { command: 'pnpm build' }, available_decisions: ['allow', 'deny'] }],
  } });
  target.setConnection('connected');
  return target;
}
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function renderGraph(language: 'en' | 'ja' = 'en', client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })) }, target = fixture(), entry = '/p/repo/graph?root=root') {
  render(<MemoryRouter initialEntries={[entry]}><Routes><Route path="/p/:project/graph" element={<GraphPage target={target} client={client} language={language}/>}/><Route path="/p/:project" element={<p>Conversation destination</p>}/></Routes><Location/></MemoryRouter>);
  return { client, target };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('lays out layers from left to right, orders running then approval then newest, and has no overlaps', () => {
  const input = tree([node('root', 'running', ['done', 'approval', 'active', 'new']), node('done', 'ended', [], '2026-10-08T10:00:00Z'), node('new', 'ended'), node('approval', 'waiting_approval'), node('active', 'running', ['grandchild']), node('grandchild')]);
  const layout = calculateLayout(input, 1000);
  const at = (id: string) => layout.nodes.find(row => row.id === id)!;
  expect(at('root').x).toBe(0); expect(at('active').x).toBeGreaterThan(at('root').x); expect(at('grandchild').x).toBeGreaterThan(at('active').x);
  expect([at('active').y, at('approval').y, at('new').y, at('done').y]).toEqual([0, 92, 184, 276]);
  expect(at('root').width).toBe(240); expect(at('active').width).toBe(240);
  expect(at('root').height).toBe(76);
  expect(curvePath(at('root'), at('active'), false)).toContain(' C ');
  expect(input.nodes[0].children).toEqual(['done', 'approval', 'active', 'new']);
});
it('adds a child without moving existing cards, even after a state change', () => {
  const input = tree([node('root', 'running', ['one', 'two']), node('one', 'running'), node('two', 'ended')]);
  const first = calculateLayout(input, 1000);
  const update = tree([node('root', 'running', ['one', 'two', 'three']), node('one', 'ended'), node('two', 'running'), node('three', 'running')]);
  const second = calculateLayout(update, 1000, first);
  expect(second.nodes.filter(row => row.id !== 'three')).toEqual(first.nodes);
  expect(second.nodes.find(row => row.id === 'three')!.y).toBeGreaterThan(second.nodes.find(row => row.id === 'two')!.y);
});
it('switches to an indented preorder tree below 720px and reserves space for approvals', () => {
  const input = tree([node('root', 'running', ['a', 'b']), { ...node('a', 'waiting_approval', ['c']), approvalCount: 2 }, node('b'), node('c')]);
  const wide = calculateLayout(input, 720); const narrow = calculateLayout(input, 719, wide);
  expect(wide.vertical).toBe(false); expect(narrow.vertical).toBe(true);
  const at = (id: string) => narrow.nodes.find(row => row.id === id)!;
  expect(at('a').y).toBeGreaterThan(at('root').y); expect(at('c').y).toBeGreaterThan(at('a').y + at('a').height);
  expect(at('b').x).toBe(at('a').x);
  expect(at('c').x).toBeGreaterThan(at('a').x);
  expect(at('b').y).toBeGreaterThan(at('c').y + at('c').height);
  expect(narrow.width).toBeLessThanOrEqual(719);
});
it('folds only terminal branches older than 24 hours per parent, preserves active descendants and expands', () => {
  const old = '2026-10-06T11:00:00Z';
  const input = tree([node('root', 'running', ['old', 'parent', 'unknown', 'boundary']), node('old', 'ended', ['older'], old), node('older', 'idle', [], old), node('parent', 'ended', ['active'], old), node('active', 'running', ['past']), node('past', 'ended', [], old), node('unknown', 'unknown', [], old), node('boundary', 'ended', [], '2026-10-07T12:00:00Z')]);
  const folded = foldEarlier(input, new Set(), now);
  expect(folded.nodes.map(row => row.id)).toEqual(['root', 'parent', 'active', 'earlier:active', 'unknown', 'boundary', 'earlier:root']);
  expect(folded.nodes.find(row => row.id === 'earlier:root')?.earlier?.count).toBe(1);
  const expanded = foldEarlier(input, new Set(['earlier:root', 'earlier:old']), now);
  expect(expanded.nodes.some(row => row.id === 'older')).toBe(true);
  expect(expanded.nodes.find(row => row.id === 'earlier:root')?.earlier?.expanded).toBe(true);
  const selected = foldEarlier(input, new Set(), now, 'older');
  expect(selected.nodes.some(row => row.id === 'older')).toBe(true);
});
it('shows ordered tabs, preserves the root, and opens a child conversation URL', () => {
  renderGraph();
  const tabs = screen.getByRole('navigation', { name: 'Project' });
  expect(within(tabs).getAllByRole('link').map(link => link.textContent)).toEqual(['Conversations', 'Graph', 'Changes']);
  expect(within(tabs).getByRole('link', { name: 'Graph' }).getAttribute('href')).toBe('/p/repo/graph?root=root');
  expect(within(tabs).getByRole('link', { name: 'Graph' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('link', { name: /Build the screen/ }));
  expect(screen.getByTestId('location').textContent).toBe('/p/repo?root=root&child=child');
});
it('opens the root without a child parameter', () => {
  renderGraph(); fireEvent.click(screen.getByRole('link', { name: /Ship the console ·/ }));
  expect(screen.getByTestId('location').textContent).toBe('/p/repo?root=root');
});
it('expands earlier requests and shows Japanese labels', () => {
  renderGraph('ja');
  expect(screen.getByRole('link', { name: 'グラフ' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Earlier implementation/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '以前の依頼 1 件' }));
  expect(screen.getByRole('link', { name: /Earlier implementation/ })).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: '以前の依頼 1 件' }).find(button => button.getAttribute('aria-expanded') === 'false')!);
  expect(screen.getByRole('link', { name: /Earlier review/ })).toBeTruthy();
});
it('allows approval once, shows its summary, and keeps the graph open', async () => {
  const { client } = renderGraph();
  expect(screen.getByText('Command: pnpm build')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow' })); });
  expect(client.command).toHaveBeenCalledExactlyOnceWith('answer', { approvalId: 'a', decision: 'allow' });
  expect(screen.getByText('Answer sent').getAttribute('role')).toBe('status');
  expect(screen.getByTestId('location').textContent).toBe('/p/repo/graph?root=root');
});
it('disables approval offline and recovers from an unsuccessful answer', async () => {
  const target = fixture(); target.setConnection('runner_unavailable');
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: false, error: 'Try again' })) };
  renderGraph('en', client, target);
  expect(screen.getByRole('button', { name: 'Allow' }).hasAttribute('disabled')).toBe(true);
  act(() => target.setConnection('connected'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow' })));
  expect(screen.getByRole('alert').textContent).toBe('Try again');
  expect(screen.getByRole('button', { name: 'Allow' }).hasAttribute('disabled')).toBe(false);
});
it('hides zoom on a narrow tree and supports keyboard node navigation', () => {
  renderGraph();
  const canvas = screen.getByRole('region', { name: 'Request graph' });
  expect(canvas.getAttribute('data-direction')).toBe('horizontal');
  const scale = document.querySelector('.graph-scale')!.textContent;
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(document.querySelector('.graph-scale')!.textContent).not.toBe(scale);
  vi.stubGlobal('innerWidth', 390); fireEvent(window, new Event('resize'));
  expect(canvas.getAttribute('data-direction')).toBe('vertical');
  expect(canvas.classList.contains('graph-tree')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
  expect(document.querySelector('.graph-world')!.getAttribute('style')).toBe('');
  expect(document.querySelector('.graph-edges')).toBeNull();
  const root = screen.getByRole('link', { name: /Ship the console ·/ });
  fireEvent.keyDown(root, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('link', { name: /Build the screen/ }));
});
it('redirects the old tree route to Graph while preserving root selection', () => {
  render(<MemoryRouter initialEntries={['/p/repo/tree?root=root']}><App target={fixture()}/><Location/></MemoryRouter>);
  expect(screen.getByTestId('location').textContent).toBe('/p/repo/graph?root=root');
  expect(screen.getByRole('region', { name: 'Request graph' })).toBeTruthy();
});
it('activates a focused child with Enter', async () => {
  const user = userEvent.setup();
  renderGraph();
  act(() => screen.getByRole('link', { name: /Ship the console ·/ }).focus());
  await user.keyboard('{ArrowRight}{Enter}');
  expect(screen.getByTestId('location').textContent).toBe('/p/repo?root=root&child=child');
});
it('zooms around the pointer, pans the background, and ignores a card drag', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  renderGraph();
  const canvas = screen.getByRole('region', { name: 'Request graph' });
  const capture = vi.fn(); Object.assign(canvas, { setPointerCapture: capture });
  const world = document.querySelector<HTMLElement>('.graph-world')!;
  const before = world.style.transform;
  fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
  expect(world.style.transform).not.toBe(before);
  const afterZoom = world.style.transform;
  fireEvent.pointerDown(canvas, { button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(canvas, { clientX: 120, clientY: 80 });
  fireEvent.pointerUp(canvas);
  expect(capture).toHaveBeenCalledOnce();
  expect(world.style.transform).not.toBe(afterZoom);
  const afterPan = world.style.transform;
  fireEvent.pointerDown(screen.getByRole('link', { name: /Build the screen/ }), { button: 0, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(canvas, { clientX: 220, clientY: 80 });
  expect(world.style.transform).toBe(afterPan);
});
it('preserves card positions and the selected card in view when live children arrive', () => {
  const { target } = renderGraph();
  act(() => screen.getByRole('link', { name: /Verify the build/ }).focus());
  const card = document.querySelector<HTMLElement>('[data-node-id="approval"]')!;
  const previous = { left: card.style.left, top: card.style.top };
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 1, changes: {
    conversations: { remove: [], upsert: [{ id: 'new-child', provider: 'claude' }] },
    runs: { remove: [], upsert: [{ id: 'new-run', conversation_id: 'new-child', state: 'running' }] },
    relations: { remove: [], upsert: [{ id: 'new-relation', type: 'delegated', from_id: 'root', to_id: 'new-child', evidence: { description: 'New task' } }] },
  } }));
  expect({ left: card.style.left, top: card.style.top }).toEqual(previous);
  expect(card.classList.contains('graph-selected')).toBe(true);
  expect(screen.getByRole('link', { name: /New task/ })).toBeTruthy();
  const world = document.querySelector<HTMLElement>('.graph-world')!;
  const [, x, y, scale] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(world.style.transform)!;
  expect(Number(x) + parseFloat(card.style.left) * Number(scale)).toBeGreaterThanOrEqual(0);
  expect(Number(y) + (parseFloat(card.style.top) + parseFloat(card.style.height)) * Number(scale)).toBeLessThanOrEqual(640);
});
it('uses the first root by default and respects an explicit root parameter', () => {
  const target = fixture();
  target.mergeProjection({ roots: [{ id: 'second', name: 'Second root', project: 'repo', state: 'idle', conversation_ids: ['second'], running_children: 0, total_children: 0 }], conversations: [{ id: 'second', provider: 'codex' }] }, 1);
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })) };
  const first = render(<MemoryRouter initialEntries={['/p/repo/graph']}><GraphPage project="repo" target={target} client={client}/></MemoryRouter>);
  expect(screen.getByRole('link', { name: /Ship the console ·/ })).toBeTruthy();
  first.unmount();
  render(<MemoryRouter initialEntries={['/p/repo/graph?root=second']}><GraphPage project="repo" target={target} client={client}/></MemoryRouter>);
  expect(screen.getByRole('link', { name: /Second root ·/ })).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Build the screen/ })).toBeNull();
});

function createWideFixture() {
  const target = createStore();
  const children = Array.from({ length: 42 }, (_, index) => 'task-' + index);
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: '42 requests', project: 'repo', state: 'idle', conversation_ids: ['root'], running_children: 1, total_children: 42 }],
    conversations: ['root', ...children].map(id => ({ id, provider: 'codex', type: id === 'root' ? 'interactive' : 'subagent' })),
    runs: children.map((id, index) => ({ id: 'run-' + id, conversation_id: id, state: index === 0 ? 'running' : 'ended',
      ended_ts: index === 0 ? undefined : new Date(now - index * 60_000).toISOString(), last_evidence_ts: new Date(now - index * 60_000).toISOString() })),
    relations: children.map(id => ({ id: 'relation-' + id, type: 'delegated', from_id: 'root', to_id: id, evidence: { description: id } })),
  } });
  target.setConnection('connected');
  return target;
}
it('shows seven readable nodes for 42 requests, keeps the active child in view, and limits fit to 25 percent', () => {
  renderGraph('ja', undefined, createWideFixture());
  expect(document.querySelectorAll('.graph-card')).toHaveLength(7);
  expect(screen.getByRole('link', { name: /task-0 ·/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'ほかの完了 37 件' }).getAttribute('aria-expanded')).toBe('false');
  const scale = Number(document.querySelector('.graph-scale')!.textContent!.replace('%', ''));
  expect(scale).toBeGreaterThanOrEqual(75); expect(scale).toBeLessThanOrEqual(100);
  const world = document.querySelector<HTMLElement>('.graph-world')!;
  const [, x, y, zoom] = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(world.style.transform)!;
  for (const id of ['root', 'task-0']) {
    const card = document.querySelector<HTMLElement>('[data-node-id="' + id + '"]')!;
    expect(Number(x) + parseFloat(card.style.left) * Number(zoom)).toBeGreaterThanOrEqual(0);
    expect(Number(y) + (parseFloat(card.style.top) + parseFloat(card.style.height)) * Number(zoom)).toBeLessThanOrEqual(640);
  }
  fireEvent.click(screen.getByRole('button', { name: 'ほかの完了 37 件' }));
  fireEvent.click(screen.getByRole('button', { name: '全体を表示' }));
  expect(Number(document.querySelector('.graph-scale')!.textContent!.replace('%', ''))).toBeGreaterThanOrEqual(25);
});
it('opens and closes other completed requests and restores the URL after remounting', () => {
  const target = createWideFixture();
  renderGraph('ja', undefined, target);
  fireEvent.click(screen.getByRole('button', { name: 'ほかの完了 37 件' }));
  expect(document.querySelectorAll('.graph-card')).toHaveLength(44);
  expect(screen.getByRole('button', { name: 'ほかの完了 37 件' }).getAttribute('aria-expanded')).toBe('true');
  const entry = screen.getByTestId('location').textContent!;
  expect(new URLSearchParams(entry.split('?')[1]).getAll('expanded')).toContain('completed:root');
  cleanup(); renderGraph('ja', undefined, target, entry);
  expect(screen.getByRole('link', { name: /task-41 ·/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'ほかの完了 37 件' }));
  expect(document.querySelectorAll('.graph-card')).toHaveLength(7);
  expect(screen.queryByRole('link', { name: /task-41 ·/ })).toBeNull();
  expect(screen.getByTestId('location').textContent).toBe('/p/repo/graph?root=root');
});
it('uses the same filtering at 390px and lets wheel scrolling pass through', () => {
  vi.stubGlobal('innerWidth', 390);
  renderGraph('ja', undefined, createWideFixture());
  expect(document.querySelectorAll('.graph-card')).toHaveLength(7);
  expect(screen.queryByRole('button', { name: '全体を表示' })).toBeNull();
  const canvas = screen.getByRole('region', { name: '依頼のグラフ' });
  const wheel = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
  fireEvent(canvas, wheel); expect(wheel.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'ほかの完了 37 件' }));
  expect(document.querySelectorAll('.graph-card')).toHaveLength(44);
});
it('starts every column at the root top and uses an 80px gap when expanding 42 children', () => {
  const children = Array.from({ length: 42 }, (_, index) => node('task-' + index, index === 0 ? 'running' : 'ended'));
  const layout = calculateLayout(tree([node('root', 'running', children.map(child => child.id)), ...children]), 1440);
  const root = layout.nodes.find(node => node.id === 'root')!;
  const columns = new Map<number, typeof layout.nodes>();
  for (const child of layout.nodes.filter(node => node.depth === 1)) {
    columns.set(child.x, [...columns.get(child.x) ?? [], child]);
    expect(curvePath(root, child, false)).toMatch(new RegExp(' ' + child.x + ' ' + (child.y + child.height / 2) + '$'));
    for (const other of layout.nodes.filter(node => node.id !== child.id)) {
      expect(child.x + child.width <= other.x || other.x + other.width <= child.x || child.y + child.height <= other.y || other.y + other.height <= child.y).toBe(true);
    }
  }
  expect(columns.size).toBe(6);
  for (const column of columns.values()) { expect(column).toHaveLength(column === [...columns.values()].at(-1) ? 2 : 8); expect(column[0].y).toBe(root.y); }
  const xs = [...columns.keys()];
  expect(xs[0] - root.x - root.width).toBe(80);
  for (let index = 1; index < xs.length; index++) expect(xs[index] - xs[index - 1] - 240).toBe(80);
});
it('keeps recent failures, waiting children and branches with active descendants', () => {
  const old = '2026-10-06T11:00:00Z';
  const children = Array.from({ length: 12 }, (_, index) => node('done-' + index, 'ended', [], new Date(now - index * 60_000).toISOString()));
  const input = tree([node('root', 'running', [...children.map(child => child.id), 'failed', 'approval', 'input', 'parent']), ...children,
    node('failed', 'failed'), node('approval', 'waiting_approval', [], old), node('input', 'waiting_input', [], old), node('parent', 'ended', ['active'], old), node('active', 'running')]);
  const folded = foldEarlier(input, new Set(), now);
  for (const id of ['failed', 'approval', 'input', 'parent', 'active', 'done-0', 'done-3']) expect(folded.nodes.some(node => node.id === id)).toBe(true);
  expect(folded.nodes.some(node => node.id === 'done-4')).toBe(false);
  expect(folded.nodes.find(node => node.id === 'completed:root')!.earlier!.count).toBe(8);
});

it('folds failures only after 24 hours or when undated, preserving selection and active descendants', () => {
  const old = '2026-10-06T11:00:00Z';
  const input = tree([node('root', 'running', ['old', 'undated', 'boundary', 'parent', 'selected']),
    node('old', 'failed', [], old), node('undated', 'failed', [], ''), node('boundary', 'failed', [], '2026-10-07T12:00:00Z'),
    node('parent', 'failed', ['active'], old), node('active', 'running'), node('selected', 'failed', [], old)]);
  const folded = foldEarlier(input, new Set(), now, 'selected');
  expect(folded.nodes.find(node => node.id === 'earlier:root')!.earlier!.count).toBe(2);
  for (const id of ['boundary', 'parent', 'active', 'selected']) expect(folded.nodes.some(node => node.id === id)).toBe(true);
  for (const id of ['old', 'undated']) expect(folded.nodes.some(node => node.id === id)).toBe(false);
  const expanded = foldEarlier(input, new Set(['earlier:root']), now, 'selected');
  for (const id of ['old', 'undated']) expect(expanded.nodes.some(node => node.id === id)).toBe(true);
});
