import { useEffect, useState } from 'react';
import { DiffView } from '../../components/diff/DiffView.tsx';
import { parseDiff, type DiffLayout } from '../../components/diff/model.ts';
import { GIT_MARKS, type FilesClient, type FilesRequest, type GitMark } from '../files/model.ts';

export interface GitChange { path: string; previousPath?: string; git: GitMark[]; status: string; staged: boolean; unstaged: boolean; additions: number; deletions: number; binary: boolean }
interface Commit { hash: string; shortHash: string; subject: string; author: string; time: string; fileCount: number; additions: number; deletions: number }
interface Patch { path: string; state: 'text' | 'too_large' | 'binary'; diff?: string }
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
export function FileGitDiff({ client, request, change }: { client: FilesClient; request: FilesRequest; change: Pick<GitChange, 'staged' | 'unstaged' | 'git'> }) {
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
    <div className="button-row" role="group" aria-label="Change source">{modes.map(value => <button key={value} className="btn btn-secondary btn-sm" aria-pressed={mode === value} onClick={() => setChosen(value)}>{value === 'staged' ? 'Staged' : value === 'unstaged' ? 'Unstaged' : 'Untracked'}</button>)}</div>
    <Layout value={layout} onChange={setLayout}/></div>
    {error ? <p role="alert">{error}</p> : patch ? <GitPatch patch={patch} layout={layout}/> : <p>Loading diff…</p>}
  </div>;
}
function Layout({ value, onChange }: { value: DiffLayout; onChange: (value: DiffLayout) => void }) {
  return <div className="button-row" role="group" aria-label="Diff layout">{(['unified', 'split'] as const).map(layout => <button key={layout} className="btn btn-secondary btn-sm" aria-pressed={value === layout} onClick={() => onChange(layout)}>{layout === 'unified' ? 'Unified' : 'Side by side'}</button>)}</div>;
}
function ChangeTree({ entries, selected, onSelect }: { entries: GitChange[]; selected: string; onSelect: (path: string) => void }) {
  function render(prefix: string) {
    const children = new Map<string, GitChange | undefined>();
    for (const entry of entries) if (entry.path.startsWith(prefix)) {
      const tail = entry.path.slice(prefix.length); const name = tail.split('/')[0];
      children.set(name, tail.includes('/') ? undefined : entry);
    }
    return <ul>{[...children].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => <li key={name}>{entry
      ? <button className="git-file-choice" aria-pressed={selected === entry.path} onClick={() => onSelect(entry.path)} title={entry.path}>
        <span>{name}</span><span className="git-file-meta">{entry.git.map(mark => <span key={mark} className={`git-${mark}`}>{GIT_MARKS[mark].letter}</span>)}<span className="diff-add-count">+{entry.additions}</span><span className="diff-remove-count">−{entry.deletions}</span></span></button>
      : <details open><summary>{name}</summary>{render(`${prefix}${name}/`)}</details>}</li>)}</ul>;
  }
  return <nav aria-label="Changed files">{render('')}</nav>;
}
export function GitChanges({ client, projectId, worktree, enabled }: { client: FilesClient; projectId: string; worktree?: string; enabled: boolean }) {
  const [entries, setEntries] = useState<GitChange[]>([]); const [commits, setCommits] = useState<Commit[]>([]);
  const [selected, setSelected] = useState(''); const [hash, setHash] = useState(''); const [files, setFiles] = useState<Patch[]>([]);
  const [commitPath, setCommitPath] = useState(''); const [layout, setLayout] = useState<DiffLayout>('unified');
  const [revision, setRevision] = useState(0); const [treeError, setTreeError] = useState(''); const [commitError, setCommitError] = useState('');
  const [loading, setLoading] = useState(true); const [commitLoading, setCommitLoading] = useState(false);
  const request = { projectId, ...(worktree ? { worktree } : {}) };
  useEffect(() => {
    let cancelled = false; setEntries([]); setCommits([]); setSelected(''); setHash(''); setTreeError(''); setCommitError(''); setLoading(enabled);
    if (enabled) Promise.allSettled([
      callGit<{ entries: GitChange[] }>(client, 'files.changes', request), callGit<{ commits: Commit[] }>(client, 'files.commits', request),
    ]).then(([tree, history]) => {
      if (cancelled) return;
      if (tree.status === 'fulfilled') { setEntries(tree.value.entries); setSelected(tree.value.entries[0]?.path ?? ''); } else setTreeError(String(tree.reason.message ?? tree.reason));
      if (history.status === 'fulfilled') setCommits(history.value.commits); else setCommitError(String(history.reason.message ?? history.reason));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [client, projectId, worktree, revision, enabled]);
  useEffect(() => {
    let cancelled = false; setFiles([]); setCommitPath(''); setCommitLoading(Boolean(hash));
    if (hash) callGit<{ files: Patch[] }>(client, 'files.commit', { ...request, hash }).then(value => {
      if (!cancelled) { setFiles(value.files); setCommitLoading(false); }
    }, error => { if (!cancelled) { setCommitError(String(error.message ?? error)); setCommitLoading(false); } });
    return () => { cancelled = true; };
  }, [client, projectId, worktree, hash, revision]);
  const change = entries.find(entry => entry.path === selected);
  return <div id="git-changes" className="git-changes">
    <section aria-label="Working tree"><header className="git-section-header"><div><h2>Working tree</h2><p className="muted-text">Changes in your project, including staged and untracked files.</p></div><button className="btn btn-secondary btn-sm" disabled={!enabled || loading} onClick={() => setRevision(value => value + 1)}>Refresh</button></header>
      {treeError ? <p role="alert">{treeError}</p> : loading ? <p>Loading working tree…</p> : !entries.length ? <p className="muted-text">{enabled ? 'Working tree is clean.' : 'Register a project to view its Git changes.'}</p> : <div className="git-columns"><aside><ChangeTree entries={entries} selected={selected} onSelect={setSelected}/></aside><div>{change && <FileGitDiff key={`${projectId}:${worktree}:${revision}:${selected}`} client={client} request={{ ...request, path: selected }} change={change}/>}</div></div>}
    </section>
    <section aria-label="Commits"><header className="git-section-header"><div><h2>Commits</h2><p className="muted-text">Recent commits and the files they changed.</p></div></header>
      {commitError && <p role="alert">{commitError}</p>}{!loading && !commits.length && !commitError && <p className="muted-text">No commits yet.</p>}
      {!!commits.length && <div className="git-columns"><aside><ul className="git-commit-list">{commits.map(commit => <li key={commit.hash}><button className="git-commit-choice" aria-pressed={hash === commit.hash} onClick={() => { setCommitError(''); setHash(commit.hash); }}><strong>{commit.subject}</strong><span>{commit.shortHash} · {commit.author}</span><time dateTime={commit.time}>{new Date(commit.time).toLocaleString('en-US')}</time><span>{commit.fileCount} files · <span className="diff-add-count">+{commit.additions}</span> <span className="diff-remove-count">−{commit.deletions}</span></span></button></li>)}</ul></aside>
        <div className="git-commit-diff">{commitLoading ? <p>Loading commit…</p> : !hash ? <p>Choose a commit to view its changes.</p> : <><nav className="git-commit-files" aria-label="Commit files"><button className="btn btn-secondary btn-sm" aria-pressed={!commitPath} onClick={() => setCommitPath('')}>All files</button>{files.map(file => <button key={file.path} className="btn btn-ghost btn-sm" aria-pressed={commitPath === file.path} onClick={() => setCommitPath(file.path)}>{file.path}</button>)}</nav><Layout value={layout} onChange={setLayout}/>{files.filter(file => !commitPath || file.path === commitPath).map(file => <GitPatch key={file.path} patch={file} layout={layout}/>)}</>}</div>
      </div>}
    </section>
  </div>;
}
