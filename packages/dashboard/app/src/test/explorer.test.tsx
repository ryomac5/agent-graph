import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App.tsx';
import { ChangesPage } from '../pages/changes/ChangesPage.tsx';
import { detectLanguage, highlightLines, type Token } from '../pages/files/highlight.ts';
import type { FileEntry, GitMark, ReadResult } from '../pages/files/model.ts';
import { createStore } from '../lib/store.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ROOT = '/Users/me/repo';
const FEATURE = '/Users/me/repo-feature';
const file = (path: string, git: GitMark[] = [], previousPath?: string): FileEntry =>
  ({ name: path.split('/').at(-1)!, path, kind: 'file', git, changed: git.length > 0, ...(previousPath ? { previousPath } : {}) });
const folder = (path: string, changed = false): FileEntry => ({ name: path.split('/').at(-1)!, path, kind: 'directory', git: [], changed });
const LISTS: Record<string, Record<string, FileEntry[]>> = {
  [ROOT]: {
    '': [folder('docs'), folder('src', true), file('README.md', ['modified']), file('added.ts', ['added']), file('gone.txt', ['deleted']),
      file('moved.py', ['renamed'], 'old.py'), file('notes.txt', ['untracked'])],
    docs: [file('docs/guide.md')],
    src: [folder('src/lib', true), file('src/huge.log'), file('src/logo.png'), file('src/main.ts', ['modified'])],
    'src/lib': [file('src/lib/util.ts', ['modified'])],
  },
  [FEATURE]: { '': [folder('feature'), file('feature.txt', ['added'])], feature: [file('feature/only.ts')] },
};
const text = (worktree: string, path: string, content: string): ReadResult => ({ worktree, path, size: new TextEncoder().encode(content).length, state: 'text', content });
const FILES: Record<string, ReadResult> = {
  'README.md': text(ROOT, 'README.md', '# Title\n\nSome `code` here.\n'),
  'src/main.ts': text(ROOT, 'src/main.ts', 'const answer = 42; // note\nexport function run() { return "ok"; }\n'),
  'src/lib/util.ts': text(ROOT, 'src/lib/util.ts', 'export const util = true;\n'),
  'docs/guide.md': text(ROOT, 'docs/guide.md', 'Guide\n'),
  'src/logo.png': { worktree: ROOT, path: 'src/logo.png', size: 2048, state: 'binary' },
  'src/huge.log': { worktree: ROOT, path: 'src/huge.log', size: 1572864, state: 'too_large' },
  'feature.txt': text(FEATURE, 'feature.txt', 'feature branch\n'),
};

interface Payload { projectId: string; path?: string; worktree?: string }
function createClient() {
  return { command: vi.fn(async (command: string, payload?: unknown) => {
    const request = payload as Payload;
    const tree = request.worktree ?? ROOT;
    const ok = (result: unknown) => ({ type: 'ack' as const, cmd_id: 'id', ok: true, result });
    const fail = (error: string) => ({ type: 'ack' as const, cmd_id: 'id', ok: false, error });
    if (request.projectId !== 'repo-id') return fail('Unknown registered project');
    if (command === 'files.worktrees') return ok({ worktree: ROOT, worktrees: [
      { path: ROOT, head: 'aaaaaaaaaaaa', branch: 'refs/heads/main', detached: false },
      { path: FEATURE, head: 'bbbbbbbbbbbb', branch: 'refs/heads/feature', detached: false }] });
    if (command === 'files.list') {
      const entries = LISTS[tree]?.[request.path ?? ''];
      return entries ? ok({ worktree: tree, path: request.path ?? '', entries }) : fail('Not a directory');
    }
    if (command === 'files.changes') return ok({ worktree: tree, entries: Object.values(LISTS[tree] ?? {}).flat().filter(entry => entry.kind === 'file' && entry.changed).map(entry => ({ ...entry, status: '.M', staged: false, unstaged: true, additions: 1, deletions: 1 })) });
    if (command === 'files.diff') return ok({ path: request.path, state: 'text', diff: `diff --git a/${request.path} b/${request.path}\n--- a/${request.path}\n+++ b/${request.path}\n@@ -1 +1 @@\n-old\n+new\n` });
    if (command === 'files.read') {
      const result = FILES[request.path ?? ''];
      return result && result.worktree === tree ? ok(result) : fail('File is not visible in project');
    }
    return fail('Unknown files command');
  }) };
}
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function createTarget() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { projects: [{ id: 'repo-id', root_path: ROOT, display_name: 'repo', state: 'registered' }] } });
  target.setConnection('connected');
  return target;
}
// 選択中のプロジェクトの下で木を開く。
function setup(search = '', width = 1280) {
  localStorage.setItem('agent-graph-files-open', JSON.stringify({ 'repo-id': width > 1024 }));
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const target = createTarget();
  const client = createClient();
  render(<MemoryRouter initialEntries={[`/p/${encodeURIComponent(ROOT)}${search.includes('path=') ? '/files' : ''}${search}`]}><App target={target} client={client}/><Location/></MemoryRouter>);
  return { client, target };
}
const tree = () => screen.getByRole('tree', { name: 'Files' });
const item = (name: string | RegExp) => within(tree()).getByRole('treeitem', { name: typeof name === 'string' ? new RegExp(`^${name.replace(/[.]/g, '\\.')}(,|$)`) : name });
const names = () => within(tree()).queryAllByRole('treeitem').map(element => element.getAttribute('aria-label')!.split(',')[0]);
const calls = (client: ReturnType<typeof createClient>, command: string) => client.command.mock.calls.filter(call => call[0] === command).map(call => call[1]);
const row = (element: HTMLElement) => element.querySelector<HTMLElement>(':scope > .tree-row')!;
const location = () => screen.getByTestId('location').textContent;

