import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { ChangesPage } from '../pages/changes/ChangesPage.tsx';
import { buildCommitGraph } from '../pages/changes/graph.ts';
import { GitChanges } from '../pages/changes/GitChanges.tsx';
import { createStore } from '../lib/store.ts';
afterEach(cleanup);
const PATCH = 'diff --git a/src/code.ts b/src/code.ts\n--- a/src/code.ts\n+++ b/src/code.ts\n@@ -1 +1 @@\n-old\n+new\n';
it('shows working tree and commits without artifacts and renders selectable numbered split diffs', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { projects: [{ id: 'repo-id', display_name: 'repo', root_path: '/repo', state: 'registered' }] } });
  const client = { command: vi.fn(async (name: string, payload?: unknown) => {
    const result = name === 'files.changes' ? { entries: [{ path: 'src/code.ts', git: ['modified'], status: 'MM', staged: true, unstaged: true, additions: 2, deletions: 2 }] }
      : name === 'files.commits' ? { commits: [{ hash: 'abcdef123456', parents: ['parent123456'], branches: ['main'], tags: ['v1'], shortHash: 'abcdef1', subject: 'Fix code', author: 'Author', time: '2026-10-08T00:00:00Z', fileCount: 1, additions: 1, deletions: 1 }] }
        : name === 'files.commit' ? { files: [{ path: 'src/code.ts', state: 'text', diff: PATCH }] }
          : { path: 'src/code.ts', state: 'text', diff: PATCH };
    return { type: 'ack' as const, cmd_id: 'c', ok: true, result };
  }) };
  render(<MemoryRouter><ChangesPage project="repo" client={client} target={target}/></MemoryRouter>);
  const tree = screen.getByRole('region', { name: 'Changed files' });
  const diff = screen.getByRole('region', { name: 'Difference' });
  const commits = screen.getByRole('region', { name: 'Commits' });
  expect(screen.queryByRole('region', { name: 'Agent changes' })).toBeNull();
  expect(await within(tree).findByRole('button', { name: /code.ts/ })).toBeTruthy();
  expect(await within(diff).findByRole('table', { name: 'src/code.ts unified diff' })).toBeTruthy();
  fireEvent.click(within(diff).getByRole('button', { name: 'Unstaged' }));
  expect(client.command).toHaveBeenCalledWith('files.diff', { projectId: 'repo-id', path: 'src/code.ts', mode: 'unstaged' });
  fireEvent.click(within(diff).getByRole('button', { name: 'Side by side' }));
  const split = await within(diff).findByRole('table', { name: 'src/code.ts split diff' });
  expect(split.querySelector('.diff-add')?.textContent).toContain('1+new');
  fireEvent.click(within(diff).getByRole('button', { name: 'src/code.ts' }));
  expect(within(diff).queryByRole('table')).toBeNull();
  fireEvent.click(await within(commits).findByRole('button', { name: /Fix code/ }));
  expect(await within(diff).findByRole('table', { name: 'src/code.ts unified diff' })).toBeTruthy();
  expect(within(tree).getByRole('button', { name: /code.ts/ }).getAttribute('aria-pressed')).toBe('true');
  expect(commits.querySelector('svg')).toBeTruthy();
  expect(within(commits).getByText('main')).toBeTruthy();
  expect(within(commits).getByText('v1')).toBeTruthy();
  expect(client.command).toHaveBeenCalledWith('files.commit', { projectId: 'repo-id', hash: 'abcdef123456' });
});

it('assigns continuous lanes to branches, merges, roots and truncated parents', () => {
  const graph = buildCommitGraph([
    { hash: 'merge', parents: ['main', 'feature'] },
    { hash: 'feature', parents: ['base'] },
    { hash: 'main', parents: ['base'] },
    { hash: 'base', parents: [] },
    { hash: 'other', parents: ['outside-limit'] },
  ]);
  expect(graph.columns).toBe(2);
  expect(graph.rows.map(row => row.column)).toEqual([0, 1, 0, 1, 0]);
  expect(graph.rows[0].segments).toContainEqual({ from: 0, to: 1, half: 'bottom', lane: 1 });
  expect(graph.rows[2].segments).toContainEqual({ from: 0, to: 1, half: 'bottom', lane: 1 });
  expect(graph.rows[3].segments.filter(segment => segment.half === 'bottom')).toEqual([]);
  expect(graph.rows[4].segments).toEqual([{ from: 0, to: 0, half: 'bottom', lane: 0 }]);
  for (let index = 0; index < 3; index++) {
    const outgoing = [...new Set(graph.rows[index].segments.filter(segment => segment.half === 'bottom').map(segment => segment.to))].sort();
    const incoming = graph.rows[index + 1].segments.filter(segment => segment.half === 'top').map(segment => segment.from).sort();
    expect(outgoing).toEqual(incoming);
  }
});

