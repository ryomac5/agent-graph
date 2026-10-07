import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type Row } from '../lib/store.ts';
import { createProjectMatcher, resolveProjectId } from '../lib/projects.ts';
import { HomePage } from '../pages/home/HomePage.tsx';
import { TreePage } from '../pages/tree/TreePage.tsx';
import { buildDelegationTree } from '../pages/tree/model.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { ChangesPage } from '../pages/changes/ChangesPage.tsx';
import { selectActivities } from '../components/activity.ts';
import { buildOverview } from '../components/overview.ts';
import { summarizeDelegation } from '../components/DelegationLines.tsx';
import { conversationTitle } from '../lib/format.ts';

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes }: { nodes: { id: string; data: { node: { label: string } } }[] }) => <div>{nodes.map(node => <span key={node.id}>{node.data.node.label}</span>)}</div>,
  Handle: () => null, Background: () => null, Controls: () => null, Position: { Left: 'left', Right: 'right' },
}));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const HASH = '1e1eb3a5a3733554ff2741dd9174456e26a1b887216b1157d29d6903611c886b';
const NOW = new Date().toISOString();
const EARLIER = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
// 本番の台帳と同じ形。プロジェクトの識別はハッシュで、経路と表示は表示名を使う。
function projection(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    projects: [{ id: HASH, display_name: 'agent-graph', root_path: '/Users/me/agent-graph', state: 'registered' },
      { id: 'other-hash', display_name: 'dotfiles', root_path: '/Users/me/dotfiles', state: 'registered' }],
    conversations: [
      { id: 'root', provider: 'claude', origin: 'observed', type: 'interactive', name: 'Terminal root', project: HASH, last_message_ts: NOW },
      { id: 'child', provider: 'codex', origin: 'managed', type: 'interactive', name: 'Codex child' },
      { id: 'grandchild', provider: 'claude', origin: 'managed', type: 'interactive', name: 'Claude reviewer' },
      { id: 'lonely', provider: 'claude', origin: 'observed', type: 'interactive', name: 'Unrelated terminal', project: HASH },
      { id: 'probe', provider: 'claude', origin: 'observed', type: 'unattended', name: null },
    ],
    runs: [
      { id: 'root:1', conversation_id: 'root', generation: 1, state: 'idle', last_evidence_ts: EARLIER, repository_id: HASH },
      { id: 'child:1', conversation_id: 'child', generation: 1, state: 'running', last_evidence_ts: EARLIER, repository_id: HASH },
      { id: 'child:2', conversation_id: 'child', generation: 2, state: 'running', last_evidence_ts: NOW, repository_id: HASH },
      { id: 'grandchild:1', conversation_id: 'grandchild', generation: 1, state: 'ended', ended_ts: NOW, started_ts: EARLIER },
      { id: 'lonely:1', conversation_id: 'lonely', generation: 1, state: 'running', last_evidence_ts: NOW },
      { id: 'probe:1', conversation_id: 'probe', generation: 1, state: 'ended', ended_ts: NOW, started_ts: EARLIER },
    ],
    delegations: [
      { id: 'implement', request_id: 'implement', role: 'implement', title: 'Implement the overview', state: 'running', attempt: 2, project: HASH,
        provider: 'codex', model: 'gpt-6.1-sol', origin: JSON.stringify({ provider: 'claude', native_id: 'root' }),
        parent: JSON.stringify({ confidence: 'confirmed', conversation_id: 'root' }),
        attempts: JSON.stringify([{ attempt: 1, run_id: 'child:1', state: 'failed', assignment: { executor: 'codex', model: 'gpt-6.1-sol' } },
          { attempt: 2, run_id: 'child:2', state: 'running', assignment: { executor: 'codex', model: 'gpt-6.1-sol' } }]) },
      { id: 'review', request_id: 'review', role: 'review', title: 'Review the overview', state: 'done', attempt: 1, project: HASH, parent_run_id: 'child:2',
        parent: JSON.stringify({ confidence: 'confirmed', run_id: 'child:2' }),
        attempts: JSON.stringify([{ attempt: 1, run_id: 'grandchild:1', state: 'done', assignment: { executor: 'claude', model: 'claude-opus' } }]) },
      { id: 'kit', request_id: 'kit', role: 'implement', title: 'Old kit task', state: 'failed', attempt: 1, project: 'other-hash', provider: 'codex', model: 'gpt-kit',
        parent: JSON.stringify({ confidence: 'unknown' }), attempts: JSON.stringify([{ attempt: 1, run_id: 'kit:missing', state: 'failed' }]) },
    ],
    ...extra,
  };
}
function setup(extra: Record<string, Row[]> = {}) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: projection(extra) });
  target.setConnection('connected');
  return target;
}

