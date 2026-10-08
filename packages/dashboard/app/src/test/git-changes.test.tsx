import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ChangesPage } from '../pages/changes/ChangesPage.tsx';
import { createStore } from '../lib/store.ts';
afterEach(cleanup);
const PATCH = 'diff --git a/src/code.ts b/src/code.ts\n--- a/src/code.ts\n+++ b/src/code.ts\n@@ -1 +1 @@\n-old\n+new\n';
it('shows working tree and commits without artifacts and renders selectable numbered split diffs', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { projects: [{ id: 'repo-id', display_name: 'repo', root_path: '/repo', state: 'registered' }] } });
  const client = { command: vi.fn(async (name: string, payload?: unknown) => {
    const result = name === 'files.changes' ? { entries: [{ path: 'src/code.ts', git: ['modified'], status: 'MM', staged: true, unstaged: true, additions: 2, deletions: 2 }] }
      : name === 'files.commits' ? { commits: [{ hash: 'abcdef123456', shortHash: 'abcdef1', subject: 'Fix code', author: 'Author', time: '2026-10-08T00:00:00Z', fileCount: 1, additions: 1, deletions: 1 }] }
        : name === 'files.commit' ? { files: [{ path: 'src/code.ts', state: 'text', diff: PATCH }] }
          : { path: 'src/code.ts', state: 'text', diff: PATCH };
    return { type: 'ack' as const, cmd_id: 'c', ok: true, result };
  }) };
  render(<MemoryRouter><ChangesPage project="repo" client={client} target={target}/></MemoryRouter>);
  const tree = screen.getByRole('region', { name: 'Working tree' });
  const commits = screen.getByRole('region', { name: 'Commits' });
  expect(screen.queryByRole('region', { name: 'Agent changes' })).toBeNull();
  expect(await within(tree).findByRole('button', { name: /code.ts/ })).toBeTruthy();
  expect(await within(tree).findByRole('table', { name: 'src/code.ts unified diff' })).toBeTruthy();
  fireEvent.click(within(tree).getByRole('button', { name: 'Unstaged' }));
  expect(client.command).toHaveBeenCalledWith('files.diff', { projectId: 'repo-id', path: 'src/code.ts', mode: 'unstaged' });
  fireEvent.click(within(tree).getByRole('button', { name: 'Side by side' }));
  const split = await within(tree).findByRole('table', { name: 'src/code.ts split diff' });
  expect(split.querySelector('.diff-add')?.textContent).toContain('1+new');
  fireEvent.click(within(tree).getByRole('button', { name: 'src/code.ts' }));
  expect(within(tree).queryByRole('table')).toBeNull();
  fireEvent.click(await within(commits).findByRole('button', { name: /Fix code/ }));
  expect(await within(commits).findByRole('table', { name: 'src/code.ts unified diff' })).toBeTruthy();
  expect(client.command).toHaveBeenCalledWith('files.commit', { projectId: 'repo-id', hash: 'abcdef123456' });
});
