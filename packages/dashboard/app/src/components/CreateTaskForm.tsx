import { useState, type FormEvent } from 'react';
import type { Ack } from '../lib/client.ts';
import type { Language } from '../lib/i18n.ts';

export interface CommandClient { command(command: string, payload?: unknown, cmdId?: string): Promise<Ack> }
export function CreateTaskForm({ project, client, disabled = false, language = 'en', onCancel }: {
  project: string; client: CommandClient; disabled?: boolean; language?: Language; onCancel?: () => void;
}) {
  const ja = language === 'ja';
  const [provider, setProvider] = useState('codex');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('medium');
  const [agents, setAgents] = useState(1);
  const [title, setTitle] = useState('');
  const [task, setTask] = useState('');
  const [cwd, setCwd] = useState(project.startsWith('/') ? project : '');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || disabled || !title.trim() || !task.trim() || !model.trim() || !cwd.trim() || !Number.isSafeInteger(agents) || agents < 1) return;
    setPending(true); setResult('');
    // 各委譲の ID は client が再接続後も保持し、並列に受付へ送る。
    const outcomes = await Promise.allSettled(Array.from({ length: agents }, (_, index) => {
      const cmdId = crypto.randomUUID();
      return client.command('intake.submit', {
        requestId: `ui:${JSON.stringify([cmdId])}`, source: 'ui', role: 'implement',
        title: agents > 1 ? `${title.trim()} (${index + 1}/${agents})` : title.trim(),
        task: task.trim(), accept: [], cwd: cwd.trim(), project, provider, model: model.trim(), effort,
        constraints: { excludeFamily: [provider === 'codex' ? 'anthropic' : 'openai'] },
      }, cmdId);
    }));
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [String(outcome.reason)] : outcome.value.ok ? [] : [outcome.value.error ?? 'Command rejected']);
    const accepted = outcomes.length - errors.length;
    setResult(`${accepted}/${agents} ${ja ? '受付に送信しました' : 'requests accepted'}${errors.length ? ` · ${errors.join('; ')}` : ''}`);
    setPending(false);
  }
  return <form className="create-task" onSubmit={event => void submit(event)} aria-label={ja ? '作業を作る' : 'Create task'}>
    <header className="form-header"><h2>{ja ? '作業を作る' : 'Create task'}</h2><p className="muted-text">{ja ? 'モデルと effort の反映には受付の対応が必要です。' : 'Applying model and effort requires intake support.'}</p></header>
    <div className="form-grid">
      <label className="field span-2">{ja ? '名前' : 'Title'}<input required value={title} onChange={event => setTitle(event.target.value)} disabled={pending} placeholder={ja ? '例: API の遅延を調べる' : 'e.g. Investigate API latency'}/></label>
      <label className="field span-2">{ja ? '作業ディレクトリ' : 'Working directory'}<input className="mono" required value={cwd} onChange={event => setCwd(event.target.value)} disabled={pending}/></label>
      <label className="field">Provider<select value={provider} onChange={event => { setProvider(event.target.value); setModel(''); }} disabled={pending}><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
      <label className="field">{ja ? 'モデル' : 'Model'}<input className="mono" required value={model} onChange={event => setModel(event.target.value)} disabled={pending}/></label>
      <label className="field">Effort<select value={effort} onChange={event => setEffort(event.target.value)} disabled={pending}>{['low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field">{ja ? 'エージェント数' : 'Agents'}<input type="number" min={1} required value={agents} onChange={event => setAgents(Number(event.target.value))} disabled={pending}/></label>
      <label className="field span-4">{ja ? '依頼' : 'Task'}<textarea required rows={3} value={task} onChange={event => setTask(event.target.value)} disabled={pending}/></label>
    </div>
    <footer className="form-footer">{result && <p role="status" className="status-line">{result}</p>}<span className="spacer"/>
      {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>{ja ? 'キャンセル' : 'Cancel'}</button>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={disabled || pending}>{pending ? (ja ? '送信中' : 'Submitting') : (ja ? 'エージェントを起動' : 'Start agents')}</button></footer>
  </form>;
}
