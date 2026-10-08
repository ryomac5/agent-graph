import { callGit, FileGitDiff, type GitChange } from '../changes/GitChanges.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { AppLink } from '../../components/AppLink.tsx';
import { Icon } from '../../components/Icon.tsx';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { Markdown } from '../../components/conversation/Markdown.tsx';
import { detectLanguage, highlightLines, LANGUAGE_NAMES, type Language } from './highlight.ts';
import {
  ancestorPaths, formatSize, GIT_MARKS, listFiles, listWorktrees, matchWorktree, parentPath, primaryMark, readFile, resolveProjectId, worktreeName,
  type FileEntry, type FilesClient, type GitMark, type ReadResult, type WorktreesResult,
} from './model.ts';
import '../../components/activity.css';
import './highlight.css';
import './files.css';

/** これより大きい本文は色分けを省き、表示の重さを抑える。 */
export const HIGHLIGHT_LIMIT = 300_000;
type DirectoryState = { status: 'loading' } | { status: 'loaded'; entries: FileEntry[] } | { status: 'error'; error: string };
type FileState = { key: string; path: string } & ({ status: 'loading' } | { status: 'deleted' } | { status: 'directory' } | { status: 'loaded'; result: ReadResult } | { status: 'error'; error: string });
interface TreeRow { entry: FileEntry; depth: number; parent: string; open: boolean; setSize: number; position: number }
interface Keyed<T> { key: string; value: T }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const domId = (path: string) => `file-tree-${encodeURIComponent(path).replace(/[^\w-]/g, '_')}`;

function Highlighted({ name, query }: { name: string; query: string }) {
  const index = query ? name.toLowerCase().indexOf(query) : -1;
  if (index < 0) return <>{name}</>;
  return <>{name.slice(0, index)}<mark>{name.slice(index, index + query.length)}</mark>{name.slice(index + query.length)}</>;
}

function GitLetters({ git }: { git: GitMark[] }) {
  if (!git.length) return null;
  return <span className="git-marks" aria-hidden="true">{git.map(mark => <span key={mark} className={`git-letter git-${mark}`} title={GIT_MARKS[mark].label}>{GIT_MARKS[mark].letter}</span>)}</span>;
}

function CodeView({ path, content }: { path: string; content: string }) {
  const language = detectLanguage(path);
  const colored = content.length <= HIGHLIGHT_LIMIT ? language : undefined;
  const lines = useMemo(() => highlightLines(content, colored), [content, colored]);
  return <>
    {language && !colored && <p className="muted-text explorer-note">Syntax colors are off for files over {formatSize(HIGHLIGHT_LIMIT)}.</p>}
    <div className="code-view" role="region" aria-label={`Contents of ${path}`} tabIndex={0} data-language={colored ?? 'plain'}>
      <div className="code-lines">{lines.map((tokens, index) => <div className="code-row" key={index}>
        <span className="code-line-number" aria-hidden="true">{index + 1}</span>
        <code className="code-text">{tokens.length ? tokens.map((token, part) => token.type ? <span key={part} className={`tok tok-${token.type}`}>{token.text}</span> : token.text) : '\n'}</code>
      </div>)}</div>
    </div>
  </>;
}

/** Markdown は既定で整形して出し、Raw に切り替えると元の文字を色分けで出す。 */
function FileContent({ path, content }: { path: string; content: string }) {
  const [raw, setRaw] = useState(false);
  if (detectLanguage(path) !== 'md') return <CodeView path={path} content={content}/>;
  return <>
    <div className="viewer-mode" role="group" aria-label="Markdown view">
      <button type="button" className="viewer-mode-option" aria-pressed={!raw} onClick={() => setRaw(false)}>Preview</button>
      <button type="button" className="viewer-mode-option" aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
    </div>
    {raw ? <CodeView path={path} content={content}/>
      : <div className="markdown-view" role="region" aria-label={`Contents of ${path}`} tabIndex={0}>
        <Markdown text={content} breaks={false} className="markdown-document"/></div>}
  </>;
}

