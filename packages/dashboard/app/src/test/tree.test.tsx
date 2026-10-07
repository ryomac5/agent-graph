import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type Row } from '../lib/store.ts';
import { buildDelegationTree } from '../pages/tree/model.ts';
import { TreePage } from '../pages/tree/TreePage.tsx';
import { createGraphElements } from '../components/graph/DelegationGraph.tsx';

// グラフの寸法測定だけを置き換え、選択と辺の表示は実際のデータで検証する。
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges, onNodeClick }: { nodes: { id: string; selected: boolean; data: { node: { label: string } } }[];
    edges: { id: string; label: string; style: { strokeDasharray?: string } }[]; onNodeClick: (event: unknown, node: unknown) => void }) =>
    <div>{nodes.map(node => <button key={node.id} aria-pressed={node.selected} onClick={event => onNodeClick(event, node)}>{node.data.node.label}</button>)}
      {edges.map(edge => <span key={edge.id} data-dashed={!!edge.style.strokeDasharray}>{edge.label}</span>)}</div>,
  Handle: () => null, Background: () => null, Controls: () => null, Position: { Left: 'left', Right: 'right' },
}));
afterEach(cleanup);
const PROJECT = '/repo';
function fixture(extra: Record<string, Row[]> = {}) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    tasks: [{ id: 'task', project: PROJECT, name: 'Terminal task graph' }],
    conversations: [
      { id: 'origin', provider: 'claude', native_id: 'terminal', origin: 'observed', task_id: 'task', name: 'Terminal' },
      // api は core が作業の名前から投影した会話の名前を載せる。
      { id: 'codex', provider: 'codex', task_id: 'task', origin: 'managed', name: 'Terminal task graph', name_is_provisional: false },
      { id: 'claude', provider: 'claude', task_id: 'task', origin: 'managed', name: 'Terminal task graph', name_is_provisional: false },
    ],
    runs: [
      { id: 'codex:1', conversation_id: 'codex', generation: 1, state: 'failed', cause: 'Acceptance failed', cost: 0.25 },
      { id: 'claude:1', conversation_id: 'claude', generation: 1, state: 'running', launch: JSON.stringify({ model: { model: 'sonnet' } }) },
    ],
    delegations: [
      { id: 'implementation', request_id: 'implementation', title: 'Implement code', role: 'implement', state: 'failed', attempt: 1,
        origin: JSON.stringify({ provider: 'claude', native_id: 'terminal' }),
        attempts: JSON.stringify([{ attempt: 1, run_id: 'codex:1', state: 'failed', assignment: { model: 'gpt' } }]) },
      { id: 'review', request_id: 'review', title: 'Review code', role: 'review', state: 'running', attempt: 1,
        parent_run_id: 'codex:1', attempts: [{ attempt: 1, run_id: 'claude:1', state: 'running' }] },
    ],
    relations: [
      { id: 'first', type: 'delegated', active: 1, from_id: 'origin', to_id: 'codex', confidence: 'confirmed', evidence: JSON.stringify({ request_id: 'implementation', attempt: 1 }) },
      { id: 'second', type: 'delegated', active: true, from_id: 'codex', to_id: 'claude', confidence: 'confirmed', evidence: { request_id: 'review', attempt: 1, parent_run_id: 'codex:1' } },
    ], ...extra,
  } });
  target.setConnection('connected');
  return target;
}
it('roots a terminal task graph at its origin conversation and includes both provider directions', () => {
  const target = fixture();
  const tree = buildDelegationTree(target.getSnapshot(), PROJECT);
  expect(tree.roots).toEqual(['conversation:origin']);
  expect(tree.nodes.find(n => n.id === 'conversation:origin')!.children).toEqual(['run:codex:1']);
  expect(tree.nodes.find(n => n.id === 'run:codex:1')!.children).toEqual(['run:claude:1']);
  expect(tree.nodes.find(n => n.id === 'run:codex:1')).toMatchObject({ role: 'implement', model: 'gpt', state: 'failed', cost: 0.25 });
  expect(tree.unresolved).toEqual([]);
});
it('keeps inferred and missing parents in a separate branch and draws candidates dashed', () => {
  const tree = buildDelegationTree(fixture({ relations: [
    { id: 'candidate', type: 'delegated', active: 1, from_id: 'origin', to_id: 'codex', confidence: 'inferred', evidence: { request_id: 'implementation' } },
    { id: 'unknown', type: 'delegated', active: 1, to_id: 'claude', confidence: 'unknown', evidence: { request_id: 'review' } },
  ] }).getSnapshot());
  expect(tree.unresolved).toEqual(['run:claude:1', 'run:codex:1']);
  expect(tree.nodes.find(n => n.id === 'conversation:origin')!.children).toEqual([]);
  const graph = createGraphElements(tree);
  expect(graph.edges.find(e => e.id === 'relation:candidate')!.style?.strokeDasharray).toBe('6 4');
  expect(graph.edges.find(e => e.id === 'relation:candidate')!.label).toBe('Implement code · inferred');
  expect(createGraphElements(buildDelegationTree(fixture().getSnapshot())).edges.every(e => !e.style?.strokeDasharray)).toBe(true);
});
it('keeps dependency edges out of parentage and ignores inactive relations', () => {
  const state = fixture().getSnapshot();
  state.projection.relations!.push(
    { id: 'dependency', type: 'depends_on', active: true, from_id: 'codex:1', to_id: 'claude:1', confidence: 'confirmed' },
    { id: 'inactive', type: 'delegated', active: false, from_id: 'claude:1', to_id: 'codex:1', confidence: 'confirmed' },
  );
  const tree = buildDelegationTree(state);
  expect(tree.edges.filter(e => e.kind === 'dependency')).toHaveLength(1);
  expect(tree.edges.some(e => e.id === 'relation:inactive')).toBe(false);
  expect(tree.nodes.find(n => n.id === 'run:codex:1')!.children).toEqual(['run:claude:1']);
});
it('places observed provider delegations under the parent execution and respects corrected endpoints', () => {
  const state = fixture({ delegations: [], relations: [
    { id: 'native', type: 'delegated', active: true, from_id: 'codex', to_id: 'claude', confidence: 'confirmed', title: 'Native child' },
  ] }).getSnapshot();
  const tree = buildDelegationTree(state);
  // 実行が 1 つだけの作業は、実行の節を作業の節に畳む。
  expect(tree.nodes.find(n => n.id === 'run:codex:1')).toBeUndefined();
  expect(tree.nodes.find(n => n.id === 'conversation:codex')).toMatchObject({ children: ['run:claude:1'], state: 'failed' });
  expect(tree.edges.find(e => e.id === 'relation:native')).toMatchObject({ title: 'Native child', source: 'conversation:codex' });
  const corrected = fixture().getSnapshot();
  corrected.projection.relations![0]!.to_id = 'claude';
  corrected.projection.relations = corrected.projection.relations!.slice(0, 1);
  expect(buildDelegationTree(corrected).edges.find(e => e.id === 'relation:first')!.target).toBe('run:claude:1');
});
it('resolves confirmed projection parents and isolates cyclic relations without recursive rendering', () => {
  const state = fixture({ relations: [] }).getSnapshot();
  state.projection.delegations![0]!.parent = JSON.stringify({ confidence: 'confirmed', conversation_id: 'origin' });
  state.projection.delegations![1]!.parent = { confidence: 'confirmed', run_id: 'codex:1' };
  expect(buildDelegationTree(state).roots).toEqual(['conversation:origin']);
  state.projection.relations = [
    { id: 'a', type: 'delegated', from_id: 'codex:1', to_id: 'claude:1', confidence: 'confirmed' },
    { id: 'b', type: 'delegated', from_id: 'claude:1', to_id: 'codex:1', confidence: 'confirmed' },
  ];
  const tree = buildDelegationTree(state);
  expect(tree.unresolved).toContain('run:codex:1');
  expect(tree.nodes.find(n => n.id === 'run:claude:1')!.children).toEqual([]);
});
it('synchronizes selections, shows navigation and attempt history, and sends the retry command', async () => {
  const target = fixture();
  const command = vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'retry', ok: true }));
  render(<MemoryRouter><TreePage project={PROJECT} target={target} client={{ command }}/></MemoryRouter>);
  const left = screen.getByRole('region', { name: 'Delegation tree' });
  const graph = screen.getByLabelText('Delegation graph');
  fireEvent.click(within(left).getByRole('button', { name: 'Implement code' }));
  expect(within(graph).getByRole('button', { name: 'Implement code' }).getAttribute('aria-pressed')).toBe('true');
  const detail = screen.getByRole('region', { name: 'Selected node' });
  const actions = within(detail.querySelector<HTMLElement>('.delegation-actions')!);
  expect(actions.getByRole('link', { name: 'Open conversation' }).getAttribute('href')).toBe('/c/codex');
  expect(actions.getByRole('link', { name: 'Changes' }).getAttribute('href')).toBe('/p/%2Frepo/changes?run=codex%3A1');
  const history = within(detail).getByText('Attempt history').closest('details')!;
  expect(history.open).toBe(false);
  fireEvent.click(within(history).getByText('Attempt history'));
  expect(history.open).toBe(true);
  expect(within(history).getByText('Attempt 1 · failed')).toBeTruthy();
  fireEvent.click(within(detail).getByRole('button', { name: 'Retry delegation' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('intake.retry', { requestId: 'implementation' }));
  fireEvent.click(within(graph).getByRole('button', { name: 'Review code' }));
  expect(within(left).getByRole('button', { name: 'Review code' }).getAttribute('aria-pressed')).toBe('true');
});
it('groups retry executions in one delegation node and reports retry errors', async () => {
  const target = fixture();
  const state = target.getSnapshot();
  state.projection.conversations!.push({ id: 'codex-retry', provider: 'codex', task_id: 'task', origin: 'managed' });
  state.projection.runs!.push({ id: 'codex:2', conversation_id: 'codex-retry', generation: 1, state: 'failed' });
  state.projection.delegations![0]!.attempt = 2;
  state.projection.delegations![0]!.attempts = [
    { attempt: 1, run_id: 'codex:1', state: 'failed' }, { attempt: 2, run_id: 'codex:2', state: 'failed' },
  ];
  state.projection.relations!.push({ id: 'retry', type: 'delegated', active: 1, from_id: 'origin', to_id: 'codex-retry',
    confidence: 'confirmed', evidence: { request_id: 'implementation', attempt: 2 } });
  const tree = buildDelegationTree(state);
  expect(tree.roots).toEqual(['conversation:origin']);
  expect(tree.nodes.find(n => n.id === 'conversation:origin')!.children).toEqual(['run:codex:2']);
  expect(tree.nodes.find(n => n.id === 'run:codex:1')).toBeUndefined();
  expect(tree.nodes.find(n => n.id === 'run:codex:2')!.attempts.map(attempt => attempt.run_id)).toEqual(['codex:1', 'codex:2']);
  const command = vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'retry', ok: false, error: 'Runner unavailable' }));
  render(<MemoryRouter><TreePage project={PROJECT} target={target} client={{ command }}/></MemoryRouter>);
  fireEvent.click(within(screen.getByRole('region', { name: 'Delegation tree' })).getByRole('button', { name: 'Implement code' }));
  const detail = screen.getByRole('region', { name: 'Selected node' });
  expect(within(detail).getByText('Attempt 2 · failed')).toBeTruthy();
  fireEvent.click(within(detail).getByRole('button', { name: 'Retry delegation' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Runner unavailable'));
});

it('keeps a resumed delegated conversation under its origin with two attempts and its reviewer as a child', () => {
  const target = fixture();
  const state = target.getSnapshot();
  state.projection.runs!.push({ id: 'codex:2', conversation_id: 'codex', generation: 2, state: 'ended' });
  state.projection.delegations = [state.projection.delegations[0]!];
  state.projection.relations = [state.projection.relations[0]!, { id: 'review-of', type: 'review_of', active: 1,
    from_id: 'claude', to_id: 'codex', confidence: 'confirmed' }];
  const tree = buildDelegationTree(state, PROJECT);
  expect(tree.roots).toEqual(['conversation:origin']);
  expect(tree.unresolved).toEqual([]);
  expect(tree.nodes.find(node => node.id === 'conversation:origin')!.children).toEqual(['run:codex:2']);
  const implementation = tree.nodes.find(node => node.delegation?.id === 'implementation')!;
  expect(implementation).toMatchObject({ label: 'Implement code', state: 'ended', children: ['run:claude:1'] });
  expect(implementation.attempts).toMatchObject([
    { attempt: 1, run_id: 'codex:1', state: 'failed' }, { attempt: 2, run_id: 'codex:2', state: 'ended' },
  ]);
  expect(tree.nodes.filter(node => node.conversationId === 'codex')).toHaveLength(1);
  const graph = createGraphElements(tree);
  expect(graph.nodes.map(node => node.id).sort()).toEqual(['conversation:origin', 'run:claude:1', 'run:codex:2']);
  expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
    ['conversation:origin', 'run:codex:2'], ['run:codex:2', 'run:claude:1'],
  ]);
  render(<MemoryRouter><TreePage project={PROJECT} target={target}/></MemoryRouter>);
  const left = screen.getByRole('region', { name: 'Delegation tree' });
  expect(within(left).getAllByRole('button', { name: 'Implement code' })).toHaveLength(1);
  fireEvent.click(within(left).getByRole('button', { name: 'Implement code' }));
  const detail = screen.getByRole('region', { name: 'Selected node' });
  fireEvent.click(within(detail).getByText('Attempt history'));
  expect(within(detail).getByText('Attempt 1 · failed')).toBeTruthy();
  expect(within(detail).getByText('Attempt 2 · ended')).toBeTruthy();
});

