import { projectRoots } from './root-fixture.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore, type Row } from '../lib/store.ts';
import { createProjectMatcher, resolveProjectId } from '../lib/projects.ts';
import { HomePage } from '../pages/home/HomePage.tsx';
import { buildDelegationTree } from '../pages/tree/model.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { ChangesPage } from '../pages/changes/ChangesPage.tsx';
import { RECENT_TERMINAL_WINDOW_MS, selectActivities } from '../components/activity.ts';
import { buildOverview } from '../components/overview.ts';
import { summarizeDelegation } from '../components/DelegationLines.tsx';
import { conversationTitle } from '../lib/format.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
      { id: 'old-terminal', provider: 'claude', origin: 'observed', type: 'interactive', name: 'Old terminal', project: HASH },
      { id: 'lonely', provider: 'claude', origin: 'observed', type: 'interactive', name: 'Unrelated terminal', project: HASH },
      { id: 'probe', provider: 'claude', origin: 'observed', type: 'unattended', name: null },
    ],
    runs: [
      { id: 'root:1', conversation_id: 'root', generation: 1, state: 'idle', last_evidence_ts: EARLIER, repository_id: HASH },
      { id: 'child:1', conversation_id: 'child', generation: 1, state: 'running', last_evidence_ts: EARLIER, repository_id: HASH },
      { id: 'child:2', conversation_id: 'child', generation: 2, state: 'running', last_evidence_ts: NOW, repository_id: HASH },
      { id: 'grandchild:1', conversation_id: 'grandchild', generation: 1, state: 'ended', ended_ts: NOW, started_ts: EARLIER },
      { id: 'old-terminal:1', conversation_id: 'old-terminal', generation: 1, state: 'idle', last_evidence_ts: EARLIER },
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
  projectRoots(target, ['root', 'lonely', 'old-terminal'].filter(id => target.getSnapshot().projection.conversations.some(row => row.id === id)));
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
  state.projection.relations = [];
  const overview = buildOverview(state, selectActivities(state), buildDelegationTree(state));
  const project = overview.projects.find(group => group.id === HASH)!;
  // 外の端末から起こした作業はその会話を根にし、委譲で起きた会話は行にしない。
  expect(project.items.map(item => item.activity.name)).toEqual(['Unrelated terminal', 'Terminal root']);
  const root = project.items.find(item => item.activity.name === 'Terminal root')!;
  const [implement] = root.delegations;
  expect(summarizeDelegation(implement)).toBe('Codex gpt-6.1-sol · implement · running · 2 attempts');
  expect(implement.children.map(line => summarizeDelegation(line))).toEqual(['Claude claude-opus · review · done · 1 attempt']);
  expect(root.active).toBe(true);
  expect(project.running).toBe(2);
  // 親が確定しない委譲は、その委譲のプロジェクトの別の枝に置く。
  expect(overview.projects.find(group => group.id === 'other-hash')!.unlinked.map(line => line.node.label)).toEqual(['Old kit task']);
  expect(overview.external.map(item => item.activity.name)).toEqual(['Old terminal']);
  expect(overview.unattended).toHaveLength(1);
});