export type FileExplorer = ReturnType<typeof useFileExplorer>;
/**
 * プロジェクトの作業ツリーの木と、選んだファイルの中身を読む。サイドバーと中央の表示が同じ状態を共有する。
 * 選んだファイルと作業ツリーはアドレスの path と worktree に持ち、Changes からの移動でも同じ場所を開く。
 */
export function useFileExplorer({ client, target = store, project, enabled = true }: { client: FilesClient; target?: ScreenStore; project: string; enabled?: boolean }) {
  const state = useScreenStore(target);
  const projectId = resolveProjectId(state, project);
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedPath = location.pathname.endsWith('/files') ? search.get('path') ?? '' : '';
  const wantedWorktree = search.get('worktree') ?? '';
  const [revision, setRevision] = useState(0);
  const [trees, setTrees] = useState<Keyed<{ status: 'loading' } | { status: 'loaded'; result: WorktreesResult } | { status: 'error'; error: string }>>({ key: '', value: { status: 'loading' } });
  const treesKey = JSON.stringify([projectId, revision]);
  const worktrees = trees.key === treesKey ? trees.value : { status: 'loading' as const };

  useEffect(() => {
    // 畳んだ列では、開くまで作業ツリーとファイルを読まない。
    if (!enabled) return;
    let cancelled = false;
    listWorktrees(client, { projectId }).then(result => { if (!cancelled) setTrees({ key: treesKey, value: { status: 'loaded', result } }); },
      error => { if (!cancelled) setTrees({ key: treesKey, value: { status: 'error', error: message(error) } }); });
    return () => { cancelled = true; };
  }, [client, projectId, treesKey, enabled]);

  // 選んだ作業ツリーは一覧と照らしてから使う。実行の場所が作業ツリーの下でも、その作業ツリーを開く。
  const matched = wantedWorktree && worktrees.status === 'loaded' ? matchWorktree(worktrees.result.worktrees, wantedWorktree) : undefined;
  const ready = enabled && (!wantedWorktree || worktrees.status !== 'loading');
  const worktree = !wantedWorktree ? undefined : worktrees.status === 'error' ? wantedWorktree : matched?.path;
  const unknownWorktree = Boolean(wantedWorktree && worktrees.status === 'loaded' && !matched);
  const treeKey = JSON.stringify([projectId, worktree ?? '', revision]);
  // 開いたフォルダは更新の後も保つ。
  const expandKey = JSON.stringify([projectId, worktree ?? '']);

  const [directories, setDirectories] = useState<Keyed<Record<string, DirectoryState>>>({ key: '', value: {} });
  const [expandedState, setExpandedState] = useState<Keyed<Set<string>>>({ key: '', value: new Set() });
  const [query, setQuery] = useState('');
  const [filterClosed, setFilterClosed] = useState<Keyed<Set<string>>>({ key: '', value: new Set() });
  const [focusedPath, setFocusedPath] = useState('');
  const [file, setFile] = useState<FileState>();
  const cache = useRef(new Map<string, Promise<FileEntry[]>>());
  const items = useRef(new Map<string, HTMLLIElement>());
  const dirs = directories.key === treeKey ? directories.value : {};
  const expanded = expandedState.key === expandKey ? expandedState.value : new Set<string>();
  const needle = query.trim().toLowerCase();
  const closedInFilter = filterClosed.key === needle ? filterClosed.value : new Set<string>();

  const setDirectory = useCallback((key: string, path: string, value: DirectoryState) => setDirectories(previous =>
    ({ key, value: { ...(previous.key === key ? previous.value : {}), [path]: value } })), []);
  const changeExpanded = useCallback((key: string, change: (set: Set<string>) => void) => setExpandedState(previous => {
    const next = new Set(previous.key === key ? previous.value : []);
    change(next);
    return { key, value: next };
  }), []);
  const load = useCallback((path: string) => {
    const id = JSON.stringify([treeKey, path]);
    const cached = cache.current.get(id);
    if (cached) return cached;
    setDirectory(treeKey, path, { status: 'loading' });
    const promise = listFiles(client, { projectId, path, worktree }).then(result => {
      setDirectory(treeKey, path, { status: 'loaded', entries: result.entries });
      return result.entries;
    }, error => {
      cache.current.delete(id);
      setDirectory(treeKey, path, { status: 'error', error: message(error) });
      throw error;
    });
    cache.current.set(id, promise);
    return promise;
  }, [client, projectId, worktree, treeKey, setDirectory]);

  useEffect(() => { if (ready) load('').catch(() => undefined); }, [ready, load]);
  useEffect(() => {
    if (ready && expandedState.key === expandKey) for (const path of expandedState.value) load(path).catch(() => undefined);
  }, [ready, load, expandedState, expandKey]);

  // 指定のパスまで親を順に開き、ファイルなら読む。
  useEffect(() => {
    if (!ready || !selectedPath) return;
    let cancelled = false;
    const key = treeKey;
    const expanding = expandKey;
    const path = selectedPath;
    (async () => {
      const ancestors = ancestorPaths(path);
      for (const directory of ['', ...ancestors]) { await load(directory); if (cancelled) return; }
      changeExpanded(expanding, set => ancestors.forEach(directory => set.add(directory)));
      const entry = (await load(parentPath(path))).find(item => item.path === path);
      if (cancelled) return;
      setFocusedPath(path);
      if (entry?.kind === 'directory') {
        changeExpanded(expanding, set => set.add(path));
        load(path).catch(() => undefined);
        setFile({ key, path, status: 'directory' });
        return;
      }
      if (entry?.git.includes('deleted')) { setFile({ key, path, status: 'deleted' }); return; }
      setFile({ key, path, status: 'loading' });
      const result = await readFile(client, { projectId, path, worktree });
      if (!cancelled) setFile({ key, path, status: 'loaded', result });
    })().catch(error => { if (!cancelled) setFile({ key, path, status: 'error', error: message(error) }); });
    return () => { cancelled = true; };
  }, [client, projectId, worktree, treeKey, expandKey, ready, selectedPath, load, changeExpanded]);

  const scrolled = useRef('');
  useEffect(() => {
    const element = selectedPath && selectedPath !== scrolled.current ? items.current.get(selectedPath) : undefined;
    if (!element) return;
    scrolled.current = selectedPath;
    element.querySelector('.tree-row')?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedPath, directories]);

  const hasMatch = useMemo(() => {
    const memo = new Map<string, boolean>();
    const visit = (path: string): boolean => {
      if (memo.has(path)) return memo.get(path)!;
      const directory = dirs[path];
      const found = directory?.status === 'loaded' && directory.entries.some(entry => entry.name.toLowerCase().includes(needle) || (entry.kind === 'directory' && visit(entry.path)));
      memo.set(path, found);
      return found;
    };
    return visit;
  }, [dirs, needle]);
  const childrenOf = useCallback((path: string): FileEntry[] => {
    const directory = dirs[path];
    const entries = directory?.status === 'loaded' ? directory.entries : [];
    return needle ? entries.filter(entry => entry.name.toLowerCase().includes(needle) || (entry.kind === 'directory' && hasMatch(entry.path))) : entries;
  }, [dirs, needle, hasMatch]);
  const isOpen = useCallback((entry: FileEntry) => entry.kind === 'directory'
    && (needle && hasMatch(entry.path) ? !closedInFilter.has(entry.path) : expanded.has(entry.path)), [needle, hasMatch, closedInFilter, expanded]);
  const rows = useMemo(() => {
    const result: TreeRow[] = [];
    const walk = (path: string, depth: number) => {
      const list = childrenOf(path);
      list.forEach((entry, index) => {
        const open = isOpen(entry);
        result.push({ entry, depth, parent: path, open, setSize: list.length, position: index + 1 });
        if (open) walk(entry.path, depth + 1);
      });
    };
    walk('', 1);
    return result;
  }, [childrenOf, isOpen]);
  const current = rows.some(row => row.entry.path === focusedPath) ? focusedPath : rows[0]?.entry.path ?? '';

  function setParams(change: (next: URLSearchParams) => void) {
    setSearch(previous => { const next = new URLSearchParams(previous); change(next); return next; }, { replace: true });
  }
  function expand(entry: FileEntry) {
    if (needle && hasMatch(entry.path)) setFilterClosed(previous => { const next = new Set(previous.key === needle ? previous.value : []); next.delete(entry.path); return { key: needle, value: next }; });
    changeExpanded(expandKey, set => set.add(entry.path));
    load(entry.path).catch(() => undefined);
  }
  function collapse(entry: FileEntry) {
    if (needle && hasMatch(entry.path)) setFilterClosed(previous => { const next = new Set(previous.key === needle ? previous.value : []); next.add(entry.path); return { key: needle, value: next }; });
    changeExpanded(expandKey, set => set.delete(entry.path));
  }
  function activate(row: TreeRow) {
    setFocusedPath(row.entry.path);
    if (row.entry.kind === 'directory') { if (row.open) collapse(row.entry); else expand(row.entry); }
    else {
      const next = new URLSearchParams();
      next.set('path', row.entry.path);
      if (wantedWorktree) next.set('worktree', wantedWorktree);
      navigate(`/p/${encodeURIComponent(project)}/files?${next}`, {
        replace: location.pathname.endsWith('/files'),
        state: location.pathname.endsWith('/files') ? location.state : { returnTo: location.pathname + location.search },
      });
    }
  }
  function move(row?: TreeRow, focus = true) {
    if (!row) return;
    setFocusedPath(row.entry.path);
    if (focus) items.current.get(row.entry.path)?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const index = rows.findIndex(row => row.entry.path === current);
    const row = rows[index];
    if (!row) return;
    switch (event.key) {
      case 'ArrowDown': move(rows[index + 1]); break;
      case 'ArrowUp': move(rows[index - 1]); break;
      case 'Home': move(rows[0]); break;
      case 'End': move(rows.at(-1)); break;
      case 'ArrowRight':
        if (row.entry.kind !== 'directory') return;
        if (!row.open) expand(row.entry);
        else if (rows[index + 1]?.parent === row.entry.path) move(rows[index + 1]);
        break;
      case 'ArrowLeft':
        if (row.open) collapse(row.entry);
        else move(rows.find(item => item.entry.path === row.parent));
        break;
      case 'Enter': case ' ': activate(row); break;
      default: return;
    }
    event.preventDefault();
  }

  const root = dirs[''];
  const shown = file && file.key === treeKey && file.path === selectedPath ? file : undefined;
  const selectedEntry = rows.find(row => row.entry.path === selectedPath)?.entry
    ?? (dirs[parentPath(selectedPath)]?.status === 'loaded' ? (dirs[parentPath(selectedPath)] as { entries: FileEntry[] }).entries.find(entry => entry.path === selectedPath) : undefined);
  const worktreeValue = worktree ?? (worktrees.status === 'loaded' ? worktrees.result.worktree : '');
  const offline = state.connection === 'connecting' || state.connection === 'reconnecting';
  return { client, revision, worktree, project, projectId, dirs, rows, current, needle, query, setQuery, selectedPath, selectedEntry, shown, root, worktrees, worktreeValue,
    wantedWorktree, unknownWorktree, offline, items, onKeyDown, activate, move, setParams,
    selectWorktree: (value: string) => setParams(next => next.set('worktree', value)),
    closeFile: () => { if (location.key !== 'default') navigate(-1); else navigate(`/p/${encodeURIComponent(project)}`); },
    refresh: () => { cache.current.clear(); setRevision(value => value + 1); } };
}