describe('Files explorer', () => {
  it('renders the first level with folders, files, icons and tree roles for the resolved project id', async () => {
    const { client } = setup();
    await screen.findByRole('tree', { name: 'Files' });
    expect(names()).toEqual(['docs', 'src', 'README.md', 'added.ts', 'gone.txt', 'moved.py', 'notes.txt']);
    expect(calls(client, 'files.list')).toEqual([{ projectId: 'repo-id' }]);
    const src = item('src');
    expect(src.getAttribute('aria-expanded')).toBe('false');
    expect(src.getAttribute('aria-level')).toBe('1');
    expect(src.getAttribute('aria-setsize')).toBe('7');
    expect(src.getAttribute('aria-posinset')).toBe('2');
    expect(item('README.md').getAttribute('aria-expanded')).toBeNull();
    expect(row(src).querySelector('.tree-icon')).toBeTruthy();
    expect(src.tabIndex).toBe(-1);
    expect(item('docs').tabIndex).toBe(0);
    // 木は選択したプロジェクトの行の下に置く。
    expect(screen.queryByRole('link', { name: 'Files' })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Project' })).getAllByRole('link').map(link => link.textContent)).toEqual(['Conversations', 'Changes']);
    expect(screen.queryByRole('region', { name: 'File viewer' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Conversations' })).toBeTruthy();
    const projectRow = screen.getByRole('link', { name: 'repo' }).closest('.sidebar-project')!;
    expect(projectRow.querySelector('[role="tree"]')).toBe(tree());
    expect(projectRow.firstElementChild?.className).toBe('sidebar-project-row');
    expect(document.querySelector('.workspace-files')).toBeNull();
    expect(document.querySelector('.workspace-columns')?.children).toHaveLength(2);
    expect(document.querySelector('.workspace-columns > .workspace-conversation')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Sub-agents' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull();
  });

  it('collapses the sidebar tree at 1024 pixels and opens it on request', async () => {
    const { client } = setup('', 1024);
    expect(screen.queryByRole('tree', { name: 'Files' })).toBeNull();
    expect(calls(client, 'files.list')).toEqual([]);
    const columns = document.querySelector('.workspace-columns')!;
    expect(columns.firstElementChild!.className).toBe('workspace-conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle files for repo' }));
    await screen.findByRole('tree', { name: 'Files' });
    expect(names()).toContain('README.md');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle files for repo' }));
    expect(screen.queryByRole('tree', { name: 'Files' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Toggle files for repo' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a file deep link with the sidebar collapsed and returns to the workspace', async () => {
    setup('?path=README.md', 1024);
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    expect(await screen.findByRole('region', { name: 'Contents of README.md' })).toBeTruthy();
    expect(screen.queryByRole('tree', { name: 'Files' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('region', { name: 'File viewer' })).toBeNull();
    expect(location()).toBe(`/p/${encodeURIComponent(ROOT)}`);
  });

  it('keeps the Files route and renders the file in the central area', async () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const client = createClient();
    render(<MemoryRouter initialEntries={[`/p/repo/files?path=README.md`]}><App target={createTarget()} client={client}/><Location/></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    expect(await screen.findByRole('region', { name: 'Contents of README.md' })).toBeTruthy();
    expect(location()).toBe('/p/repo/files?path=README.md');
    expect(document.querySelector('main .explorer-viewer')).toBeTruthy();
    expect(calls(client, 'files.read')).toEqual([{ projectId: 'repo-id', path: 'README.md' }]);
  });

  it('opens only the selected project tree and returns from files to the original screen', async () => {
    const { target } = setup();
    await screen.findByRole('tree');
    act(() => target.setSnapshot({ seq: 2, generation: 1, projection: {
      projects: [
        { id: 'repo-id', root_path: ROOT, display_name: 'repo', state: 'registered' },
        { id: 'other-id', root_path: '/other', display_name: 'second', state: 'registered' },
      ],
    } }));
    const second = screen.getByRole('link', { name: 'second' }).closest('.sidebar-project')!;
    expect(second.querySelector('[role="tree"]')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Search' }));
    expect(screen.getByRole('heading', { name: 'Search' })).toBeTruthy();
    fireEvent.click(row(item('README.md')));
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    expect(await screen.findByRole('region', { name: 'Contents of README.md' })).toBeTruthy();
    expect(document.querySelector('main .explorer-viewer')).toBeTruthy();
    fireEvent.click(row(item('src')));
    await within(item('src')).findByRole('treeitem', { name: /^main\.ts/ });
    fireEvent.click(row(item('main.ts')));
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    await screen.findByRole('region', { name: 'Contents of src/main.ts' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(location()).toBe('/search');
    expect(screen.getByRole('heading', { name: 'Search' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle files for second' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'repo' }).closest('.sidebar-project')!.querySelector('[role="tree"]')).toBeNull());
    expect(screen.getByRole('button', { name: 'Toggle files for second' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('loads each level only when a folder is expanded and hides it again on collapse', async () => {
    const { client } = setup();
    await screen.findByRole('tree');
    fireEvent.click(row(item('src')));
    await waitFor(() => expect(item('src').getAttribute('aria-expanded')).toBe('true'));
    await within(item('src')).findByRole('treeitem', { name: /^main\.ts/ });
    expect(calls(client, 'files.list')).toEqual([{ projectId: 'repo-id' }, { projectId: 'repo-id', path: 'src' }]);
    expect(item('lib').getAttribute('aria-level')).toBe('2');
    expect(within(item('src')).getByRole('group')).toBeTruthy();
    expect(within(tree()).queryByRole('treeitem', { name: /^util\.ts/ })).toBeNull();
    fireEvent.click(row(item('lib')));
    await within(item('lib')).findByRole('treeitem', { name: /^util\.ts/ });
    expect(item('util.ts').getAttribute('aria-level')).toBe('3');
    expect(calls(client, 'files.list').at(-1)).toEqual({ projectId: 'repo-id', path: 'src/lib' });
    fireEvent.click(row(item('src')));
    expect(item('src').getAttribute('aria-expanded')).toBe('false');
    expect(within(tree()).queryByRole('treeitem', { name: /^main\.ts/ })).toBeNull();
    fireEvent.click(row(item('src')));
    expect(await within(item('src')).findByRole('treeitem', { name: /^main\.ts/ })).toBeTruthy();
    expect(calls(client, 'files.list')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await within(await screen.findByRole('treeitem', { name: /^src/ })).findByRole('treeitem', { name: /^util\.ts/ })).toBeTruthy();
    expect(calls(client, 'files.list').slice(3).map(request => (request as { path?: string }).path ?? '').sort()).toEqual(['', 'src', 'src/lib']);
  });

  it('filters by name across opened folders, keeps matching ancestors and highlights the match', async () => {
    setup();
    await screen.findByRole('tree');
    fireEvent.click(row(item('src')));
    await within(item('src')).findByRole('treeitem', { name: /^main\.ts/ });
    const filter = screen.getByRole('searchbox', { name: 'Filter files by name' });
    fireEvent.change(filter, { target: { value: 'MAIN' } });
    expect(names()).toEqual(['src', 'main.ts']);
    expect(row(item('main.ts')).querySelector('mark')?.textContent).toBe('main');
    fireEvent.change(filter, { target: { value: 'read' } });
    expect(names()).toEqual(['README.md']);
    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByText('No matching names in opened folders')).toBeTruthy();
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(names()).toHaveLength(11);
  });

  it('shows git marks with colours, deleted and renamed files and a dot on folders with changes', async () => {
    setup();
    await screen.findByRole('tree');
    const marks: [string, string, string][] = [['README.md', 'modified', 'M'], ['added.ts', 'added', 'A'], ['notes.txt', 'untracked', 'U'], ['gone.txt', 'deleted', 'D'], ['moved.py', 'renamed', 'R']];
    for (const [name, mark, letter] of marks) {
      const element = item(name);
      expect(element.getAttribute('aria-label')).toBe(`${name}, ${mark}`);
      expect(row(element).className).toContain(`git-${mark}`);
      expect(row(element).querySelector(`.git-letter.git-${mark}`)?.textContent).toBe(letter);
    }
    expect(row(item('moved.py')).textContent).toContain('← old.py');
    expect(row(item('moved.py')).getAttribute('title')).toBe('moved.py (renamed from old.py)');
    expect(item('src').getAttribute('aria-label')).toBe('src, contains changes');
    expect(row(item('src')).querySelector('.tree-changed')).toBeTruthy();
    expect(row(item('docs')).querySelector('.tree-changed')).toBeNull();
    fireEvent.click(row(item('gone.txt')));
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    expect(await screen.findByText('Deleted file')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'File viewer' })).getByRole('link', { name: /View changes/ }).getAttribute('href')).toBe(`/p/${encodeURIComponent(ROOT)}/changes`);
  });

  it('opens a file with line numbers and syntax colours and keeps the path in the address', async () => {
    const { client } = setup();
    await screen.findByRole('tree');
    fireEvent.click(row(item('README.md')));
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    await screen.findByRole('region', { name: 'Contents of README.md' });
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    const view = screen.getByRole('region', { name: 'Contents of README.md' });
    expect(calls(client, 'files.read')).toEqual([{ projectId: 'repo-id', path: 'README.md' }]);
    expect([...view.querySelectorAll('.code-line-number')].map(cell => cell.textContent)).toEqual(['1', '2', '3']);
    expect(view.querySelector('.tok-heading')?.textContent).toBe('# Title');
    expect(view.querySelector('.tok-code')?.textContent).toBe('`code`');
    expect(item('README.md').getAttribute('aria-selected')).toBe('true');
    expect(location()).toBe(`/p/${encodeURIComponent(ROOT)}/files?path=README.md`);
    const viewer = screen.getByRole('region', { name: 'File viewer' });
    expect(within(viewer).getByText('Markdown')).toBeTruthy();
    expect(within(viewer).getByText('3 lines')).toBeTruthy();
    expect(within(viewer).getByText('Modified')).toBeTruthy();
  });

  it('formats Markdown by default and switches to the raw text with Raw', async () => {
    setup('?path=README.md');
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    const view = await screen.findByRole('region', { name: 'Contents of README.md' });
    const group = screen.getByRole('group', { name: 'Markdown view' });
    expect(within(group).getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(view).getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(view.querySelector('.md-inline-code')?.textContent).toBe('code');
    expect(view.querySelector('.code-line-number')).toBeNull();
    expect(view.textContent).not.toContain('# Title');
    fireEvent.click(within(group).getByRole('button', { name: 'Raw' }));
    expect(within(group).getByRole('button', { name: 'Raw' }).getAttribute('aria-pressed')).toBe('true');
    const raw = screen.getByRole('region', { name: 'Contents of README.md' });
    expect(raw.querySelector('.tok-heading')?.textContent).toBe('# Title');
    expect(within(raw).queryByRole('heading')).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Preview' }));
    expect(within(screen.getByRole('region', { name: 'Contents of README.md' })).getByRole('heading', { name: 'Title' })).toBeTruthy();
  });

  it('shows other text files as code without the Markdown switch', async () => {
    setup('?path=src%2Fmain.ts');
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    await screen.findByRole('region', { name: 'Contents of src/main.ts' });
    expect(screen.queryByRole('group', { name: 'Markdown view' })).toBeNull();
  });

  it('expands ancestors for a deep link and colours TypeScript', async () => {
    setup('?path=src%2Fmain.ts');
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    const view = await screen.findByRole('region', { name: 'Contents of src/main.ts' });
    expect(item('src').getAttribute('aria-expanded')).toBe('true');
    expect(item('main.ts').getAttribute('aria-selected')).toBe('true');
    expect(item('main.ts').tabIndex).toBe(0);
    const tokens = (type: string) => [...view.querySelectorAll(`.tok-${type}`)].map(element => element.textContent);
    expect(tokens('keyword')).toEqual(['const', 'export', 'function', 'return']);
    expect(tokens('number')).toEqual(['42']);
    expect(tokens('comment')).toEqual(['// note']);
    expect(tokens('string')).toEqual(['"ok"']);
    expect(tokens('function')).toEqual(['run']);
  });

  it('shows binary and too large files with their sizes instead of content', async () => {
    setup('?path=src%2Flogo.png');
    expect(await screen.findByText('Binary file')).toBeTruthy();
    expect(screen.getByText('Size: 2.0 KiB (2,048 bytes)')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Contents of/ })).toBeNull();
    fireEvent.click(row(item('huge.log')));
    expect(await screen.findByText('File too large to display')).toBeTruthy();
    expect(screen.getByText('Size: 1.5 MiB (1,572,864 bytes)')).toBeTruthy();
    expect(screen.getByText('Files over 1.0 MiB are not shown.')).toBeTruthy();
  });

  it('moves through the tree with the keyboard', async () => {
    setup();
    await screen.findByRole('tree');
    const focused = () => document.activeElement?.getAttribute('aria-label')?.split(',')[0];
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    act(() => item('docs').focus());
    press('ArrowDown');
    expect(focused()).toBe('src');
    expect(item('src').tabIndex).toBe(0);
    expect(item('docs').tabIndex).toBe(-1);
    press('ArrowRight');
    await within(item('src')).findByRole('treeitem', { name: /^main\.ts/ });
    expect(item('src').getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('src');
    press('ArrowRight');
    expect(focused()).toBe('lib');
    press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
    expect(focused()).toBe('main.ts');
    press('ArrowLeft');
    expect(focused()).toBe('src');
    press('ArrowLeft');
    expect(item('src').getAttribute('aria-expanded')).toBe('false');
    press('ArrowUp');
    expect(focused()).toBe('docs');
    press('End');
    expect(focused()).toBe('notes.txt');
    press('Home');
    expect(focused()).toBe('docs');
    press('Enter');
    await within(item('docs')).findByRole('treeitem', { name: /^guide\.md/ });
    press('ArrowRight');
    press('Enter');
    expect(await screen.findByRole('region', { name: 'Contents of docs/guide.md' })).toBeTruthy();
    expect(location()).toContain('path=docs%2Fguide.md');
    const filter = screen.getByRole('searchbox', { name: 'Filter files by name' });
    act(() => filter.focus());
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(focused()).toBe('guide.md');
  });

  it('switches worktrees and lists the selected tree', async () => {
    const { client } = setup('?path=README.md');
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    await screen.findByRole('region', { name: 'Contents of README.md' });
    const select = await screen.findByRole('combobox', { name: 'Worktree' });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['main · repo']);
    fireEvent.click(screen.getByRole('button', { name: 'Other worktrees · 1' }));
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['main · repo', 'feature · repo-feature']);
    expect((select as HTMLSelectElement).value).toBe(ROOT);
    fireEvent.change(select, { target: { value: FEATURE } });
    await waitFor(() => expect(names()).toEqual(['feature', 'feature.txt']));
    expect(calls(client, 'files.list')).toContainEqual({ projectId: 'repo-id', worktree: FEATURE });
    expect(location()).toContain(`worktree=${encodeURIComponent(FEATURE)}`);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Could not open README.md'));
    fireEvent.click(row(item('feature.txt')));
    fireEvent.click(await screen.findByRole('button', { name: 'File' }));
    expect(await screen.findByRole('region', { name: 'Contents of feature.txt' })).toBeTruthy();
    expect(calls(client, 'files.read').at(-1)).toEqual({ projectId: 'repo-id', path: 'feature.txt', worktree: FEATURE });
    expect((select as HTMLSelectElement).value).toBe(FEATURE);
  });

  it('opens the worktree that contains a run directory and warns about unknown worktrees', async () => {
    const { client } = setup(`?worktree=${encodeURIComponent(`${FEATURE}/feature`)}`);
    await waitFor(() => expect(names()).toEqual(['feature', 'feature.txt']));
    expect(calls(client, 'files.list')[0]).toEqual({ projectId: 'repo-id', worktree: FEATURE });
    cleanup();
    setup('?worktree=%2Felsewhere');
    expect(await screen.findByText(/is not part of this project/)).toBeTruthy();
    await waitFor(() => expect(names()).toContain('README.md'));
  });
});

describe('Changes links into Files', () => {
  it('links each diff file name to its position in Files with the run worktree', () => {
    const target = createStore();
    const patch = 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new\n';
    target.setSnapshot({ seq: 1, generation: 1, projection: {
      artifacts: [{ id: 'a1', run_id: 'r1', version: 1, repository_id: 'repo', patch_hash: 'h', attribution: 'confirmed', diff: patch }],
      runs: [{ id: 'r1', conversation_id: 'c1', cwd: FEATURE }] } });
    render(<MemoryRouter><ChangesPage target={target} client={{ command: vi.fn() }} project="repo"/></MemoryRouter>);
    // 差分からも中央のファイル表示へ移動する。
    const expected = `/p/repo/files?path=src%2Fmain.ts&worktree=${encodeURIComponent(FEATURE)}`;
    const links = screen.getAllByRole('link', { name: 'Open src/main.ts in Files' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute('href')).toBe(expected);
    expect(screen.queryByRole('link', { name: 'Files' })).toBeNull();
  });
});

describe('syntax colours', () => {
  const kinds = (source: string, path: string) => highlightLines(source, detectLanguage(path)).flat()
    .filter((token): token is Required<Token> => Boolean(token.type)).map(token => `${token.type}:${token.text}`);
  it.each([
    ['a.json', '{"key": "value", "n": 1.5, "ok": true}', ['key:"key"', 'string:"value"', 'key:"n"', 'number:1.5', 'key:"ok"', 'literal:true']],
    ['a.py', '@dec\ndef f(self):\n    return None  # done\n', ['meta:@dec', 'keyword:def', 'function:f', 'variable:self', 'keyword:return', 'literal:None', 'comment:# done']],
    ['a.sh', 'if [ "$NAME" ]; then echo ${HOME} # hi\nfi', ['keyword:if', 'string:"$NAME"', 'keyword:then', 'variable:${HOME}', 'comment:# hi', 'keyword:fi']],
    ['a.css', '.box { color: #fff; margin: 4px; }', ['tag:.box', 'key:color', 'number:#fff', 'key:margin', 'number:4px']],
    ['a.html', '<!-- c --><a href="x">t</a>', ['comment:<!-- c -->', 'tag:<a', 'attr:href', 'string:"x"', 'tag:>', 'tag:</a', 'tag:>']],
    ['a.toml', '[tool]\nname = "x" # c\ncount = 3\nflag = true', ['heading:[tool]', 'key:name', 'string:"x"', 'comment:# c', 'key:count', 'number:3', 'key:flag', 'literal:true']],
    ['a.yaml', '---\nkey: value\nlist:\n  - name: "x"\n    on: true # c', ['meta:---', 'key:key', 'key:list', 'key:name', 'string:"x"', 'key:on', 'literal:true', 'comment:# c']],
    ['a.md', '# Head\n- item **bold** [l](u)\n```\ncode\n```', ['heading:# Head', 'keyword:-', 'emphasis:**bold**', 'link:[l](u)', 'code:```', 'code:code', 'code:```']],
    ['a.tsx', 'const x = <Box size={1}/>;', ['keyword:const', 'tag:<Box', 'attr:size', 'number:1', 'tag:/>']],
    ['a.js', '/* a\nb */ let s = `t`;', ['comment:/* a', 'comment:b */', 'keyword:let', 'string:`t`']],
  ])('colours %s', (path, source, expected) => {
    expect(kinds(source, path)).toEqual(expected);
  });
  it('keeps unknown files plain and splits lines without a trailing empty line', () => {
    expect(detectLanguage('LICENSE')).toBeUndefined();
    expect(highlightLines('a\r\nb\n')).toEqual([[{ text: 'a' }], [{ text: 'b' }]]);
    expect(highlightLines('a\n\nb')).toEqual([[{ text: 'a' }], [], [{ text: 'b' }]]);
  });
});

it('defaults changed sidebar files to Diff and can switch to File', async () => {
  setup('?path=README.md');
  const diff = await screen.findByRole('table', { name: 'README.md unified diff' });
  expect(within(diff).getByText('new')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('region', { name: 'Contents of README.md' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'File' }));
  expect(await screen.findByRole('region', { name: 'Contents of README.md' })).toBeTruthy();
});
