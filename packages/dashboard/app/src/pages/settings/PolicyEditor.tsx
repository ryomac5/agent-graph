import { useEffect, useRef, useState } from 'react';
import { CommandDialog } from '../../components/command/Commands.tsx';
import { SettingsFields } from '../../components/settings/SettingsFields.tsx';
import { describeDecision, requestSettings, type Policy, type PolicyPreview, type SettingsClient } from '../../lib/settings.ts';
import { ModelAssignments, type ModelCatalog } from './ModelAssignments.tsx';

type ProviderPreview = { token: string; provider: string; files: { path: string; diff: string }[]; mcpCommand?: string };
export function PolicyEditor({ client, policy, models, language, dirty, onChange, onSaved, onRefresh }: {
  client: SettingsClient; policy: Policy; models: ModelCatalog; language: 'en' | 'ja'; dirty: boolean;
  onChange(value: Policy): void; onSaved(revision: Policy): void; onRefresh(provider: 'claude' | 'codex' | 'antigravity'): void;
}) {
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
  const [preview, setPreview] = useState<PolicyPreview>();
  const [files, setFiles] = useState<ProviderPreview[]>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = useRef(policy); current.current = policy;
  const previewPolicy = useRef(policy);
  useEffect(() => { setPreview(undefined); setFiles(undefined); setConfirmed(false); }, [policy]);
  const invalid = policy.quota.softLimitPercent > policy.quota.hardLimitPercent;
  async function perform(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }
  function change(value: Policy) { setPreview(undefined); setFiles(undefined); setConfirmed(false); onChange(value); }
  function review() {
    const revision = policy;
    void perform(async () => { const result = await requestSettings<PolicyPreview>(client, 'settings.previewPolicy', { patch: revision }); if (current.current === revision) { previewPolicy.current = revision; setPreview(result); } });
  }
  const unsaved = dirty && <span className="settings-unsaved">{text('Unsaved', '未保存')}</span>;
  const saveButton = <div className="button-row settings-actions"><button className="btn btn-primary" disabled={busy || invalid} onClick={review}>{text('Save', '保存')}</button></div>;
  return <>
    <section id="settings-models" className="settings-section" aria-label={text('Models', 'モデル')}><header><h2>{text('Models', 'モデル')}</h2>{unsaved}</header>
      <div className="settings-note">{text('Choose which model handles each role and workload', '役割と作業の重さごとに、どのモデルを使うかを決める')}</div>
      <ModelAssignments policy={policy} models={models} language={language} onChange={change} onRefresh={onRefresh} applyDisabled={busy || dirty} onApply={() => {
        const revision = policy;
        void perform(async () => { const results = await Promise.all(['claude', 'codex', 'antigravity'].map(provider => requestSettings<ProviderPreview>(client, 'settings.previewProvider', { provider }))); if (current.current === revision) { setConfirmed(false); setFiles(results); } });
      }}/>{saveButton}
    </section>
    <details id="settings-rules" className="settings-section settings-fold"><summary><h2>{text('Selection rules', '選び方のルール')}</h2>{unsaved}<span className="settings-summary">{text(`Quota ${policy.quota.softLimitPercent}% / ${policy.quota.hardLimitPercent}% · ${policy.performance.minSamples} runs · ${policy.constraints.length} constraints`, `利用枠 ${policy.quota.softLimitPercent}% で後回し、${policy.quota.hardLimitPercent}% で除外 · 実績 ${policy.performance.minSamples} 件 · 制約 ${policy.constraints.length} 件`)}</span></summary>
      <div className="settings-card"><SettingsFields value={{ maxRoundTrips: policy.maxRoundTrips, quota: policy.quota, performance: policy.performance, constraints: policy.constraints }} language={language} onChange={next => change({ ...policy, ...next })}/>
      <fieldset className="assignment-notes-editor"><legend>{text('Model notes', 'モデルのメモ')}</legend>{policy.modelNotes.map((note, index) => <fieldset key={index}>{(['model', 'latest', 'strength', 'specialties'] as const).map(key => <label key={key}>{text(({ model: 'Model', latest: 'Latest', strength: 'Strength', specialties: 'Specialties' })[key], ({ model: 'モデル', latest: '最新', strength: '強み', specialties: '得意分野' })[key])}<input aria-label={text('Model note', 'モデルのメモ') + ' ' + (index + 1) + ' ' + key} type={key === 'latest' ? 'checkbox' : 'text'} checked={key === 'latest' ? note.latest : undefined} value={key === 'latest' ? undefined : note[key]} onChange={event => change({ ...policy, modelNotes: policy.modelNotes.map((n, at) => at === index ? { ...n, [key]: key === 'latest' ? event.target.checked : event.target.value } : n) })}/></label>)}<button className="btn btn-ghost" onClick={() => change({ ...policy, modelNotes: policy.modelNotes.filter((_, at) => at !== index) })}>{text('Remove', '削除')}</button></fieldset>)}<button className="btn btn-secondary" onClick={() => change({ ...policy, modelNotes: [...policy.modelNotes, { model: '', latest: false, strength: '', specialties: '' }] })}>{text('Add note', 'メモを追加')}</button></fieldset>
      {saveButton}</div>
    </details>
    {message && <p role="alert">{message}</p>}
    {preview && <CommandDialog title={text('Review before saving', '保存する前の確認')} language={language} onClose={() => setPreview(undefined)}><table><thead><tr><th>{text('Past request', '過去の依頼')}</th><th>{text('Now', 'いま')}</th><th>{text('After', '変更後')}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.id}><td>{row.id}</td><td>{describeDecision(row.before)}</td><td>{describeDecision(row.after)}</td></tr>)}</tbody></table>{!preview.rows.length && <div className="settings-note">{text('No past requests to compare', '試せる過去の依頼がない')}</div>}<div className="button-row settings-actions"><button className="btn btn-ghost" onClick={() => setPreview(undefined)}>{text('Cancel', 'やめる')}</button><button className="btn btn-primary" disabled={busy} onClick={() => void perform(async () => { const revision = previewPolicy.current; await requestSettings(client, 'settings.write', { store: 'policy', patch: revision, previewToken: preview.token }); onSaved(revision); setPreview(undefined); })}>{text('Save', 'この内容で保存')}</button></div></CommandDialog>}
    {files && <CommandDialog title={text('Files to write', '書き出す内容')} language={language} onClose={() => setFiles(undefined)}>{files.flatMap(result => result.files).map(file => <div key={file.path}><code>{file.path}</code><pre className="provider-diff">{file.diff}</pre></div>)}{files.filter(result => result.mcpCommand).map(result => <div key={result.provider}>{text('MCP registration command', 'MCP の登録コマンド')} <code>{result.mcpCommand}</code></div>)}<label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>{text('Overwrite the files above', '上のファイルを書き換える')}</label><div className="button-row settings-actions"><button className="btn btn-ghost" onClick={() => setFiles(undefined)}>{text('Cancel', 'やめる')}</button><button className="btn btn-primary" disabled={busy || !confirmed} onClick={() => void perform(async () => { for (const result of files) { await requestSettings(client, 'settings.applyProvider', { provider: result.provider, token: result.token, confirmation: true }); setFiles(previous => previous?.filter(entry => entry.provider !== result.provider)); } setFiles(undefined); setConfirmed(false); setMessage(text('Applied', '反映しました')); })}>{text('Write files', '書き出す')}</button></div></CommandDialog>}
  </>;
}
