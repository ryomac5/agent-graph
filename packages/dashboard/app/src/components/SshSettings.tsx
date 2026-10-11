import { SettingMenu } from './settings/Controls.tsx';
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
  const [results, setResults] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<boolean>();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let active = true; void request<{ connections: SshConnection[] }>(client, 'ssh.read').then(result => { if (active) { setConnections(result?.connections ?? []); setSaved(result?.connections ?? []); setExpanded(previous => previous ?? (result?.connections?.length ?? 0) > 0); setLoaded(true); } }, cause => { if (active) setError(text('Unable to load SSH connections', 'SSH の接続先を読み込めません')); }); return () => { active = false; }; }, [client]);
  function edit(id: string, patch: Partial<SshConnection>) { setConnections(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row)); setMessage(''); }
  async function perform(operation: () => Promise<void>) { setBusy(true); setMessage(''); setError(''); try { await operation(); } catch (cause) { setError(text('SSH operation failed', 'SSH の操作に失敗しました')); } finally { setBusy(false); } }
  return <details id="settings-ssh" className="ssh-settings settings-section settings-fold" open={expanded ?? connections.length > 0} onToggle={event => setExpanded(event.currentTarget.open)}><summary><h2>{text('SSH connections', 'SSH の接続先')}</h2>{dirty && <span className="settings-unsaved">{text('Unsaved', '未保存')}</span>}<span className="settings-summary">{connections.length}{text(' connections', ' 件')}</span></summary><div className="settings-card">
    {connections.map(row => <fieldset key={row.id} disabled={busy}><legend>{row.name || text('New connection', '新しい接続先')}</legend>
      <label>{text('Name', '名前')}<input value={row.name} onChange={event => edit(row.id, { name: event.target.value })}/></label>
      <label>{text('Destination', '宛先')}<input value={row.destination} placeholder="user@host" onChange={event => edit(row.id, { destination: event.target.value })}/></label>
      <p>{text('Remote paths', 'リモートのパス')}</p>
      {row.projects.map((project, index) => <div className="ssh-project-path" key={index}>
        <SettingMenu label={text('Project', 'プロジェクト')} value={project.projectId} options={[{ value: '', label: text('Choose a project', 'プロジェクトを選ぶ') }, ...projects.map(item => ({ value: String(item.id), label: String(item.display_name ?? item.id) }))]} onChange={value => edit(row.id, { projects: row.projects.map((item, i) => i === index ? { ...item, projectId: value } : item) })}/>
        <input aria-label={text('Remote path', 'リモートパス')} value={project.path} placeholder="~/project" onChange={event => edit(row.id, { projects: row.projects.map((item, i) => i === index ? { ...item, path: event.target.value } : item) })}/>
        <button className="btn btn-ghost" onClick={() => edit(row.id, { projects: row.projects.filter((_, i) => i !== index) })}>{text('Remove path', 'パスを削除')}</button>
      </div>)}
      <div className="button-row"><button className="btn btn-secondary" onClick={() => edit(row.id, { projects: [...row.projects, { projectId: '', path: '' }] })}>{text('Add path', 'パスを追加')}</button>
      <button className="btn btn-secondary" disabled={!row.destination} onClick={() => void perform(async () => { const result = await request<{ connected: boolean }>(client, 'ssh.test', { destination: row.destination }); setResults(previous => ({ ...previous, [row.id]: result.connected ? text('Connected', '接続できた') : text('Could not connect', '接続できない') })); })}>{text('Test', '接続を試す')}</button>
      <button className="btn btn-ghost" onClick={() => setConnections(rows => rows.filter(item => item.id !== row.id))}>{text('Remove connection', '接続先を削除')}</button></div>
    {results[row.id] && <div className="settings-note" role="status">{results[row.id]}</div>}</fieldset>)}
    <div className="button-row"><button className="btn btn-secondary" disabled={busy || !loaded} onClick={() => setConnections(rows => [...rows, { id: crypto.randomUUID(), name: '', destination: '', projects: [] }])}>{text('Add connection', '接続先を追加')}</button>
    <button className="btn btn-primary" disabled={busy || !loaded || !dirty} onClick={() => void perform(async () => { await request(client, 'ssh.write', { connections }); setSaved(connections); setMessage(text('Saved', '保存しました')); })}>{text('Save', '保存')}</button></div>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </div></details>;
}