it('resolves a route by display name, id or place and matches Other by the absence of a registered project', () => {
  const state = setup().getSnapshot();
  expect(resolveProjectId(state, 'agent-graph')).toBe(HASH);
  expect(resolveProjectId(state, HASH)).toBe(HASH);
  expect(resolveProjectId(state, '/Users/me/agent-graph')).toBe(HASH);
  expect(resolveProjectId(state, 'unknown')).toBe('unknown');
  expect(createProjectMatcher(state, 'agent-graph')([undefined, HASH])).toBe(true);
  expect(createProjectMatcher(state, 'agent-graph')(['other-hash'])).toBe(false);
  expect(createProjectMatcher(state, 'other')(['unregistered-hash', undefined])).toBe(true);
  expect(createProjectMatcher(state, 'other')(['other-hash'])).toBe(false);
});

it('builds the Overview per project with the delegation tree under the task that started it', () => {
  const state = setup().getSnapshot();
  const overview = buildOverview(state, selectActivities(state), buildDelegationTree(state));
  const project = overview.projects.find(group => group.id === HASH)!;
  // 外の端末から起こした作業はその会話を根にし、委譲で起きた会話は行にしない。
  expect(project.items.map(item => item.activity.name)).toEqual(['Terminal root']);
  const [implement] = project.items[0].delegations;
  expect(summarizeDelegation(implement)).toBe('Codex gpt-6.1-sol · implement · running · 2 attempts');
  expect(implement.children.map(line => summarizeDelegation(line))).toEqual(['Claude claude-opus · review · done · 1 attempt']);
  expect(project.items[0].active).toBe(true);
  expect(project.running).toBe(1);
  // 親が確定しない委譲は、その委譲のプロジェクトの別の枝に置く。
  expect(overview.projects.find(group => group.id === 'other-hash')!.unlinked.map(line => line.node.label)).toEqual(['Old kit task']);
  expect(overview.external.map(item => item.activity.name)).toEqual(['Unrelated terminal']);
  expect(overview.unattended).toHaveLength(1);
});

it('shows each delegation as one readable line, opens active trees and keeps terminal conversations folded with counts', () => {
  render(<MemoryRouter><HomePage target={setup()}/></MemoryRouter>);
  const section = screen.getByRole('region', { name: 'agent-graph' });
  const row = within(section).getByRole('article', { name: 'Terminal root' });
  const fold = row.querySelector('details.delegation-fold') as HTMLDetailsElement;
  expect(fold.open).toBe(true);
  expect(fold.querySelector('summary')!.textContent).toBe('2 delegations · 1 active');
  expect(within(row).getByRole('link', { name: 'Codex gpt-6.1-sol · implement · running · 2 attempts' }).getAttribute('href')).toBe('/c/child');
  expect(within(row).getByText('Implement the overview')).toBeTruthy();
  expect(within(row).getByText('Review the overview').closest('li')!.classList.contains('is-stopped')).toBe(true);
  expect(within(section).queryByRole('article', { name: 'Codex child' })).toBeNull();
  expect(section.querySelector('.section-count')!.textContent).toBe('1 running');
  // 外の端末の会話は畳み、件数と動いている数だけを見せる。
  const external = screen.getByRole('region', { name: 'External conversations' });
  expect(within(external).queryByRole('article')).toBeNull();
  expect(within(external).getByText('running').closest('.section-count')!.textContent).toBe('1 running');
  const other = screen.getByRole('region', { name: 'dotfiles' });
  expect(other.querySelector('.delegation-fold summary')!.textContent).toBe('1 delegation without a confirmed parent');
  expect(within(other).getByText('Codex gpt-kit · implement · failed · 1 attempt')).toBeTruthy();
  // 動いている作業の行には、経過と最後の根拠の時刻を添える。
  expect(within(row).getByText(/Last evidence/)).toBeTruthy();
});

