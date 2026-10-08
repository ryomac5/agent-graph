import { projectRoots } from './root-fixture.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type Row } from '../lib/store.ts';
import { buildDelegationTree } from '../pages/tree/model.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';

// 依頼の流れは作業場の右の列に出る。列は 1280px 以上で開いて始まる。
beforeEach(() => { vi.stubGlobal('innerWidth', 1440); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
  projectRoots(target, ['origin']);
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
it('keeps inferred and missing parents in a separate branch and marks candidate edges', () => {
  const tree = buildDelegationTree(fixture({ relations: [
    { id: 'candidate', type: 'delegated', active: 1, from_id: 'origin', to_id: 'codex', confidence: 'inferred', evidence: { request_id: 'implementation' } },
    { id: 'unknown', type: 'delegated', active: 1, to_id: 'claude', confidence: 'unknown', evidence: { request_id: 'review' } },
  ] }).getSnapshot());
  expect(tree.unresolved).toEqual(['run:claude:1', 'run:codex:1']);
  expect(tree.nodes.find(n => n.id === 'conversation:origin')!.children).toEqual([]);
  expect(tree.edges.find(e => e.id === 'relation:candidate')!.confidence).toBe('inferred');
  expect(buildDelegationTree(fixture().getSnapshot()).edges.every(e => e.confidence === 'confirmed')).toBe(true);
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
it('shows the flow under its root in the workspace, selects requests and sends the retry command', async () => {
  const target = fixture();
  const command = vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'retry', ok: true }));
  render(<MemoryRouter><WorkspacePage project={PROJECT} target={target} client={{ command }}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Sub-agents' });
  // 根を頂点に置き、依頼はその下に字下げで続ける。
  const apex = within(flow).getByRole('button', { name: /^Terminal/ });
  expect(apex.getAttribute('aria-pressed')).toBe('true');
  const implement = within(flow).getByRole('button', { name: /(Codex|GPT)[^·]* · implement/ });
  expect(implement.closest('ul')?.closest('li')?.contains(apex)).toBe(true);
  fireEvent.click(implement);
  expect(within(flow).getByRole('button', { name: /(Codex|GPT)[^·]* · implement/ }).getAttribute('aria-pressed')).toBe('true');
  expect(within(flow).getByRole('button', { name: /^Terminal/ }).getAttribute('aria-pressed')).toBe('false');
  expect(within(flow).queryByRole('button', { name: 'Retry' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('intake.retry', { requestId: 'implementation' }));
  fireEvent.click(within(flow).getByRole('button', { name: /Claude[^·]* · review/ }));
  expect(within(flow).getByRole('button', { name: /Claude[^·]* · review/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(flow).getByRole('button', { name: /^Terminal/ }));
  expect(within(flow).getByRole('button', { name: /^Terminal/ }).getAttribute('aria-pressed')).toBe('true');
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
  render(<MemoryRouter><WorkspacePage project={PROJECT} target={target} client={{ command }}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Sub-agents' });
  expect(within(flow).getAllByRole('button', { name: /(Codex|GPT)[^·]* · implement/ })).toHaveLength(1);
  fireEvent.click(within(flow).getByRole('button', { name: /(Codex|GPT)[^·]* · implement/ }));
  expect(within(flow).queryByRole('button', { name: 'Retry' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getAllByRole('alert')[0].textContent).toBe('Runner unavailable'));
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
  expect(tree.nodes.map(node => node.id).sort()).toEqual(['conversation:origin', 'run:claude:1', 'run:codex:2']);
  expect(tree.edges.map(edge => [edge.source, edge.target])).toEqual([
    ['conversation:origin', 'run:codex:2'], ['run:codex:2', 'run:claude:1'],
  ]);
  render(<MemoryRouter><WorkspacePage project={PROJECT} target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Sub-agents' });
  expect(within(flow).getAllByRole('button', { name: /(Codex|GPT)[^·]* · implement/ })).toHaveLength(1);
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
it('keeps delegations with unconfirmed parents out of the selected root tree while disconnected', () => {
 const target = fixture({ relations: [] }); target.setConnection('runner_unavailable');
 target.getSnapshot().projection.delegations.forEach(row => { row.root_id = null; }); target.getSnapshot().projection.relations = [];
 expect(buildDelegationTree(target.getSnapshot(), '/elsewhere').nodes).toEqual([]);
 render(<MemoryRouter><WorkspacePage project={PROJECT} target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
 const flow = screen.getByRole('complementary', { name: 'Sub-agents' }); expect(within(flow).getByText('No sub-agents yet')).toBeTruthy(); expect(within(flow).queryByRole('button', { name: 'Retry' })).toBeNull();
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
