import { useEffect, useRef, useState } from 'react';
import type { ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { request } from '../lib/session-start.ts';
import { CommandDialog } from './command/Commands.tsx';
export function ProjectAdd({ client, language, onClose, onAdded }: { client: ConversationClient; language: 'en' | 'ja'; onClose(): void; onAdded(id: string): void }) {
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
  const [path, setPath] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { void request<{ paths: string[] }>(client, 'fs.directories', { path }).then(result => { if (active) setPaths(result.paths ?? []); }, () => { if (active) setPaths([]); }); }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [client, path]);
  async function add() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    try { const result = await request<{ projectId: string }>(client, 'project.add', { path }); onAdded(result.projectId); }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : '';
      setError(reason === 'missing' ? text('Location not found', '場所がありません') : reason === 'temporary' ? text('Temporary location', '一時の場所です') : reason === 'not_git' ? text('Not a Git repository', 'Git リポジトリではありません') : text('Unable to add project', '追加できません'));
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <CommandDialog language={language} title={text('Add project', 'プロジェクトを追加')} onClose={onClose}>
    <form className="session-create" onSubmit={event => { event.preventDefault(); void add(); }}>
      <label>{text('Location', '場所')}<input autoFocus list="project-locations" value={path} disabled={busy} onChange={event => setPath(event.target.value)}/></label>
      <datalist id="project-locations">{paths.map(value => <option key={value} value={value + '/'}/>)}</datalist>
      {error && <p role="alert">{error}</p>}
      <div className="session-create-actions"><button className="btn btn-primary" disabled={busy || !path.trim()}>{text('Add project', 'プロジェクトを追加')}</button></div>
    </form>
  </CommandDialog>;
}