function TreeLevel({ explorer, path }: { explorer: FileExplorer; path: string }): ReactNode {
  const { rows, dirs, selectedPath, current, needle, items, activate, move } = explorer;
  return rows.filter(row => row.parent === path).map(row => {
    const { entry } = row;
    const directory = dirs[entry.path];
    const mark = primaryMark(entry.git);
    const label = [entry.name, ...entry.git.map(item => GIT_MARKS[item].label.toLowerCase()), entry.kind === 'directory' && entry.changed ? 'contains changes' : '']
      .filter(Boolean).join(', ');
    return <li key={entry.path} role="treeitem" id={domId(entry.path)} aria-label={label} aria-level={row.depth} aria-setsize={row.setSize} aria-posinset={row.position}
      aria-expanded={entry.kind === 'directory' ? row.open : undefined} aria-selected={entry.kind === 'file' ? entry.path === selectedPath : undefined}
      tabIndex={entry.path === current ? 0 : -1} data-path={entry.path}
      ref={element => { if (element) items.current.set(entry.path, element); else items.current.delete(entry.path); }}
      onFocus={event => { if (event.target === event.currentTarget) move(row, false); }}>
      <div className={`tree-row${entry.path === selectedPath ? ' is-selected' : ''}${mark ? ` git-${mark}` : ''}`} style={{ paddingLeft: `calc(var(--space-2) + ${row.depth - 1} * 14px)` }}
        title={entry.previousPath ? `${entry.path} (renamed from ${entry.previousPath})` : entry.path} onClick={() => activate(row)}>
        {entry.kind === 'directory' ? <Icon className="tree-chevron" name={row.open ? 'chevronDown' : 'chevronRight'} size={12}/> : <span className="tree-chevron"/>}
        <Icon className="tree-icon" name={entry.kind === 'directory' ? (row.open ? 'folderOpen' : 'folder') : 'file'} size={15}/>
        <span className="tree-name truncate"><Highlighted name={entry.name} query={needle}/></span>
        {entry.previousPath && <span className="tree-previous truncate">← {entry.previousPath.split('/').at(-1)}</span>}
        {entry.kind === 'directory' ? entry.changed && <span className="tree-changed" title="Contains changes" aria-hidden="true"/> : <GitLetters git={entry.git}/>}
      </div>
      {row.open && <ul role="group">
        <TreeLevel explorer={explorer} path={entry.path}/>
        {directory?.status === 'loading' && <li role="none" className="tree-status" style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * 14px + 20px)` }}>Loading…</li>}
        {directory?.status === 'error' && <li role="none" className="tree-status tree-error" style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * 14px + 20px)` }}>{directory.error}</li>}
        {directory?.status === 'loaded' && !directory.entries.length && <li role="none" className="tree-status" style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * 14px + 20px)` }}>Empty folder</li>}
      </ul>}
    </li>;
  });
}

/** 作業ツリーの選択と、名前の絞り込みと、ファイルの木。サイドバーのプロジェクトの下に置く。 */
export function FileTreePanel({ explorer, actions }: { explorer: FileExplorer; actions?: ReactNode }) {
  const { worktrees, worktreeValue, root, rows, needle, query, setQuery, current, move, onKeyDown } = explorer;
  return <section className="explorer-tree" aria-label="Explorer">
    <header className="column-header explorer-header"><h2>Files</h2><span className="spacer"/>
      <button className="icon-button" aria-label="Refresh" title="Refresh" onClick={explorer.refresh}><Icon name="clock" size={14}/></button>
      {actions}</header>
    <div className="explorer-worktree-row"><Icon name="branch" size={14}/>
      <select className="select-sm explorer-worktree" aria-label="Worktree" value={worktreeValue} disabled={worktrees.status !== 'loaded'}
        onChange={event => explorer.selectWorktree(event.target.value)}>
        {worktrees.status === 'loaded' ? worktrees.result.worktrees.map(tree => <option key={tree.path} value={tree.path} title={tree.path}>{worktreeName(tree)}</option>)
          : <option value={worktreeValue}>{worktrees.status === 'loading' ? 'Loading worktrees…' : 'Project root'}</option>}
      </select></div>
    <div className="explorer-filter"><Icon name="filter" size={14}/>
      <input className="input-sm" type="search" placeholder="Filter by name" aria-label="Filter files by name" value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') setQuery('');
          else if (event.key === 'ArrowDown' && rows.length) { event.preventDefault(); move(rows.find(row => row.entry.path === current) ?? rows[0]); }
        }}/></div>
    {needle && <p className="explorer-hint muted-text">Matches in opened folders</p>}
    <div className="explorer-scroll">
      {root?.status === 'error' ? <p role="alert" className="banner banner-danger explorer-inline"><Icon name="alert" size={14}/>{root.error}</p>
        : !root || root.status === 'loading' ? <p className="tree-status" role="status">Loading files…</p>
          : !rows.length ? <p className="tree-status">{needle ? 'No matching names in opened folders' : 'No files'}</p>
            : <ul role="tree" aria-label="Files" className="file-tree" onKeyDown={onKeyDown}><TreeLevel explorer={explorer} path=""/></ul>}
    </div>
  </section>;
}

/** 作業ツリーの欠落と接続待ちを知らせる。 */
export function FileNotices({ explorer }: { explorer: FileExplorer }) {
  const { offline, unknownWorktree, wantedWorktree, worktrees } = explorer;
  if (!offline && !unknownWorktree && worktrees.status !== 'error') return null;
  return <div className="workspace-notices">
    {offline && <p role="status" className="banner banner-unknown"><Icon name="unknown" size={14}/>Waiting for the connection. File requests are sent once connected.</p>}
    {unknownWorktree && <p role="alert" className="banner banner-warning"><Icon name="alert" size={14}/>Worktree {wantedWorktree} is not part of this project. Showing the project root.</p>}
    {worktrees.status === 'error' && <p role="alert" className="banner banner-danger"><Icon name="alert" size={14}/>Worktrees unavailable: {worktrees.error}</p>}
  </div>;
}

/** 選んだファイルの中身。作業場の中央に、会話の代わりに出す。 */
export function FileViewerPanel({ explorer, actions }: { explorer: FileExplorer; actions?: ReactNode }) {
  const { selectedPath, selectedEntry, shown, project } = explorer;
  const [view, setView] = useState<'diff' | 'file'>('diff');
  const [change, setChange] = useState<GitChange>();
  const [diffError, setDiffError] = useState('');
  const changed = selectedEntry?.kind === 'file' && selectedEntry.changed;
  useEffect(() => {
    let cancelled = false; setView('diff'); setChange(undefined); setDiffError('');
    if (changed) callGit<{ entries: GitChange[] }>(explorer.client, 'files.changes', { projectId: explorer.projectId, ...(explorer.worktree ? { worktree: explorer.worktree } : {}) }).then(result => {
      if (!cancelled) setChange(result.entries.find(entry => entry.path === selectedPath));
    }, error => { if (!cancelled) setDiffError(String(error.message ?? error)); });
    return () => { cancelled = true; };
  }, [explorer.client, explorer.projectId, explorer.worktree, explorer.revision, selectedPath, changed]);
  const prefix = `/p/${encodeURIComponent(project)}`;
  const language: Language | undefined = detectLanguage(selectedPath);
  const lineCount = shown?.status === 'loaded' && shown.result.state === 'text' ? highlightLineCount(shown.result.content) : undefined;
  return <section className="explorer-viewer" aria-label="File viewer">
    {!selectedPath ? <div className="empty-state"><Icon name="file" size={22}/><h2>No file selected</h2><p>Choose a file in the tree to view its contents.</p></div> : <>
      <header className="viewer-header">
        <nav className="viewer-path" aria-label="File path">{selectedPath.split('/').map((part, index, parts) => <span key={index} className={index === parts.length - 1 ? 'viewer-path-current' : undefined}>{part}</span>)}</nav>
        <div className="viewer-meta">
          {selectedEntry && selectedEntry.git.map(mark => <span key={mark} className={`chip git-chip git-${mark}`}>{GIT_MARKS[mark].label}</span>)}
          {selectedEntry?.previousPath && <span className="chip" title={selectedEntry.previousPath}>From {selectedEntry.previousPath}</span>}
          {shown?.status === 'loaded' && shown.result.state === 'text' && language && <span className="chip">{LANGUAGE_NAMES[language]}</span>}
          {lineCount !== undefined && <span className="chip numeric">{lineCount} {lineCount === 1 ? 'line' : 'lines'}</span>}
          {shown?.status === 'loaded' && <span className="chip numeric">{formatSize(shown.result.size)}</span>}
          {actions}
        </div>
      </header>
      {changed && <div className="viewer-mode" role="group" aria-label="File view"><button className="viewer-mode-option" aria-pressed={view === 'diff'} onClick={() => setView('diff')}>Diff</button><button className="viewer-mode-option" aria-pressed={view === 'file'} onClick={() => setView('file')}>File</button></div>}
      {changed && view === 'diff' ? diffError ? <p role="alert">{diffError}</p> : change ? <FileGitDiff key={`${explorer.worktree}:${explorer.revision}:${selectedPath}`} client={explorer.client} request={{ projectId: explorer.projectId, path: selectedPath, ...(explorer.worktree ? { worktree: explorer.worktree } : {}) }} change={change}/> : <p>Loading diff…</p>
        : !shown || shown.status === 'loading' ? <p className="tree-status viewer-status" role="status">Loading {selectedPath}…</p>
        : shown.status === 'error' ? <p role="alert" className="banner banner-danger explorer-inline"><Icon name="alert" size={14}/>Could not open {selectedPath}: {shown.error}</p>
          : shown.status === 'directory' ? <div className="empty-state"><Icon name="folder" size={22}/><h2>Folder</h2><p>Choose a file inside {selectedPath} to view it.</p></div>
            : shown.status === 'deleted' ? <div className="empty-state"><Icon name="x" size={22}/><h2>Deleted file</h2><p>This file was deleted in the working tree.</p>
              <AppLink className="btn btn-secondary btn-sm" to={`${prefix}/changes`}><Icon name="diff" size={14}/>View changes</AppLink></div>
              : shown.result.state === 'binary' ? <div className="empty-state" role="status"><Icon name="file" size={22}/><h2>Binary file</h2><p>Binary content is not shown.</p>
                <p className="numeric">Size: {formatSize(shown.result.size)} ({shown.result.size.toLocaleString('en-US')} bytes)</p></div>
                : shown.result.state === 'too_large' ? <div className="empty-state" role="status"><Icon name="alert" size={22}/><h2>File too large to display</h2><p>Files over 1.0 MiB are not shown.</p>
                  <p className="numeric">Size: {formatSize(shown.result.size)} ({shown.result.size.toLocaleString('en-US')} bytes)</p></div>
                  : shown.result.content === '' ? <p className="tree-status viewer-status">Empty file</p>
                    : <FileContent key={selectedPath} path={selectedPath} content={shown.result.content}/>}
    </>}
  </section>;
}

function highlightLineCount(content: string): number {
  if (!content) return 0;
  const text = content.replace(/\r\n?/g, '\n');
  const count = text.split('\n').length;
  return text.endsWith('\n') ? count - 1 : count;
}