it('filters Tree, workspace and Changes by a display-name route through the projects projection', () => {
  const target = setup({
    artifacts: [{ id: 'artifact', run_id: 'child:2', version: 1, repository_id: HASH, patch_hash: 'h',
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
    { id: 'foreign', run_id: 'probe:1', version: 1, repository_id: 'other-hash', patch_hash: 'f', diff: '' }],
  });
  const tree = buildDelegationTree(target.getSnapshot(), 'agent-graph');
  expect(tree.roots).toEqual(['conversation:root']);
  expect(tree.nodes.find(node => node.id === 'conversation:root')!.role).toBe('Terminal conversation');
  expect(buildDelegationTree(target.getSnapshot(), 'dotfiles').unresolved).toEqual(['run:kit:missing']);
  render(<MemoryRouter><TreePage project="agent-graph" target={target}/></MemoryRouter>);
  expect(screen.queryByText('No delegations yet')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Delegation tree' })).getByRole('button', { name: 'Implement the overview' })).toBeTruthy();
  cleanup();
  vi.stubGlobal('innerWidth', 1024);
  render(<MemoryRouter><WorkspacePage project="agent-graph" target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: false })) }}/></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'agent-graph' })).toBeTruthy();
  // Show temporary は見出しの外に浮かせず、一覧と同じく絞り込みの行に置く。
  const filters = screen.getByRole('group', { name: 'Filters' });
  expect(filters.closest('.workspace-header')).toBeTruthy();
  expect(within(filters).getByRole('checkbox', { name: 'Show temporary' })).toBeTruthy();
  expect(within(screen.getByRole('region', { name: 'Tasks' })).getAllByRole('article').map(row => row.getAttribute('aria-label'))).toContain('Terminal root');
  cleanup();
  render(<MemoryRouter><ChangesPage project="agent-graph" target={target} client={{ command: vi.fn() }}/></MemoryRouter>);
  expect(screen.getByRole('button', { name: 'Comment on a.ts new line 1' })).toBeTruthy();
  expect(screen.queryByText(/foreign/)).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Tree' }));
});

it('turns reason codes into readable English everywhere and keeps them out of list rows', async () => {
  const { reasonText } = await import('../lib/reasons.ts');
  expect(reasonText('unconfirmed_end_evidence')).toBe('No end recorded');
  expect(reasonText('missing_turn_evidence')).toBe('No turn evidence');
  expect(reasonText('legacy ended inference: process_exit')).toBe('Ended by process exit (legacy)');
  expect(reasonText('some_new_code')).toBe('Some new code');
  expect(reasonText('Observation interrupted')).toBe('Observation interrupted');
  const target = setup({ runs: [...projection().runs!.filter(run => run.id !== 'lonely:1'),
    { id: 'lonely:1', conversation_id: 'lonely', generation: 1, state: 'unknown', reason: 'legacy ended inference: process_exit', last_evidence_ts: EARLIER }] });
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'External conversations' }));
  const badge = within(screen.getByRole('article', { name: 'Unrelated terminal' })).getByRole('link', { name: 'Unknown · Evidence' });
  expect(badge.textContent).toBe('Unknown');
  expect(badge.title).toContain('Ended by process exit (legacy)');
  expect(document.body.textContent).not.toContain('legacy ended inference');
});

