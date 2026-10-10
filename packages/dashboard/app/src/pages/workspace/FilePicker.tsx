import { useEffect, useState } from 'react';
import { CommandDialog } from '../../components/command/Commands.tsx';
import { listFiles, type FilesClient } from '../files/model.ts';
import type { Language } from '../../lib/i18n.ts';
export function FilePicker({ client, projectId, worktree, language, open, close }: { client: FilesClient; projectId: string; worktree?: string; language: Language; open: (path: string) => void; close: () => void }) {
  const [files, setFiles] = useState<string[]>([]), [query, setQuery] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(true), [index, setIndex] = useState(0);
  const ja = language === 'ja';
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const directories = ['']; const paths: string[] = []; const visited = new Set<string>();
      for (const path of directories) {
        if (cancelled) return;
        if (visited.has(path)) continue; visited.add(path);
        const result = await listFiles(client, { projectId, worktree, path });
        for (const entry of result.entries) if (entry.kind === 'directory') directories.push(entry.path); else if (!entry.git.includes('deleted')) paths.push(entry.path);
        if (!cancelled) setFiles([...paths].sort());
      }
    }
    void load().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client, projectId, worktree]);
  const matches = files.filter(path => query.toLowerCase().trim().split(/\s+/).every(word => path.toLowerCase().includes(word)));
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  return <CommandDialog title={ja ? 'ファイルを開く' : 'Open file'} language={language} onClose={close}>
    <input role="combobox" aria-label={ja ? 'ファイル名を検索' : 'Search file names'} aria-expanded="true" aria-controls="workspace-file-results" aria-activedescendant={matches.length ? `workspace-file-${selected}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(matches.length ? (selected + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length : 0); }
      if (event.key === 'Enter' && matches[selected]) { event.preventDefault(); open(matches[selected]); close(); }
    }}/>
    {error && <p role="alert">{error}</p>}{loading && <p role="status">{ja ? '読み込み中' : 'Loading…'}</p>}
    <ul id="workspace-file-results" role="listbox" aria-label={ja ? 'ファイル' : 'Files'}>{matches.map((path, i) => <li role="option" aria-selected={i === selected} id={`workspace-file-${i}`} key={path}><button className="btn btn-ghost" onClick={() => { open(path); close(); }}>{path}</button></li>)}</ul>
    {!loading && !matches.length && <p>{ja ? 'ファイルが見つかりません' : 'No matching files'}</p>}
  </CommandDialog>;
}