it('shows roots and only their running descendants on the overview', () => {
 render(<MemoryRouter><HomePage target={setup()}/></MemoryRouter>);
 const section = screen.getByRole('region', { name: 'agent-graph' });
 expect(section.querySelector('.root-row')!.textContent).toContain('Unrelated terminal');
 expect(within(section).getByRole('link', { name: /Terminal root/ })).toBeTruthy();
 expect(within(section).getByRole('button', { name: /GPT-6.1 Sol · implement · Running$/ })).toBeTruthy();
 expect(within(section).queryByText('Review the overview')).toBeNull(); expect(screen.queryByText('External conversations')).toBeNull();
 // 根でない会話は一覧に出さない。
 expect(screen.queryByText('Background')).toBeNull();
});
it('filters root views and Changes by a display-name route', () => {
 const target = setup({ artifacts: [{ id: 'artifact', run_id: 'child:2', version: 1, repository_id: HASH, patch_hash: 'h', diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }, { id: 'foreign', run_id: 'probe:1', version: 1, repository_id: 'other-hash', patch_hash: 'f', diff: '' }] });
 vi.stubGlobal('innerWidth', 1440); render(<MemoryRouter><WorkspacePage project="agent-graph" target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
 fireEvent.click(screen.getByRole('link', { name: /Terminal root/ }));
 expect(within(screen.getByRole('complementary', { name: 'Panel' })).getByText('Implement the overview')).toBeTruthy(); cleanup(); localStorage.clear();
 vi.stubGlobal('innerWidth', 1024); render(<MemoryRouter><WorkspacePage project="agent-graph" target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
 expect(document.querySelector('.workspace-header')).toBeNull(); expect(within(screen.getByRole('region', { name: 'Conversations' })).getByRole('link', { name: /Terminal root/ })).toBeTruthy(); cleanup();
 render(<MemoryRouter><ChangesPage project="agent-graph" target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>); expect(screen.getByRole('button', { name: 'Comment on a.ts new line 1' })).toBeTruthy(); expect(screen.queryByText(/foreign/)).toBeNull();
});
it('keeps reason codes out of root rows and translates evidence reasons', async () => {
 const { reasonText } = await import('../lib/reasons.ts'); expect(reasonText('unconfirmed_end_evidence')).toBe('No end recorded'); expect(reasonText('missing_turn_evidence')).toBe('No turn record'); expect(reasonText('legacy ended inference: process_exit')).toBe('Ended by process exit (legacy)'); expect(reasonText('some_new_code')).toBe('Some new code'); expect(reasonText('Observation interrupted')).toBe('Observation interrupted');
 const target = setup({ runs: [...projection().runs!.filter(run => run.id !== 'lonely:1'), { id: 'lonely:1', conversation_id: 'lonely', generation: 1, state: 'unknown', reason: 'legacy ended inference: process_exit', last_evidence_ts: EARLIER }] });
 render(<MemoryRouter><HomePage target={target}/></MemoryRouter>); const row = screen.getByRole('link', { name: /Unrelated terminal/ }); expect(row.querySelector('.root-state')?.textContent).toBe('Unknown'); expect(document.body.textContent).not.toContain('legacy ended inference');
});
it('roots the tree only at tasks that delegated, names untitled conversations and folds repeated runs into attempts', () => {
  const state = setup({
    conversations: [...projection().conversations!, { id: 'solo', provider: 'claude', origin: 'managed', type: 'interactive', name: null }],
    runs: [...projection().runs!, { id: 'solo:1', conversation_id: 'solo', generation: 1, state: 'ended', started_ts: '2026-10-07T01:46:00' },
      { id: 'root:2', conversation_id: 'root', generation: 2, state: 'running', last_evidence_ts: NOW }],
  }).getSnapshot();
  state.projection.relations = [];
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
  expect(conversationTitle({ provider: 'claude', name: null }, '2020-01-02T10:46:00')).toBe('Claude · Jan 2, 2020 10:46');
  expect(conversationTitle({ provider: 'codex' }, undefined)).toBe('Codex');
});

it('switches the request flow between roots in the workspace', () => {
 const target = setup(); const snapshot = target.getSnapshot(); target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
 roots: [...snapshot.projection.roots, { id: 'second', name: 'Second root', project: HASH, state: 'ended', last_activity_ts: EARLIER, conversation_ids: ['second'], running_children: 0, total_children: 1 }],
 conversations: [...snapshot.projection.conversations, { id: 'second-child', provider: 'claude', state: 'ended' }],
 relations: [...snapshot.projection.relations, { id: 'second-child-edge', type: 'delegated', from_id: 'second', to_id: 'second-child', evidence: { agentType: 'review', description: 'Second review' } }] } });
 vi.stubGlobal('innerWidth', 1440); render(<MemoryRouter><WorkspacePage project="agent-graph" target={target} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
 const flow = screen.getByRole('complementary', { name: 'Panel' });
 fireEvent.click(within(screen.getByRole('region', { name: 'Conversations' })).getByRole('link', { name: /Terminal root/ }));
 expect(within(flow).getByText('GPT-6.1 Sol · implement')).toBeTruthy();
 fireEvent.click(within(screen.getByRole('region', { name: 'Conversations' })).getByRole('link', { name: /Second root/ })); expect(within(flow).queryByText('GPT-6.1 Sol · implement')).toBeNull(); expect(within(flow).getByText('Second review')).toBeTruthy();
});
it('lists projected roots with child counts and keeps unknown evidence out of a separate banner', () => {
 vi.stubGlobal('innerWidth', 1024); render(<MemoryRouter><WorkspacePage project="agent-graph" target={setup()} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
 const roots = screen.getByRole('region', { name: 'Conversations' }); expect(roots.querySelectorAll('.root-row')).toHaveLength(3); expect(within(roots).getByText('1 agent running')).toBeTruthy(); expect(screen.queryByText(/Unknown — Last evidence/)).toBeNull();
});
it('lists old roots as well as current roots without listing unrelated child conversations', () => {
 vi.stubGlobal('innerWidth', 1024); render(<MemoryRouter><WorkspacePage project="agent-graph" target={setup()} client={{ command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true })) }}/></MemoryRouter>);
 const roots = screen.getByRole('region', { name: 'Conversations' }); expect(within(roots).getByRole('link', { name: /Unrelated terminal/ })).toBeTruthy(); expect(within(roots).getByRole('link', { name: /Old terminal/ })).toBeTruthy(); expect(within(roots).queryByText('Codex child')).toBeNull();
});