it.each(['running', 'ended', 'failed', 'unknown'])('uses the resumed run state %s and resolves original run aliases independently of row order', status => {
  const state = fixture().getSnapshot();
  state.identities = { conversations: { 'managed-thread': 'codex' }, runs: { 'original-run': 'codex:1', 'resumed-run': 'codex:2' } };
  state.projection.delegations = [{ ...state.projection.delegations[0], state: 'done', attempts: JSON.stringify([
    { attempt: 1, run_id: 'original-run', state: 'done', assignment: { model: 'original-model' } },
  ]) }];
  state.projection.runs = [
    { id: 'codex:2', conversation_id: 'codex', generation: 2, state: status, launch: { model: { model: 'resumed-model' } } },
    { ...state.projection.runs[0], state: 'ended' }, state.projection.runs[1],
  ];
  state.projection.relations = [state.projection.relations[0], { id: 'review-of', type: 'review_of', active: true,
    from_id: 'claude', to_id: 'managed-thread', confidence: 'confirmed' }];
  const tree = buildDelegationTree(state, PROJECT);
  expect(tree.roots).toEqual(['conversation:origin']);
  expect(tree.nodes.filter(node => node.conversationId === 'codex')).toHaveLength(1);
  expect(tree.nodes.find(node => node.delegation?.id === 'implementation')).toMatchObject({
    state: status, model: 'resumed-model', children: ['run:claude:1'],
    attempts: [{ attempt: 1, run_id: 'codex:1', state: 'done' }, { attempt: 2, run_id: 'codex:2', state: status }],
  });
  for (const endpoint of ['original-run', 'resumed-run']) {
    state.projection.relations![1]!.to_id = endpoint;
    expect(buildDelegationTree(state, PROJECT)).toEqual(tree);
  }
});

