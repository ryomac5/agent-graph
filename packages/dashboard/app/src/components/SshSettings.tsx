import { useEffect, useState } from 'react';
import type { ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import type { Row } from '../lib/store.ts';
import { request, type SshConnection } from './SessionCreate.tsx';
export function SshSettings({ client, projects, language = 'en' }: { client: ConversationClient; projects: Row[]; language?: 'ja' | 'en' }) {
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [saved, setSaved] = useState<SshConnection[]>([]);
  const dirty = JSON.stringify(connections) !== JSON.stringify(saved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let active = true; void request<{ connections: SshConnection[] }>(client, 'ssh.read').then(result => { if (active) { setConnections(result?.connections ?? []); setSaved(result?.connections ?? []); setLoaded(true); } }, cause => { if (active) setError(text('Unable to load SSH connections', 'SSH の接続先を読み込めません')); }); return () => { active = false; }; }, [client]);
  function edit(id: string, patch: Partial<SshConnection>) { setConnections(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row)); setMessage(''); }
  async function perform(operation: () => Promise<void>) { setBusy(true); setMessage(''); setError(''); try { await operation(); } catch (cause) { setError(text('SSH operation failed', 'SSH の操作に失敗しました')); } finally { setBusy(false); } }
  return <section className="ssh-settings" aria-label={text('SSH connections', 'SSH の接続先')}><h2>{text('SSH connections', 'SSH の接続先')}</h2>
    {connections.map(row => <fieldset key={row.id} disabled={busy}><legend>{row.name || text('New connection', '新しい接続先')}</legend>
      <label>{text('Name', '名前')}<input value={row.name} onChange={event => edit(row.id, { name: event.target.value })}/></label>
      <label>{text('SSH destination', 'SSH 接続先')}<input value={row.destination} placeholder="user@host" onChange={event => edit(row.id, { destination: event.target.value })}/></label>
      <p>{text('Remote project paths', 'リモートのプロジェクトパス')}</p>
      {row.projects.map((project, index) => <div className="ssh-project-path" key={index}>
        <select aria-label={text('Project', 'プロジェクト')} value={project.projectId} onChange={event => edit(row.id, { projects: row.projects.map((item, i) => i === index ? { ...item, projectId: event.target.value } : item) })}><option value="">{text('Choose a project', 'プロジェクトを選ぶ')}</option>{projects.map(item => <option key={String(item.id)} value={String(item.id)}>{String(item.display_name ?? item.id)}</option>)}</select>
        <input aria-label={text('Remote path', 'リモートパス')} value={project.path} placeholder="~/project" onChange={event => edit(row.id, { projects: row.projects.map((item, i) => i === index ? { ...item, path: event.target.value } : item) })}/>
        <button className="btn btn-ghost" onClick={() => edit(row.id, { projects: row.projects.filter((_, i) => i !== index) })}>{text('Remove path', 'パスを削除')}</button>
      </div>)}
      <div className="button-row"><button className="btn btn-secondary" onClick={() => edit(row.id, { projects: [...row.projects, { projectId: '', path: '' }] })}>{text('Add project path', 'プロジェクトパスを追加')}</button>
      <button className="btn btn-secondary" disabled={!row.destination} onClick={() => void perform(async () => { const result = await request<{ connected: boolean }>(client, 'ssh.test', { destination: row.destination }); setMessage(result.connected ? text('Connected', '接続できました') : text('Connection failed', '接続できませんでした')); })}>{text('Test connection', '接続テスト')}</button>
      <button className="btn btn-ghost" onClick={() => setConnections(rows => rows.filter(item => item.id !== row.id))}>{text('Remove connection', '接続先を削除')}</button></div>
    </fieldset>)}
    <div className="button-row"><button className="btn btn-secondary" disabled={busy || !loaded} onClick={() => setConnections(rows => [...rows, { id: crypto.randomUUID(), name: '', destination: '', projects: [] }])}>{text('Add SSH connection', 'SSH の接続先を追加')}</button>
    <button className={`btn ${dirty ? 'btn-primary' : 'btn-secondary'}`} disabled={busy || !loaded || !dirty} onClick={() => void perform(async () => { await request(client, 'ssh.write', { connections }); setSaved(connections); setMessage(text('Saved', '保存しました')); })}>{text('Save SSH connections', 'SSH の接続先を保存')}</button></div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