it.each([true, false])('selects the initial source and navigates all three columns (dirty: %s)', async dirty => {
  const history = [
    { hash: 'abcdef123456', shortHash: 'abcdef1', parents: ['123456abcdef'], branches: ['main'], tags: [], subject: 'Latest', author: 'Author', time: '2026-10-08T00:00:00Z' },
    { hash: '123456abcdef', shortHash: '123456a', parents: [], branches: [], tags: [], subject: 'Earlier', author: 'Author', time: '2026-10-07T00:00:00Z' },
  ];
  const client = { command: vi.fn(async (name: string, payload?: unknown) => ({ type: 'ack' as const, cmd_id: 'c', ok: true,
    result: name === 'files.changes' ? { entries: dirty ? [{ path: 'working.ts', git: ['modified'], staged: false, unstaged: true, additions: 1, deletions: 1 }] : [] }
      : name === 'files.commits' ? { commits: history }
        : name === 'files.commit' ? { files: [{ path: (payload as { hash: string }).hash === history[0].hash ? 'src/code.ts' : 'old/code.ts', state: 'text', diff: PATCH, additions: 1, deletions: 1 }] }
          : { path: 'working.ts', state: 'text', diff: PATCH },
  })) };
  const view = render(<MemoryRouter><GitChanges client={client} projectId="repo" enabled/></MemoryRouter>);
  const tree = screen.getByRole('region', { name: 'Changed files' });
  const diff = screen.getByRole('region', { name: 'Difference' });
  expect(view.container.querySelector('.git-changes')?.children.length).toBe(3);
  await within(diff).findByRole('table', { name: `${dirty ? 'working.ts' : 'src/code.ts'} unified diff` });
  const source = screen.getByRole('button', { name: dirty ? /Working tree.*changed files/ : /Latest/ });
  expect(source.getAttribute('aria-pressed')).toBe('true');
  source.focus();
  fireEvent.keyDown(source, { key: 'ArrowDown' });
  const expectedPath = dirty ? 'src/code.ts' : 'old/code.ts';
  await within(diff).findByRole('table', { name: `${expectedPath} unified diff` });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  const file = within(tree).getByRole('button', { name: /code.ts/ });
  expect(document.activeElement).toBe(file);
  expect(file.textContent).toContain('+1');
  expect(file.textContent).toContain('−1');
  fireEvent.keyDown(file, { key: 'Enter' });
  expect(document.activeElement).toBe(diff);
  fireEvent.keyDown(screen.getByRole('button', { name: dirty ? /Latest/ : /Earlier/ }), { key: 'ArrowUp' });
  await within(diff).findByRole('table', { name: `${dirty ? 'working.ts' : 'src/code.ts'} unified diff` });
});

it.each(['en', 'ja'] as const)('shows conversation badges and toggles a URL filter with existing names (%s)', async language => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'agent-graph', state: 'registered' }],
    roots: [{ id: 'root', name: 'agent-graph-001', project: 'repo', conversation_ids: ['root-conversation'] }],
    conversations: [{ id: 'root-conversation', provider: 'claude', created_ts: '2026-10-01T00:00:00Z' }, { id: 'child', provider: 'claude' }],
    relations: [{ id: 'edge', type: 'delegated', from_id: 'root-conversation', to_id: 'child', active: 1, evidence: { description: 'Improve changes' } }],
  } });
  const commits = [
    { hash: 'abcdef123456', shortHash: 'abcdef1', subject: 'Root change', conversation_ids: ['root-conversation'], author: 'Git author' },
    { hash: 'defabc123456', shortHash: 'defabc1', subject: 'Child change', conversation_ids: ['child'], author: 'Git author' },
    { hash: '123456abcdef', shortHash: '123456a', subject: 'Other change', conversation_ids: [], author: 'Other author' },
  ].map(commit => ({ ...commit, parents: [], time: '2026-10-08T00:00:00Z', branches: [], tags: [] }));
  const client = { command: vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'c', ok: true,
    result: name === 'files.commits' ? { commits } : name === 'files.changes' ? { entries: [] } : { files: [] },
  })) };
  function Location() { return <output data-testid="location">{useLocation().search}</output>; }
  render(<MemoryRouter initialEntries={['/?worktree=%2Frepo&tab=changes']}><Location/><GitChanges client={client} projectId="repo" target={target} enabled language={language}/></MemoryRouter>);
  const filter = language === 'en' ? 'Filter by conversation' : '会話で絞り込む';
  const rootBadge = await screen.findByRole('button', { name: `${filter}: agent-graph-20261001` });
  const childBadge = screen.getByRole('button', { name: `${filter}: Improve changes` });
  // 会話の名前は件名の行ではなく、同じ行の 2 行目の印に出す。件名に幅を渡すためである。
  expect(screen.getByRole('button', { name: /Root change/ }).closest('li')!.textContent).toContain('agent-graph-20261001');
  expect(screen.getByRole('button', { name: /Child change/ }).closest('li')!.textContent).toContain('Improve changes');
  expect(screen.getByRole('button', { name: /Other change/ }).textContent).toContain('Other author');
  fireEvent.click(childBadge);
  expect(screen.queryByRole('button', { name: /Root change/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Other change/ })).toBeNull();
  expect(childBadge.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByTestId('location').textContent).toContain('agent=child');
  expect(screen.getByTestId('location').textContent).toContain('worktree=%2Frepo');
  fireEvent.click(childBadge);
  expect(screen.getByRole('button', { name: /Root change/ })).toBeTruthy();
  expect(screen.getByTestId('location').textContent).not.toContain('agent=');
  fireEvent.click(screen.getByRole('button', { name: rootBadge.getAttribute('aria-label')! }));
  expect(screen.queryByRole('button', { name: /Child change/ })).toBeNull();
  expect(screen.getByTestId('location').textContent).toContain('agent=root-conversation');
});

it('restores the conversation filter from the URL and allows clearing an unknown conversation', async () => {
  const client = { command: vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'c', ok: true,
    result: name === 'files.commits' ? { commits: [{ hash: 'abcdef123456', shortHash: 'abcdef1', subject: 'Hidden', parents: [], time: '2026-10-08T00:00:00Z', author: 'Author', conversation_ids: [] }] }
      : name === 'files.changes' ? { entries: [] } : { files: [] },
  })) };
  render(<MemoryRouter initialEntries={['/?agent=missing']}><GitChanges client={client} projectId="repo" enabled/></MemoryRouter>);
  expect(await screen.findByText('No commits for this conversation.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Hidden/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Clear conversation filter: missing' }));
  expect(screen.getByRole('button', { name: /Hidden/ })).toBeTruthy();
});