it('combines resume generations and intake retries without repeating recorded executions', () => {
  const state = fixture().getSnapshot();
  state.projection.conversations!.push({ id: 'retry', provider: 'codex', task_id: 'task', origin: 'managed' });
  state.projection.runs!.push(
    { id: 'codex:2', conversation_id: 'codex', generation: 2, state: 'failed' },
    { id: 'retry:1', conversation_id: 'retry', generation: 1, state: 'ended' },
    { id: 'retry:2', conversation_id: 'retry', generation: 2, state: 'running' },
  );
  state.projection.delegations![0]!.attempts = [
    { attempt: 1, run_id: 'codex:1', state: 'failed' },
    { attempt: 2, run_id: 'codex:2', state: 'failed' },
    { attempt: 3, run_id: 'retry:1', state: 'done' },
  ];
  const tree = buildDelegationTree(state, PROJECT);
  expect(tree.roots).toEqual(['conversation:origin']);
  const node = tree.nodes.find(node => node.delegation?.id === 'implementation')!;
  expect(node.attempts.map(attempt => attempt.run_id)).toEqual(['codex:1', 'codex:2', 'retry:1', 'retry:2']);
  expect(node.children).toEqual(['run:claude:1']);
  expect(tree.nodes.some(node => node.id === 'conversation:codex' || node.id === 'conversation:retry')).toBe(false);
});
it('filters other projects, renders unresolved branches and disables retry while disconnected', () => {
  const target = fixture({ relations: [] });
  target.setConnection('runner_unavailable');
  expect(buildDelegationTree(target.getSnapshot(), '/elsewhere').nodes).toEqual([]);
  render(<MemoryRouter><TreePage project={PROJECT} target={target} client={{ command: vi.fn() }}/></MemoryRouter>);
  const branch = screen.getByRole('region', { name: 'Unconfirmed parent' });
  fireEvent.click(within(branch).getByRole('button', { name: 'Implement code' }));
  expect((screen.getByRole('button', { name: 'Retry delegation' }) as HTMLButtonElement).disabled).toBe(true);
});

it('nests review_of in the original execution direction with a readable reviewer label', () => {
  const state = fixture().getSnapshot();
  state.projection.relations = [state.projection.relations[0], { id: 'review-of', type: 'review_of', active: true,
    confidence: 'confirmed', from_id: 'claude', to_id: 'codex', evidence: { artifact_id: 'artifact' } }];
  state.projection.delegations = [state.projection.delegations[0]];
  const tree = buildDelegationTree(state, PROJECT);
  expect(tree.nodes.find(node => node.id === 'run:codex:1')!.children).toEqual(['run:claude:1']);
  expect(tree.nodes.find(node => node.id === 'run:claude:1')).toMatchObject({ label: 'Review of Terminal task graph', role: 'Reviewer' });
});
