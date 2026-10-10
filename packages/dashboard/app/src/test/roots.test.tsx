import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore } from '../lib/store.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { HomePage } from '../pages/home/HomePage.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [
      { id: 'old', name: 'agent-graph-002', project: 'repo', state: 'ended', last_activity_ts: '2026-10-08T02:00:00Z', conversation_ids: ['old'], running_children: 0, total_children: 0 },
      { id: 'root', name: 'agent-graph-001', project: 'repo', state: 'running', last_activity_ts: '2026-10-08T01:00:00Z', conversation_ids: ['root', 'continuation'], running_children: 1, total_children: 2 },
    ],
    conversations: [
      { id: 'root', provider: 'claude', type: 'interactive', origin: 'observed', history_format: 'jsonl' },
      { id: 'continuation', provider: 'claude', type: 'interactive', origin: 'observed', history_format: 'jsonl' },
      { id: 'child', provider: 'codex', type: 'subagent', origin: 'observed', history_format: 'jsonl' },
      { id: 'grandchild', provider: 'claude', type: 'subagent', origin: 'observed', history_format: 'jsonl' },
      { id: 'unattended', type: 'unattended', name: 'Orphan run' },
    ],
    runs: [{ id: 'child-run', conversation_id: 'child', model: 'gpt-6.1-sol', state: 'running' }, { id: 'grandchild-run', conversation_id: 'grandchild', state: 'ended' }],
    delegations: [{ id: 'kit-task', root_id: 'root', graph_name: 'Screen graph', payload: { kit: { session: 'agent-graph-001' } }, role: 'implement', title: 'Build the screen', provider: 'codex', model: 'gpt-6.1-sol', state: 'running', attempts: [{ attempt: 1, run_id: 'child-run', state: 'running' }] }],
    relations: [
      { id: 'continued', type: 'continued', from_id: 'root', to_id: 'continuation', active: 1 },
      { id: 'delegated', type: 'delegated', from_id: 'continuation', to_id: 'child', evidence: { agentType: 'implement', description: 'Build the screen', toolUseId: 'tool-1' } },
      { id: 'nested', type: 'delegated', from_id: 'child', to_id: 'grandchild', evidence: { agentType: 'review', description: 'Check the screen' } },
    ],
    messages: [
      { id: 'm1', role: 'user', body: 'Original request', source_ts: '2026-10-08T00:00:00Z' },
      { id: 'm2', role: 'assistant', body: 'Root response', source_ts: '2026-10-08T00:01:00Z' },
      { id: 'm3', role: 'assistant', body: 'Continued response', source_ts: '2026-10-08T01:00:00Z' },
      { id: 'm4', role: 'user', body: 'Parent request', source_ts: '2026-10-08T01:01:00Z' },
      { id: 'm5', role: 'assistant', body: 'Child response', source_ts: '2026-10-08T01:02:00Z' },
    ],
    message_memberships: ['root', 'root', 'continuation', 'child', 'child'].map((conversation, index) => ({ id: 'link-' + index, message_id: 'm' + (index + 1), conversation_id: conversation, active: 1 })),
  } });
  return target;
}
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })),
  fetchConversation: vi.fn(async () => ({ generation: 1, projection: { messages: [], message_memberships: [] }, next: null })) };
it('selects the running root, joins its continuation and switches to child conversation and back', async () => {
  vi.stubGlobal('innerWidth', 1440);
  render(<MemoryRouter><WorkspacePage project="repo" target={fixture()} client={client}/></MemoryRouter>);
  const list = screen.getByRole('region', { name: 'Conversations' });
  expect(within(list).getAllByRole('link').map(row => row.querySelector('.root-name')?.textContent)).toEqual(['Repo-20261008', 'agent-graph-002']);
  expect([...list.querySelectorAll('a')].some(row => row.title.includes('1 agent running'))).toBe(true);
  expect(screen.getByText('Original request').closest('article')?.getAttribute('data-side')).toBe('end');
  expect(screen.getByText('Root response').closest('article')?.getAttribute('data-side')).toBe('start');
  expect(await screen.findByText('Continued response')).toBeTruthy();
  expect(screen.getAllByText('Conversation continued')).toHaveLength(1);
  const tree = screen.getByRole('complementary', { name: 'Panel' });
  fireEvent.click(within(tree).getByRole('button', { name: '1 earlier request' }));
  expect(within(tree).getByText('Check the screen').closest('.graph-card')?.getAttribute('style')).toContain('margin-left: 48px');
  fireEvent.click(within(tree).getByRole('link', { name: 'Build the screen · GPT-6.1 Sol · implement · Running' }));
  expect(await screen.findByText('Child response')).toBeTruthy(); expect(screen.queryByText('Original request')).toBeNull();
  expect(screen.getByText('Parent request').closest('article')?.getAttribute('data-side')).toBe('end');
  fireEvent.click(screen.getByRole('button', { name: 'Back to Repo-20261008' }));
  expect(await screen.findByText('Original request')).toBeTruthy(); expect(screen.queryByText('Child response')).toBeNull();
  fireEvent.click(within(list).getByRole('link', { name: /agent-graph-002/ })); expect(screen.queryByText('Build the screen')).toBeNull();
});
it('lists only roots with running children and leaves orphan unattended runs out', () => {
  render(<MemoryRouter><HomePage target={fixture()}/></MemoryRouter>);
  expect(screen.getAllByRole('link', { name: /Repo-20261008|agent-graph-002/ })).toHaveLength(2);
  expect(screen.getByRole('heading', { name: /Screen graph/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Build the screen · GPT-6.1 Sol · implement · Running' })).toBeTruthy();
  expect(screen.queryByText('Check the screen')).toBeNull();
  // 根でない会話は一覧に出さない。
  expect(screen.queryByText('Orphan run')).toBeNull();
});
