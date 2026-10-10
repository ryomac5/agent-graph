import { FileTreeRow } from '../../components/FileTreeRow.tsx';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { buildRootTree, selectRoots, useRootIndex } from '../../lib/roots.ts';
import { conversationName } from '../../lib/format.ts';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { buildCommitGraph, type GraphRow } from './graph.ts';
import { formatWhen } from '../../lib/format.ts';
import { DiffView } from '../../components/diff/DiffView.tsx';
import { parseDiff, type DiffLayout } from '../../components/diff/model.ts';
import { GIT_MARKS, type FilesClient, type FilesRequest, type GitMark } from '../files/model.ts';

export interface GitChange { path: string; previousPath?: string; git: GitMark[]; status: string; staged: boolean; unstaged: boolean; additions: number; deletions: number; binary: boolean }
interface Commit { conversation_ids?: string[]; parents: string[]; branches: string[]; tags: string[]; hash: string; shortHash: string; subject: string; author: string; time: string; fileCount: number; additions: number; deletions: number }
interface Patch { additions?: number; deletions?: number; previousPath?: string; binary?: boolean; path: string; state: 'text' | 'too_large' | 'binary'; diff?: string }
const WORDS = {
  en: { filter: 'Filter by conversation', clearFilter: 'Clear conversation filter', noMatches: 'No commits for this conversation.', history: 'Git history', refresh: 'Refresh', working: 'Working tree', changed: 'changed files', files: 'files', loadingHistory: 'Loading history…',
    register: 'Register a project to view its Git changes.', noCommits: 'No commits yet.', loadingFiles: 'Loading files…', noFiles: 'No changed files.',
    clean: 'Working tree is clean.', difference: 'Difference', loadingDiff: 'Loading diff…', choose: 'Choose a file to view its diff.',
    staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', unified: 'Unified', split: 'Side by side' },
  ja: { filter: '会話で絞り込む', clearFilter: '会話の絞り込みを解除', noMatches: 'この会話のコミットはありません。', history: 'Git の履歴', refresh: '更新', working: '作業中の変更', changed: '件の変更', files: 'ファイル', loadingHistory: '履歴を読み込み中…',
    register: 'プロジェクトを登録すると、Git の変更を見られます。', noCommits: 'まだコミットはありません。', loadingFiles: 'ファイルを読み込み中…', noFiles: '変更したファイルはありません。',
    clean: '作業中の変更はありません。', difference: '差分', loadingDiff: '差分を読み込み中…', choose: 'ファイルを選ぶと差分を表示します。',
    staged: 'ステージ済み', unstaged: '未ステージ', untracked: '未追跡', unified: '1 列', split: '左右' },
} as const;
type Words = typeof WORDS.en | typeof WORDS.ja;
export async function callGit<T>(client: FilesClient, command: string, request: FilesRequest & { hash?: string; mode?: string }): Promise<T> {
  const ack = await client.command(command, request);
  if (!ack?.ok || !ack.result) throw new Error(ack?.error ?? 'Could not load Git changes');
  return ack.result as T;
}
export function GitPatch({ patch, layout }: { patch: Patch; layout: DiffLayout }) {
  const files = parseDiff(patch.diff ?? '').map(file => ({ ...file, path: patch.path }));
  return patch.state === 'too_large' ? <p>Diff exceeds 1.0 MiB and cannot be displayed.</p>
    : patch.state === 'binary' ? <p>Binary content is not shown.</p>
      : files.length ? <DiffView files={files} layout={layout} attribution="unknown" evidenceUrl="#git-changes"/>
        : <p>No changes in this diff.</p>;
}
export function FileGitDiff({ client, request, change, language = 'en', w = WORDS[language] }: { language?: 'en' | 'ja'; client: FilesClient; request: FilesRequest; change: Pick<GitChange, 'staged' | 'unstaged' | 'git'>; w?: Words }) {
  const modes = change.git.includes('untracked') ? ['untracked'] : [...(change.staged ? ['staged'] : []), ...(change.unstaged ? ['unstaged'] : [])];
  const [chosen, setChosen] = useState('');
  const mode = modes.includes(chosen) ? chosen : modes[0] ?? 'unstaged';
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const [patch, setPatch] = useState<Patch>();
  const [error, setError] = useState('');
  const key = JSON.stringify(request);
  useEffect(() => {
    let cancelled = false; setPatch(undefined); setError('');
    callGit<Patch>(client, 'files.diff', { ...request, mode }).then(value => { if (!cancelled) setPatch(value); }, error => { if (!cancelled) setError(String(error.message ?? error)); });
    return () => { cancelled = true; };
  }, [client, key, mode]);
  return <div className="git-diff-panel"><div className="toolbar changes-toolbar">
    <div className="button-row" role="group" aria-label="Change source">{modes.map(value => <button key={value} className="btn btn-secondary btn-sm" aria-pressed={mode === value} onClick={() => setChosen(value)}>{value === 'staged' ? w.staged : value === 'unstaged' ? w.unstaged : w.untracked}</button>)}</div>
    <Layout value={layout} onChange={setLayout} w={w}/></div>
    {error ? <p role="alert">{error}</p> : patch ? <GitPatch patch={patch} layout={layout}/> : <p>Loading diff…</p>}
  </div>;
}
function Layout({ value, onChange, w = WORDS.en }: { value: DiffLayout; onChange: (value: DiffLayout) => void; w?: Words }) {
  return <div className="button-row" role="group" aria-label="Diff layout">{(['unified', 'split'] as const).map(layout => <button key={layout} className="btn btn-secondary btn-sm" aria-pressed={value === layout} onClick={() => onChange(layout)}>{layout === 'unified' ? w.unified : w.split}</button>)}</div>;
}
interface TreeEntry { path: string; git: GitMark[]; additions: number; deletions: number }
function ChangeTree({ entries, selected, onSelect }: { entries: TreeEntry[]; selected: string; onSelect: (path: string) => void }) {
  function render(prefix: string, depth = 0) {
    const children = new Map<string, TreeEntry | undefined>();
    for (const entry of entries) if (entry.path.startsWith(prefix)) {
      const tail = entry.path.slice(prefix.length); const name = tail.split('/')[0];
      children.set(name, tail.includes('/') ? undefined : entry);
    }
    return <ul>{[...children].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => <li key={name}>{entry
      ? <button className="git-file-choice" aria-pressed={selected === entry.path} onClick={() => onSelect(entry.path)} title={entry.path}>
        <FileTreeRow depth={depth} selected={selected === entry.path}><span className="tree-name truncate">{name}</span><span className="git-file-meta">{entry.git.map(mark => <span key={mark} className={`git-${mark}`}>{GIT_MARKS[mark].letter}</span>)}<span className="diff-add-count">+{entry.additions}</span><span className="diff-remove-count">−{entry.deletions}</span></span></FileTreeRow></button>
      : <details open><summary><FileTreeRow depth={depth} directory><span className="tree-name truncate">{name}</span></FileTreeRow></summary>{render(`${prefix}${name}/`, depth + 1)}</details>}</li>)}</ul>;
  }
  return <nav aria-label="Changed files">{render('')}</nav>;
}
const GRAPH_ROW_HEIGHT = 44;
const GRAPH_LANE_WIDTH = 16;
function CommitLines({ row, columns }: { row: GraphRow; columns: number }) {
  const x = (lane: number) => 10 + lane * GRAPH_LANE_WIDTH;
  const middle = GRAPH_ROW_HEIGHT / 2;
  return <svg className="git-graph-lines" width={columns * GRAPH_LANE_WIDTH + 4} height={GRAPH_ROW_HEIGHT} aria-hidden="true">
    {row.segments.map((segment, index) => {
      const start = segment.half === 'top' ? 0 : middle;
      const end = segment.half === 'top' ? middle : GRAPH_ROW_HEIGHT;
      return <path key={index} className={`git-lane-${segment.lane % 3}`} d={`M ${x(segment.from)} ${start} C ${x(segment.from)} ${start + 14}, ${x(segment.to)} ${end - 14}, ${x(segment.to)} ${end}`} fill="none" strokeWidth="1"/>;
    })}
    <circle className={`git-lane-${row.column % 3}`} cx={x(row.column)} cy={middle} r="4" strokeWidth="1"/>
  </svg>;
}
function readCommitEntry(file: Patch): TreeEntry {
  const parsed = parseDiff(file.diff ?? '')[0];
  const git: GitMark[] = file.previousPath && file.previousPath !== file.path ? ['renamed']
    : /\nnew file mode /.test(file.diff ?? '') ? ['added'] : /\ndeleted file mode /.test(file.diff ?? '') ? ['deleted'] : ['modified'];
  return { path: file.path, git, additions: file.additions ?? parsed?.additions ?? 0, deletions: file.deletions ?? parsed?.deletions ?? 0 };
}
export function GitChanges({ client, projectId, worktree, enabled, language = 'en', target = store }: { client: FilesClient; projectId: string; worktree?: string; enabled: boolean; language?: 'en' | 'ja'; target?: ScreenStore }) {
  const w: Words = WORDS[language];
  const state = useScreenStore(target);
  const index = useRootIndex(state);
  const [search, setSearch] = useSearchParams();
  const agent = search.get('agent') ?? '';
  const names = useMemo(() => {
    const names = new Map<string, string>();
    for (const root of selectRoots(state)) {
      for (const id of root.conversation_ids) names.set(id, root.name);
      const tree = buildRootTree(root, index);
      for (const edge of tree.edges) {
        const node = tree.nodes.find(node => node.id === edge.target);
        if (node?.conversationId && edge.title) names.set(node.conversationId, edge.title);
      }
    }
    return names;
  }, [state, index]);
  const nameConversation = (id: string) => names.get(id) || conversationName(state, id) || id;
  function toggleAgent(id: string) {
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      if (next.get('agent') === id) next.delete('agent'); else next.set('agent', id);
      return next;
    });
  }

  const [entries, setEntries] = useState<GitChange[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hash, setHash] = useState('');
  const [selected, setSelected] = useState('');
  const [files, setFiles] = useState<Patch[]>([]);
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const [revision, setRevision] = useState(0);
  const [treeError, setTreeError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [commitError, setCommitError] = useState('');
  const [loading, setLoading] = useState(true);
  const [commitLoading, setCommitLoading] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLElement>(null);
  const request = { projectId, ...(worktree ? { worktree } : {}) };
  useEffect(() => {
    let cancelled = false;
    setEntries([]); setCommits([]); setSelected(''); setHash(''); setFiles([]);
    setTreeError(''); setHistoryError(''); setCommitError(''); setLoading(enabled);
    if (enabled) Promise.allSettled([
      callGit<{ entries: GitChange[] }>(client, 'files.changes', request),
      callGit<{ commits: Commit[] }>(client, 'files.commits', request),
    ]).then(([tree, history]) => {
      if (cancelled) return;
      const changes = tree.status === 'fulfilled' ? tree.value.entries ?? [] : [];
      const log = history.status === 'fulfilled' ? history.value.commits ?? [] : [];
      setEntries(changes); setCommits(log);
      if (tree.status === 'rejected') setTreeError(String(tree.reason.message ?? tree.reason));
      if (history.status === 'rejected') setHistoryError(String(history.reason.message ?? history.reason));
      if (changes.length) setSelected(changes[0].path);
      else setHash(log[0]?.hash ?? '');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, projectId, worktree, revision, enabled]);
  useEffect(() => {
    let cancelled = false;
    setFiles([]); setCommitError(''); setCommitLoading(Boolean(hash));
    if (hash) callGit<{ files: Patch[] }>(client, 'files.commit', { ...request, hash }).then(value => {
      if (!cancelled) { setFiles(value.files); setSelected(value.files[0]?.path ?? ''); setCommitLoading(false); }
    }, error => { if (!cancelled) { setCommitError(String(error.message ?? error)); setCommitLoading(false); } });
    return () => { cancelled = true; };
  }, [client, projectId, worktree, hash, revision]);
  const visibleCommits = useMemo(() => agent ? commits.filter(commit => commit.conversation_ids?.includes(agent)) : commits, [commits, agent]);
  useEffect(() => {
    if (agent) setHash(current => visibleCommits.some(commit => commit.hash === current) ? current : visibleCommits[0]?.hash ?? '');
  }, [agent, visibleCommits]);
  const graph = useMemo(() => buildCommitGraph(visibleCommits.map(commit => ({ hash: commit.hash, parents: commit.parents ?? [] }))), [visibleCommits]);
  const treeEntries = hash ? files.map(readCommitEntry) : entries;
  const change = !hash ? entries.find(entry => entry.path === selected) : undefined;
  const patch = hash ? files.find(file => file.path === selected) : undefined;
  const commit = commits.find(commit => commit.hash === hash);
  function selectSource(value: string) {
    if (value === hash) return;
    setHash(value); setSelected(value ? '' : entries[0]?.path ?? ''); setFiles([]); setCommitError('');
  }
  function focusFile() {
    const buttons = treeRef.current?.querySelectorAll<HTMLButtonElement>('.git-file-choice');
    const button = [...(buttons ?? [])].find(button => button.getAttribute('aria-pressed') === 'true') ?? buttons?.[0];
    button?.focus();
  }
  function moveHistory(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowRight') { event.preventDefault(); focusFile(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const sources = ['', ...visibleCommits.map(commit => commit.hash)];
    const next = Math.max(0, Math.min(sources.length - 1, sources.indexOf(hash) + (event.key === 'ArrowDown' ? 1 : -1)));
    selectSource(sources[next]);
    historyRef.current?.querySelectorAll<HTMLButtonElement>('[data-git-source]')[next]?.focus();
  }
  function moveFiles(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' && (event.target as HTMLElement).closest('.git-file-choice')) {
      event.preventDefault(); (event.target as HTMLElement).closest<HTMLButtonElement>('.git-file-choice')?.click(); diffRef.current?.focus(); return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(treeRef.current?.querySelectorAll<HTMLButtonElement>('.git-file-choice') ?? [])].filter(button => {
      let parent = button.parentElement;
      while (parent && parent !== treeRef.current) { if (parent instanceof HTMLDetailsElement && !parent.open) return false; parent = parent.parentElement; }
      return true;
    });
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    next?.focus(); next?.click();
  }
  return <div id="git-changes" className="git-changes">
    <div className="git-history" ref={historyRef} onKeyDown={moveHistory}>
      <header className="git-pane-header"><h2>{w.history}</h2><button className="btn btn-secondary btn-sm" disabled={!enabled || loading} onClick={() => setRevision(value => value + 1)}>{w.refresh}</button></header>
      <button data-git-source className="git-working-choice" aria-pressed={!hash} onClick={() => selectSource('')}><strong>{w.working}</strong><span className="count-pill">{entries.length}</span><span className="muted-text">{w.changed}</span></button>
      {treeError && <p role="alert">{treeError}</p>}
      {agent && <button className="btn btn-secondary btn-sm" onClick={() => toggleAgent(agent)}>{w.clearFilter}: {nameConversation(agent)}</button>}
      <section aria-label="Commits">
        {historyError && <p role="alert">{historyError}</p>}
        {loading ? <p>{w.loadingHistory}</p> : !enabled ? <p>{w.register}</p> : !visibleCommits.length && !historyError ? <p className="muted-text">{agent ? w.noMatches : w.noCommits}</p> : null}
        <ul className="git-commit-list">{visibleCommits.map((value, index) => <li key={value.hash}>
          <button data-git-source className="git-commit-choice" aria-pressed={hash === value.hash} onClick={() => selectSource(value.hash)} title={value.subject}>
            <CommitLines row={graph.rows[index]} columns={graph.columns}/>
            <span className="git-commit-copy"><span className="git-commit-subject">{(value.branches ?? []).map(name => <span key={`branch:${name}`} className="git-ref">{name}</span>)}{(value.tags ?? []).map(name => <span key={`tag:${name}`} className="git-ref git-tag">{name}</span>)}<strong>{value.subject}</strong></span>
              <span className="git-commit-meta">{value.shortHash} · {value.conversation_ids?.length ? '' : `${value.author} · `}<time dateTime={value.time} title={value.time}>{formatWhen(value.time, language)}</time></span></span>
          </button>
          {!!value.conversation_ids?.length && <span className="git-conversation-badges">{value.conversation_ids.map(id =>
            <button key={id} className="git-ref git-conversation-badge" aria-label={`${w.filter}: ${nameConversation(id)}`} title={nameConversation(id)} aria-pressed={agent === id} onClick={() => toggleAgent(id)}>{nameConversation(id)}</button>)}</span>}
        </li>)}</ul>
      </section>
    </div>
    <section className="git-files-pane" aria-label="Changed files" ref={treeRef} onKeyDown={moveFiles}>
      <header className="git-pane-header"><h2>{hash ? commit?.shortHash : w.working}</h2><span className="count-pill">{treeEntries.length} {w.files}</span></header>
      {commitError ? <p role="alert">{commitError}</p> : loading || commitLoading ? <p>{w.loadingFiles}</p> : treeEntries.length ? <ChangeTree entries={treeEntries} selected={selected} onSelect={setSelected}/> : <p className="muted-text">{hash ? w.noFiles : w.clean}</p>}
    </section>
    <section className="git-diff-pane" aria-label="Difference" ref={diffRef} tabIndex={-1}>
      <header className="git-pane-header"><h2 title={selected}>{selected || w.difference}</h2></header>
      {change ? <FileGitDiff key={`${projectId}:${worktree}:${revision}:${selected}`} client={client} request={{ ...request, path: selected }} change={change} w={w}/>
        : patch ? <><Layout value={layout} onChange={setLayout} w={w}/><GitPatch patch={patch} layout={layout}/></> : <p className="muted-text">{commitLoading ? w.loadingDiff : w.choose}</p>}
    </section>
  </div>;
}
