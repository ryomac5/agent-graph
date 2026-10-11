import { PolicyEditor } from './PolicyEditor.tsx';
import { useEffect, useRef, useState } from 'react';
import { labelSetting, SettingsFields, SettingsSection } from '../../components/settings/SettingsFields.tsx';
import { APPEARANCE_CHOICES, loadAppearance, saveAppearance, requestSettings, describeDecision,
  type Appearance, type PolicyPreview, type SettingsClient, type SettingsSnapshot, type SettingsStatus } from '../../lib/settings.ts';
import { loadPreferences, NOTIFICATION_KINDS, notificationLabel, PREFERENCES_KEY, type NotificationPreferences } from '../../components/notifications/model.ts';
import { ModelAssignments, type ModelCatalog } from './ModelAssignments.tsx';
import { assignmentSettingText } from '../../lib/i18n.ts';
import './settings.css';

const ERROR_TEXT: Record<string, string> = {
  'Settings application failed': '設定の反映に失敗しました',
  'Settings audit failed': '設定の記録に失敗しました',
  'Settings unavailable': '設定を取得できません',
  'Settings operation failed': '設定の操作に失敗しました',
  'Invalid redaction pattern': 'マスキングの正規表現が不正です',
  'Duplicate key binding': 'ショートカットが重複しています',
};
const REFRESH_MS = 1500;
type FileStore = 'config' | 'policy' | 'project';
export function SettingsPage({ client, language, onAppearance, policyOnly = false }: { policyOnly?: boolean; client: SettingsClient; language?: 'en' | 'ja'; onAppearance?(value: Appearance): void }) {
  const [appearance, setAppearance] = useState(loadAppearance);
  const lang = language ?? appearance.language;
  const ja = lang === 'ja';
  const text = (en: string, jp: string) => ja ? jp : en;
  const displayError = (reason: string) => ja ? ERROR_TEXT[reason] ?? reason.replace(/^Invalid (.+)$/, (_, key: string) => key.split('.').map(part => labelSetting(part, 'ja')).join(' · ') + 'の値が不正です') : reason;
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [status, setStatus] = useState<SettingsStatus>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PolicyPreview>();
  const [providerPreview, setProviderPreview] = useState<{ token: string; provider: string; files: { path: string; diff: string }[]; mcpCommand?: string }[]>();
  const [providerConfirmed, setProviderConfirmed] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => loadPreferences(localStorage));
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unavailable' : Notification.permission);
  const [models, setModels] = useState<ModelCatalog>({});
  const latestPolicy = useRef(settings?.policy); latestPolicy.current = settings?.policy;
  const dirty = useRef(new Set<FileStore>());
  const edits = useRef({ config: 0, policy: 0, project: 0 });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let refreshing = false;
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const [read, nextStatus] = await Promise.all([
          requestSettings<SettingsSnapshot>(client, 'settings.read'), requestSettings<SettingsStatus>(client, 'settings.status'),
        ]);
        if (!mounted.current) return;
        if (!read?.policy || !read.config) throw new Error('Settings unavailable');
        setSettings(previous => previous ? { ...read, ...Object.fromEntries([...dirty.current].map(store => [store, previous[store]])) } : read);
        setStatus(nextStatus);
      } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Settings unavailable'); }
      finally { refreshing = false; }
    }
    void refresh();
    for (const provider of ['claude', 'codex', 'antigravity']) void requestSettings<ModelCatalog[string]>(client, 'settings.models', { provider }).then(result => { if (mounted.current) setModels(previous => ({ ...previous, [provider]: result })); }).catch(() => undefined);
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    if (policyOnly) return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => saveAppearance(appearance);
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appearance, policyOnly]);
  async function perform(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : text('Settings operation failed', '設定の操作に失敗しました')); }
    finally { setBusy(false); }
  }
  function edit(store: FileStore, value: unknown) {
    edits.current[store] += 1;
    dirty.current.add(store);
    setSettings(previous => previous && { ...previous, [store]: value });
    if (store === 'policy') { setPreview(undefined); setProviderPreview(undefined); setProviderConfirmed(false); }
  }
  const quotaInvalid = !!settings && settings.policy.quota.softLimitPercent > settings.policy.quota.hardLimitPercent;
  async function save(store: FileStore) {
    if (store === 'policy' && quotaInvalid) { setError(assignmentSettingText[lang].quotaError); return; }
    const revision = edits.current[store];
    const patch = settings![store];
    await perform(async () => {
      const result = await requestSettings<{ saved: boolean; existingPayloadDeletion?: string }>(client, 'settings.write', {
        store, patch, ...(store === 'policy' ? { previewToken: preview?.token } : {}), confirmation,
      });
      if (edits.current[store] === revision) dirty.current.delete(store);
      if (store === 'policy') setPreview(undefined);
      setNotice(result.existingPayloadDeletion === 'requires_confirmation'
        ? text('Saved. Existing payloads have not been deleted; separate confirmation is required.', '保存しました。既存の本文は未削除。別の確認が必要です。')
        : text('Saved', '保存しました'));
    });
  }
  async function previewPolicy() {
    if (quotaInvalid) { setError(assignmentSettingText[lang].quotaError); return; }
    const revision = edits.current.policy;
    const patch = settings!.policy;
    await perform(async () => {
      const result = await requestSettings<PolicyPreview>(client, 'settings.previewPolicy', { patch });
      if (edits.current.policy === revision) setPreview(result);
    });
  }
  function fields(store: FileStore, value: Record<string, unknown>, section?: string) {
    return <SettingsFields value={value} language={lang} prefix={section ?? ''} inheritIsolation={store === 'project'} onChange={next => edit(store, section ? { ...settings![store], [section]: next } : next)}/>;
  }
  if (policyOnly) return <div className="assignment-settings settings-page">{error && <p role="alert">{displayError(error)}</p>}{settings ? <PolicyEditor client={client} policy={settings.policy} models={models} language={lang} dirty={dirty.current.has('policy')} onChange={next => edit('policy', next)} onSaved={revision => { if (latestPolicy.current === revision) dirty.current.delete('policy'); setNotice(text('Saved', '保存しました')); }} onRefresh={provider => void perform(async () => { const result = await requestSettings<ModelCatalog[string]>(client, 'settings.models', { provider }); setModels(previous => ({ ...previous, [provider]: result })); })}/> : <p>{text('Loading settings…', '設定を読み込み中…')}</p>}{notice && <p role="status">{notice}</p>}</div>;
  return <div className={policyOnly ? "assignment-settings settings-page" : "page settings-page"}>{!policyOnly && <header className="page-header"><div className="page-title"><p className="eyebrow">agent-graph</p><h1>{text('Settings', '設定')}</h1></div>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => { dirty.current.clear(); setPreview(undefined); setSettings(await requestSettings(client, 'settings.read')); })}>{text('Reload settings', '設定を読み直す')}</button></header>}
    {error && <p role="alert" className="banner banner-danger">{displayError(error)}</p>}{notice && <p role="status" className="banner">{notice}</p>}
    {Object.entries(settings?.errors ?? {}).map(([store, reason]) => <p key={store} role="alert" className="banner banner-warning">{text(store, ({ config: '個人設定', policy: '割り当て', project: 'プロジェクト' })[store] ?? store)}: {displayError(reason)}<small className="settings-note">{text('Previous valid settings remain active.', '前の有効な値で動き続けます。')}</small></p>)}
    {!settings ? <p>{text('Loading settings…', '設定を読み込み中…')}</p> : <>
    {!policyOnly && <SettingsSection title={text('Agents and models', 'エージェントとモデル')}>
      {fields('config', settings.config.agents, 'agents')}
      {fields('config', settings.config.approval, 'approval')}
      {fields('config', settings.config.isolation, 'isolation')}
      <label><span><strong>{text('Confirm authentication switch for active conversations', '動いている会話の認証切り替えを確認')}</strong></span><input type="checkbox" checked={confirmation} onChange={event => setConfirmation(event.target.checked)}/></label>
      <label><span><strong>{text('Claude API key', 'Claude API キー')}</strong><small>{settings.apiKeyConfigured ? text('Configured', '設定済み') : text('Not configured', '未設定')}</small></span><input type="password" aria-label="Claude API key" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)}/></label>
      <p className="settings-note">{text('Stored in Keychain without redisplay and applied on the next launch.', 'Keychain に保存して再表示せず、次の起動から反映します。')}</p>
      <div className="button-row"><button className="btn btn-secondary" disabled={busy || !apiKey} onClick={() => { const value = apiKey; setApiKey(''); void perform(async () => { const result = await requestSettings<{ configured: boolean }>(client, 'settings.apiKey', { value }); setSettings(previous => previous && { ...previous, apiKeyConfigured: result.configured }); }); }}>{text('Store API key', 'API キーを保存')}</button>
      <button className="btn btn-ghost" disabled={busy || !settings.apiKeyConfigured} onClick={() => void perform(async () => { await requestSettings(client, 'settings.apiKey', { remove: true }); setSettings(previous => previous && { ...previous, apiKeyConfigured: false }); })}>{text('Remove API key', 'API キーを削除')}</button></div>

    </SettingsSection>}
    <SettingsSection title={text('Assignment policy', 'モデルの割り当て設定')}>
      <ModelAssignments policy={settings.policy} models={models} language={lang} applyDisabled={busy || dirty.current.has('policy')} onApply={() => void perform(async () => { const revision = edits.current.policy; setProviderConfirmed(false); const previews = await Promise.all(['claude', 'codex', 'antigravity'].map(provider => requestSettings<NonNullable<typeof providerPreview>[number]>(client, 'settings.previewProvider', { provider }))); if (revision === edits.current.policy && !dirty.current.has('policy')) setProviderPreview(previews); })} onChange={next => edit('policy', next)} onRefresh={provider => void perform(async () => { const result = await requestSettings<ModelCatalog[string]>(client, 'settings.models', { provider }); setModels(previous => ({ ...previous, [provider]: result })); })}/>

      {providerPreview && <div role="region" aria-label={text('Provider changes', '提供元への変更')}>
        {providerPreview.flatMap(preview => preview.files).map(file => <div key={file.path}><p><code>{file.path}</code></p><pre className="provider-diff">{file.diff}</pre></div>)}
        {!providerPreview.some(preview => preview.files.length) && <p>{text('No changes', '変更はありません')}</p>}
        {providerPreview.filter(preview => preview.mcpCommand).map(preview => <p key={preview.provider}>{text('Register agent-graph MCP:', 'agent-graph の MCP を登録:')} <code>{preview.mcpCommand}</code></p>)}
        <label><input type="checkbox" checked={providerConfirmed} onChange={event => setProviderConfirmed(event.target.checked)}/>{text('Update the Claude Code, Codex and Antigravity configuration files. Continue?', 'Claude Code、Codex、Antigravity の設定ファイルを更新します。よろしいですか？')}</label>
        <div className="button-row"><button className="btn btn-secondary" disabled={busy || !providerConfirmed} onClick={() => void perform(async () => { for (const preview of providerPreview) { await requestSettings(client, 'settings.applyProvider', { provider: preview.provider, token: preview.token, confirmation: true }); setProviderPreview(previous => { const remaining = previous?.filter(entry => entry.provider !== preview.provider); return remaining?.length ? remaining : undefined; }); } setProviderPreview(undefined); setProviderConfirmed(false); setNotice(text('Applied', '反映しました')); })}>{text('Confirm and apply', '確認して反映')}</button><button className="btn btn-ghost" onClick={() => { setProviderPreview(undefined); setProviderConfirmed(false); }}>{text('Cancel', '取り消す')}</button></div>
      </div>}
      <SettingsFields value={{ maxRoundTrips: settings.policy.maxRoundTrips, quota: settings.policy.quota, performance: settings.policy.performance, constraints: settings.policy.constraints }} language={lang} onChange={next => edit('policy', { ...settings.policy, ...next })}/>
      <div className="button-row"><button className="btn btn-secondary" disabled={busy || quotaInvalid} onClick={() => void previewPolicy()}>{text('Preview policy', '割り当てをプレビュー')}</button>
      <button className="btn btn-primary" disabled={busy || quotaInvalid || !preview} onClick={() => void save('policy')}>{text('Save policy', '割り当てを保存')}</button></div>
      {preview && <div role="region" aria-label={text('Policy preview', '割り当てのプレビュー')}><table><thead><tr><th>{text('Delegation', '依頼')}</th><th>{text('Before', '変更前')}</th><th>{text('After', '変更後')}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.id}><td>{row.id}</td><td>{describeDecision(row.before)}</td><td>{describeDecision(row.after)}</td></tr>)}</tbody></table>{!preview.rows.length && <p>{text('No past delegations available.', 'プレビューできる過去の依頼がありません。')}</p>}</div>}
    </SettingsSection>
    {!policyOnly && <SettingsSection title={text('Projects', 'プロジェクト')}>
      {fields('project', settings.project as unknown as Record<string, unknown>)}
      <button className="btn btn-primary" disabled={busy} onClick={() => void save('project')}>{text('Save project', 'プロジェクトを保存')}</button>
      {fields('config', settings.config.observation, 'observation')}
    </SettingsSection>}
    {!policyOnly && <SettingsSection title={text('Notifications', '通知')}>
      {NOTIFICATION_KINDS.map(kind => <label key={kind}><span><strong>{notificationLabel(kind, lang)}</strong></span><select aria-label={notificationLabel(kind, lang)} value={preferences[kind]} onChange={event => { const next = { ...preferences, [kind]: event.target.value } as NotificationPreferences; setPreferences(next); localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); }}>
        <option value="in_app">{text('In-app', '画面内')}</option><option value="browser">{text('Browser', 'ブラウザ')}</option><option value="silent">{text('Off', 'オフ')}</option></select></label>)}
      <div className="button-row"><span>{text('Browser permission', 'ブラウザ通知の許可')}: {text(permission, ({ granted: '許可済み', denied: '拒否済み', default: '未設定', unavailable: '利用できません' })[permission] ?? permission)}</span><button className="btn btn-secondary" disabled={permission === 'unavailable'} onClick={() => void perform(async () => { const next = await Notification.requestPermission(); setPermission(next); if (next !== 'granted') { const fallback = Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind, preferences[kind] === 'browser' ? 'in_app' : preferences[kind]])) as NotificationPreferences; setPreferences(fallback); localStorage.setItem(PREFERENCES_KEY, JSON.stringify(fallback)); setNotice(text('Browser permission denied; using in-app notifications.', '通知の許可がないため画面内に切り替えました。')); } })}>{text('Request browser permission', 'ブラウザ通知を許可')}</button></div>
      {fields('config', settings.config.notifications, 'notifications')}
    </SettingsSection>}
    {!policyOnly && <SettingsSection title={text('Storage and redaction', 'データの保存とマスキング')}>
      {fields('config', settings.config.storage, 'storage')}
    </SettingsSection>}
    {!policyOnly && <SettingsSection title={text('Runner and API status', 'ランナーと API の状態')}>
      {status ? <><dl className="fields">{(['claude', 'codex'] as const).map(provider => <div key={provider}><dt>{provider}</dt><dd>{status.hosts[provider].state} · {text('Version', 'バージョン')}: {status.hosts[provider].version ?? text('Unknown', '不明')} · {text('Authentication', '認証')}: {status.hosts[provider].authentication ?? text('Unknown', '不明')} · {text('Degraded', '一部制限')}: {status.hosts[provider].degraded.join(', ') || text('None reported', '報告なし')}</dd></div>)}
        <div><dt>{text('Runner connection', 'ランナーの接続')}</dt><dd>{String(status.connection.runner)}</dd></div><div><dt>{text('Protocol version', 'プロトコルバージョン')}</dt><dd>{status.connection.protocolVersion}</dd></div><div><dt>{text('API version', 'API バージョン')}</dt><dd>{status.connection.apiVersion}</dd></div><div><dt>{text('Update pending', '更新待ち')}</dt><dd>{String(status.connection.updatePending)}</dd></div>
        <div><dt>{text('Observation formats', '監視ログの形式')}</dt><dd>{status.observation.formats.join(', ')}</dd></div><div><dt>{text('Unsupported histories', '未対応の履歴')}</dt><dd>{status.observation.unsupportedCount}</dd></div></dl>
        <p role="status">{text('Rebuild', '再構築')}: {status.rebuild.state} · {status.rebuild.completed} / {status.rebuild.total}</p><progress aria-label={text('Rebuild progress', '再構築の進捗')} value={status.rebuild.completed} max={Math.max(1, status.rebuild.total)}/>
        <button className="btn btn-secondary" disabled={busy || status.rebuild.state === 'running'} onClick={() => void perform(async () => { await requestSettings(client, 'settings.rebuild'); setStatus(previous => previous && { ...previous, rebuild: { state: 'running', completed: 0, total: 0 } }); })}>{text('Rebuild ledger projection', '履歴データの再構築')}</button>
        <dl className="fields">{Object.entries(status.logs).map(([name, path]) => <div key={name}><dt>{name} {text('log', 'ログ')}</dt><dd><code>{path}</code> <button className="btn btn-link" onClick={() => void perform(async () => { await navigator.clipboard.writeText(path); setNotice(text('Log path copied', 'ログのパスをコピーしました')); })}>{text('Copy path', 'パスをコピー')}</button></dd></div>)}</dl></> : <p>{text('Status unknown', '状態は不明です')}</p>}
      {fields('config', settings.config.dashboard, 'dashboard')}
      <p className="settings-note">{text('Applies after API restart. The legacy daemon port is not allowed.', 'API の再起動で反映します。旧 daemon のポートは使えません。')}</p>
    </SettingsSection>}
    {!policyOnly && <SettingsSection title={text('Keyboard shortcuts', 'キーボードショートカット')}>
      {fields('config', settings.config.keys, 'keys')}
    </SettingsSection>}
    {!policyOnly && <div className="button-row"><button className="btn btn-primary" disabled={busy} onClick={() => void save('config')}>{text('Save personal settings', '個人の設定を保存')}</button></div>
    }</>}
    {!policyOnly && <SettingsSection title={text('Appearance', '外観')}>
      {(Object.entries(APPEARANCE_CHOICES) as [keyof Appearance, readonly string[]][]).map(([key, options]) => <label key={key}><span><strong>{text(({ theme: 'Theme', density: 'Density', diff: 'Diff layout', time: 'Time display', language: 'Language' })[key], ({ theme: 'テーマ', density: '表示密度', diff: '差分の表示方式', time: '時刻の表示', language: '言語' })[key])}</strong></span>
        <select aria-label={key} value={appearance[key]} onChange={event => { const next = { ...appearance, [key]: event.target.value } as Appearance; setAppearance(next); saveAppearance(next); onAppearance?.(next); }}>{options.map(option => <option key={option} value={option}>{option === 'ja' ? '日本語' : option === 'en' ? 'English' : option}</option>)}</select></label>)}
    </SettingsSection>}
  </div>;
}