it('roots the tree only at tasks that delegated, names untitled conversations and folds repeated runs into attempts', () => {
  const state = setup({
    conversations: [...projection().conversations!, { id: 'solo', provider: 'claude', origin: 'managed', type: 'interactive', name: null }],
    runs: [...projection().runs!, { id: 'solo:1', conversation_id: 'solo', generation: 1, state: 'ended', started_ts: '2026-10-07T01:46:00' },
      { id: 'root:2', conversation_id: 'root', generation: 2, state: 'running', last_evidence_ts: NOW }],
  }).getSnapshot();
  const tree = buildDelegationTree(state, 'agent-graph');
  // 委譲のない作業は根にしない。
  expect(tree.roots).toEqual(['conversation:root']);
  expect(buildDelegationTree(state).nodes.some(node => node.conversationId === 'solo')).toBe(false);
  // 実行が 2 つ以上の作業だけ、自身の実行を試行として並べる。
  const root = tree.nodes.find(node => node.id === 'conversation:root')!;
  expect(root.children.map(id => tree.nodes.find(node => node.id === id)!.label).sort()).toEqual(['Attempt 1', 'Attempt 2', 'Implement the overview']);
  // 名前のない会話は、画面の全てで同じ conversationTitle の規則で provider と時刻で呼ぶ。
  const solo = tree.nodes.find(node => node.conversationId === 'solo');
  expect(solo).toBeUndefined();
  expect(conversationTitle({ provider: 'claude', name: null }, '2020-01-02T10:46:00')).toBe('Claude · Jan 2 10:46');
  expect(conversationTitle({ provider: 'codex' }, undefined)).toBe('Codex');
});

it('shows one task subtree in the graph, defaults to the active one and switches on selection', () => {
  const target = setup({
    conversations: [...projection().conversations!, { id: 'second', provider: 'codex', origin: 'managed', type: 'interactive', name: 'Second task', project: HASH },
      { id: 'second-child', provider: 'claude', origin: 'managed', type: 'interactive', name: 'Second child' }],
    runs: [...projection().runs!, { id: 'second:1', conversation_id: 'second', generation: 1, state: 'ended', ended_ts: EARLIER },
      { id: 'second-child:1', conversation_id: 'second-child', generation: 1, state: 'ended', ended_ts: EARLIER }],
    delegations: [...projection().delegations!, { id: 'later', request_id: 'later', role: 'review', title: 'Second review', state: 'done', attempt: 1, project: HASH,
      parent: JSON.stringify({ confidence: 'confirmed', conversation_id: 'second' }), attempts: JSON.stringify([{ attempt: 1, run_id: 'second-child:1', state: 'done' }]) }],
  });
  render(<MemoryRouter><TreePage project="agent-graph" target={target}/></MemoryRouter>);
  const graph = screen.getByLabelText('Delegation graph');
  // 既定は動いている作業の部分木である。全体を 1 列に並べない。
  expect(within(graph).getByText('Implement the overview')).toBeTruthy();
  expect(within(graph).queryByText('Second review')).toBeNull();
  fireEvent.click(within(screen.getByRole('region', { name: 'Delegation tree' })).getByRole('button', { name: 'Second review' }));
  expect(within(graph).getByText('Second review')).toBeTruthy();
  expect(within(graph).queryByText('Implement the overview')).toBeNull();
  expect(screen.getByText('Second task', { selector: 'strong' })).toBeTruthy();
});

it('lists workspace tasks as single short lines and keeps the unknown evidence out of a separate banner', () => {
  vi.stubGlobal('innerWidth', 1024);
  const target = setup({ runs: [{ id: 'lonely:1', conversation_id: 'lonely', generation: 1, state: 'unknown', reason: 'unconfirmed_end_evidence', last_evidence_ts: EARLIER }] });
  render(<MemoryRouter><WorkspacePage project="agent-graph" target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: false })) }}/></MemoryRouter>);
  const tasks = screen.getByRole('region', { name: 'Tasks' });
  expect(tasks.querySelectorAll('.activity-line').length).toBe(within(tasks).getAllByRole('article').length);
  expect(screen.queryByText(/Unknown — Last evidence/)).toBeNull();
});
