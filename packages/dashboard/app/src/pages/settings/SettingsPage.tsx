import { useEffect, useRef, useState } from 'react';
import { SettingsFields, SettingsSection } from '../../components/settings/SettingsFields.tsx';
import { APPEARANCE_CHOICES, loadAppearance, saveAppearance, requestSettings, describeDecision,
  type Appearance, type PolicyPreview, type SettingsClient, type SettingsSnapshot, type SettingsStatus } from '../../lib/settings.ts';
import { loadPreferences, NOTIFICATION_KINDS, notificationLabel, PREFERENCES_KEY, type NotificationPreferences } from '../../components/notifications/model.ts';
import { modelName } from '../../lib/format.ts';
import './settings.css';

const REFRESH_MS = 1500;
type FileStore = 'config' | 'policy' | 'project';
export function SettingsPage({ client, language, onAppearance }: { client: SettingsClient; language?: 'en' | 'ja'; onAppearance?(value: Appearance): void }) {
  const [appearance, setAppearance] = useState(loadAppearance);
  const lang = language ?? appearance.language;
  const ja = lang === 'ja';
  const text = (en: string, jp: string) => ja ? jp : en;
  const [settings, setSettings] = useState<SettingsSnapshot>();
  const [status, setStatus] = useState<SettingsStatus>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PolicyPreview>();
  const [apiKey, setApiKey] = useState('');
  const [confirmation, setConfirmation] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => loadPreferences(localStorage));
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unavailable' : Notification.permission);
  const [models, setModels] = useState<Record<string, { state: string; models: { model: string; displayName: string }[] }>>({});
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
        setSettings(previous => previous ? { ...read, ...Object.fromEntries([...dirty.current].map(store => [store, previous[store]])) } : read);
        setStatus(nextStatus);
      } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'Settings unavailable'); }
      finally { refreshing = false; }
    }
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => saveAppearance(appearance);
    apply(); media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appearance]);
  async function perform(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : text('Settings operation failed', '設定の操作に失敗しました')); }
    finally { setBusy(false); }
  }
  function edit(store: FileStore, value: unknown) {
    edits.current[store] += 1;
    dirty.current.add(store);
    setSettings(previous => previous && { ...previous, [store]: value });
    if (store === 'policy') setPreview(undefined);
  }
  async function save(store: FileStore) {
    const revision = edits.current[store];
    const patch = settings![store];
    await perform(async () => {
      const result = await requestSettings<{ saved: boolean; existingPayloadDeletion?: string }>(client, 'settings.write', {
        store, patch, ...(store === 'policy' ? { previewToken: preview?.token } : {}), confirmation,
      });
      if (edits.current[store] === revision) dirty.current.delete(store);
      if (store === 'policy') setPreview(undefined);
      setNotice(result.existingPayloadDeletion ? text('Saved for future facts. Existing payload deletion requires a separate confirmation; existing history is retained.', '新しい事実向けに保存しました。既存の本文の削除には別の確認が必要です。履歴は保持しています。') : text('Saved', '保存しました'));
    });
  }
  async function previewPolicy() {
    const revision = edits.current.policy;
    const patch = settings!.policy;
    await perform(async () => {
      const result = await requestSettings<PolicyPreview>(client, 'settings.previewPolicy', { patch });
      if (edits.current.policy === revision) setPreview(result);
    });
  }
  function fields(store: FileStore, value: Record<string, unknown>, hint: string, section?: string) {
    return <SettingsFields value={value} language={lang} prefix={section ?? ''} hint={hint} inheritIsolation={store === 'project'} onChange={next => edit(store, section ? { ...settings![store], [section]: next } : next)}/>;
  }
  const nextConversation = text('Applies to new conversations. Authentication and API keys apply on the next launch.', '新しい会話から反映します。認証と API キーは次の起動から反映します。');
  const nextDelegation = text('Applies to future delegations and decisions. Existing delegations keep their assignment.', '次の委譲と判断から反映します。進行中の割り当ては変えません。');
  return <div className="page settings-page"><header className="page-header"><div className="page-title"><p className="eyebrow">agent-graph</p><h1>{text('Settings', '設定')}</h1><p className="page-subtitle">{text('Personal settings, assignment policy, project settings and browser preferences.', '個人の設定、割り当ての決まり、プロジェクトの設定、ブラウザの見た目。')}</p></div>
    <button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => { dirty.current.clear(); setPreview(undefined); setSettings(await requestSettings(client, 'settings.read')); })}>{text('Reload settings', '設定を読み直す')}</button></header>
    {error && <p role="alert" className="banner banner-danger">{error}</p>}{notice && <p role="status" className="banner">{notice}</p>}
    {Object.entries(settings?.errors ?? {}).map(([store, reason]) => <p key={store} role="alert" className="banner banner-warning">{store}: {reason} · {text('Previous valid settings remain active.', '前の有効な値で動き続けます。')}</p>)}
    {!settings ? <p>{text('Loading settings…', '設定を読み込み中…')}</p> : <>
    <SettingsSection title={text('Agents and models', 'エージェントとモデル')} store="config.toml / Keychain" hint={nextConversation}>
      {fields('config', settings.config.agents, nextConversation, 'agents')}
      {fields('config', settings.config.approval, text('Applies on the next turn. Relaxed approval is recorded for active runs.', '次のターンから反映します。承認を緩めた旨は実行の記録に残します。'), 'approval')}
      {fields('config', settings.config.isolation, text('Applies to the next execution.', '次の実行から反映します。'), 'isolation')}
      <label><span><strong>{text('Confirm authentication switch for active conversations', '動いている会話の認証切り替えを確認')}</strong><small>{text('Review active Claude conversations before switching.', '切り替える前に動いている Claude の会話を確認してください。')}</small></span><input type="checkbox" checked={confirmation} onChange={event => setConfirmation(event.target.checked)}/></label>
      <label><span><strong>{text('Claude API key', 'Claude API キー')}</strong><small>{text('Stored in Keychain; never displayed again. Applies on the next launch.', 'Keychain に保存し、値は再表示しません。次の起動から反映します。')} · {settings.apiKeyConfigured ? text('Configured', '設定済み') : text('Not configured', '未設定')}</small></span><input type="password" aria-label="Claude API key" autoComplete="new-password" value={apiKey} onChange={event => setApiKey(event.target.value)}/></label>
      <div className="button-row"><button className="btn btn-secondary" disabled={busy || !apiKey} onClick={() => { const value = apiKey; setApiKey(''); void perform(async () => { const result = await requestSettings<{ configured: boolean }>(client, 'settings.apiKey', { value }); setSettings(previous => previous && { ...previous, apiKeyConfigured: result.configured }); }); }}>{text('Store API key', 'API キーを保存')}</button>
      <button className="btn btn-ghost" disabled={busy || !settings.apiKeyConfigured} onClick={() => void perform(async () => { await requestSettings(client, 'settings.apiKey', { remove: true }); setSettings(previous => previous && { ...previous, apiKeyConfigured: false }); })}>{text('Remove API key', 'API キーを削除')}</button></div>
      {(['claude', 'codex'] as const).map(provider => <div key={provider} className="settings-models"><button className="btn btn-secondary" disabled={busy} onClick={() => void perform(async () => { const result = await requestSettings<{ state: string; models: { model: string; displayName: string }[] }>(client, 'settings.models', { provider }); setModels(previous => ({ ...previous, [provider]: result })); })}>{text(`Refresh ${provider} models`, `${provider} のモデルを更新`)}</button>
        <p>{models[provider]?.state === 'known' ? models[provider].models.map(model => modelName(model.model || model.displayName)).join(', ') : text('Available models: Unknown', '利用できるモデル: 不明')}</p></div>)}
    </SettingsSection>
    <SettingsSection title={text('Assignment policy', '割り当ての決まり')} store="policy.toml" hint={nextDelegation}>
      {fields('policy', settings.policy as unknown as Record<string, unknown>, nextDelegation)}
      <p className="muted-text">{text('Preview past delegations before saving. Missing historical quota or performance data uses the static candidate order.', '保存前に過去の委譲で試算します。過去の利用枠や実績が記録されていない場合は静的な候補順を使います。')}</p>
      <div className="button-row"><button className="btn btn-secondary" disabled={busy} onClick={() => void previewPolicy()}>{text('Preview policy', '割り当てを試算')}</button>
      <button className="btn btn-primary" disabled={busy || !preview} onClick={() => void save('policy')}>{text('Save policy', '割り当てを保存')}</button></div>
      {preview && <div role="region" aria-label={text('Policy preview', '割り当ての試算')}><table><thead><tr><th>{text('Delegation', '委譲')}</th><th>{text('Before', '変更前')}</th><th>{text('After', '変更後')}</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.id}><td>{row.id}</td><td>{describeDecision(row.before)}</td><td>{describeDecision(row.after)}</td></tr>)}</tbody></table>{!preview.rows.length && <p>{text('No past delegations available.', '試算できる過去の委譲がありません。')}</p>}</div>}
    </SettingsSection>
    <SettingsSection title={text('Projects', 'プロジェクト')} store="agent-graph.toml / config.toml / ledger" hint={text('Project isolation applies to the next execution; acceptance and exclusions apply to the next delegation. Blank isolation inherits the personal default.', '隔離は次の実行、受け入れと除外は次の委譲から反映します。空の隔離は個人の既定を継ぎます。')}>
      {fields('project', settings.project as unknown as Record<string, unknown>, text('Applies to future executions and delegations; inherit personal isolation by leaving it blank.', '次の実行と委譲から反映します。隔離の空欄は個人の既定を継ぎます。'))}
      <button className="btn btn-primary" disabled={busy} onClick={() => void save('project')}>{text('Save project', 'プロジェクトを保存')}</button>
      {fields('config', settings.config.observation, text('Changes observation immediately. Excluded history stops being read.', '観測の範囲は即座に変わります。除外した履歴は読まなくなります。'), 'observation')}
      <p>{text('Repository registration and name prefixes are ledger facts. Registration starts observation; unregistering stops it and retains history. Prefix changes affect future names.', '登録と名前の前置きは台帳の事実です。登録で観測を開始し、解除で止め、履歴は残します。前置きは次の採番から反映します。')}</p>
      <p className="banner banner-unknown">{text('Repository registration and prefix commands are unavailable in this Settings API.', 'この Settings API には登録と前置きの操作がありません。')}</p>
    </SettingsSection>
    <SettingsSection title={text('Notifications', '通知')} store="localStorage / config.toml / browser" hint={text('Notification routes apply immediately to this browser.', '通知の経路はこのブラウザで即座に反映します。')}>
      {NOTIFICATION_KINDS.map(kind => <label key={kind}><span><strong>{notificationLabel(kind, lang)}</strong></span><select aria-label={notificationLabel(kind, lang)} value={preferences[kind]} onChange={event => { const next = { ...preferences, [kind]: event.target.value } as NotificationPreferences; setPreferences(next); localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next)); }}>
        <option value="in_app">{text('In-app', '画面内')}</option><option value="browser">{text('Browser', 'ブラウザ')}</option><option value="silent">{text('Off', 'オフ')}</option></select></label>)}
      <div className="button-row"><span>{text('Browser permission', 'ブラウザ通知の許可')}: {text(permission, ({ granted: '許可済み', denied: '拒否済み', default: '未設定', unavailable: '利用できません' })[permission] ?? permission)}</span><button className="btn btn-secondary" disabled={permission === 'unavailable'} onClick={() => void perform(async () => { const next = await Notification.requestPermission(); setPermission(next); if (next !== 'granted') { const fallback = Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind, preferences[kind] === 'browser' ? 'in_app' : preferences[kind]])) as NotificationPreferences; setPreferences(fallback); localStorage.setItem(PREFERENCES_KEY, JSON.stringify(fallback)); setNotice(text('Browser permission denied; using in-app notifications.', '通知の許可がないため画面内に切り替えました。')); } })}>{text('Request browser permission', 'ブラウザ通知を許可')}</button></div>
      {fields('config', settings.config.notifications, text('Quiet hours apply immediately. Approval waiting can bypass them.', '静かな時間は即座に反映します。承認待ちを例外にできます。'), 'notifications')}
    </SettingsSection>
    <SettingsSection title={text('Storage and redaction', '保存と秘匿')} store="config.toml" hint={text('Scope and redaction apply to new facts. Retention applies at the next cleanup. Existing deletion requires confirmation; rescan applies redaction to existing facts.', '範囲と秘匿は新しい事実、保持期間は次の整理から反映します。既存の削除は確認が必要です。既存への秘匿は再走査で適用します。')}>
      {fields('config', settings.config.storage, text('New facts only; retention changes apply at the next cleanup. Patterns are validated before saving.', '新しい事実から反映します。保持期間は次の整理から反映し、正規表現は保存前に検証します。'), 'storage')}
      <p>{text('Defaults: tool output scope, 90 days for bodies, metadata forever. Cleanup retains fact IDs and hashes. Default rules redact known keys, .env values, private keys and high-entropy secret values.', '既定は道具の出力まで、本文は 90 日、メタは無期限です。整理でも事実の ID とハッシュは残します。既知の鍵、.env の値、秘密鍵、高エントロピーの秘密値を秘匿します。')}</p>
      <p className="banner banner-unknown">{text('Existing payload deletion, cleanup counts and redaction rescan commands are unavailable in this Settings API.', 'この Settings API には既存の削除、整理の件数と秘匿の再走査の操作がありません。')}</p>
    </SettingsSection>
    <SettingsSection title={text('Runner and API status', 'runner と api の状態')} store={text('Live status / config.toml', '現在の状態 / config.toml')} hint={text('API restart preserves executions. Runner updates wait for idle runs; forced updates recover through unknown.', 'api の再起動で実行は止まりません。runner の更新は実行が無いときに行い、強制更新は不明を経て復帰します。')}>
      {status ? <><dl className="fields">{(['claude', 'codex'] as const).map(provider => <div key={provider}><dt>{provider}</dt><dd>{status.hosts[provider].state} · {text('Version', '版')}: {status.hosts[provider].version ?? text('Unknown', '不明')} · {text('Authentication', '認証')}: {status.hosts[provider].authentication ?? text('Unknown', '不明')} · {text('Degraded', '縮退')}: {status.hosts[provider].degraded.join(', ') || text('None reported', '報告なし')}</dd></div>)}
        <div><dt>{text('Runner connection', 'runner の接続')}</dt><dd>{String(status.connection.runner)}</dd></div><div><dt>{text('Protocol version', '通信の版')}</dt><dd>{status.connection.protocolVersion}</dd></div><div><dt>{text('API version', 'api の版')}</dt><dd>{status.connection.apiVersion}</dd></div><div><dt>{text('Update pending', '更新待ち')}</dt><dd>{String(status.connection.updatePending)}</dd></div>
        <div><dt>{text('Observation formats', '観測の対応形式')}</dt><dd>{status.observation.formats.join(', ')}</dd></div><div><dt>{text('Unsupported histories', '未対応の履歴')}</dt><dd>{status.observation.unsupportedCount}</dd></div></dl>
        <p role="status">{text('Rebuild', '再構築')}: {status.rebuild.state} · {status.rebuild.completed} / {status.rebuild.total}</p><progress aria-label={text('Rebuild progress', '再構築の進捗')} value={status.rebuild.completed} max={Math.max(1, status.rebuild.total)}/>
        <button className="btn btn-secondary" disabled={busy || status.rebuild.state === 'running'} onClick={() => void perform(async () => { await requestSettings(client, 'settings.rebuild'); setStatus(previous => previous && { ...previous, rebuild: { state: 'running', completed: 0, total: 0 } }); })}>{text('Rebuild ledger projection', '台帳の投影を再構築')}</button>
        <dl className="fields">{Object.entries(status.logs).map(([name, path]) => <div key={name}><dt>{name} {text('log', 'ログ')}</dt><dd><code>{path}</code> <button className="btn btn-link" onClick={() => void perform(async () => { await navigator.clipboard.writeText(path); setNotice(text('Log path copied', 'ログの場所をコピーしました')); })}>{text('Copy path', '場所をコピー')}</button></dd></div>)}</dl></> : <p>{text('Status unknown', '状態は不明です')}</p>}
      {fields('config', settings.config.dashboard, text('Applies after API restart. The legacy daemon port is not allowed.', 'api の再起動で反映します。旧 daemon のポートは使えません。'), 'dashboard')}
    </SettingsSection>
    <SettingsSection title={text('Keyboard shortcuts', 'キー操作')} store="config.toml [keys]" hint={text('Applies immediately. Duplicate bindings are rejected.', '即座に反映します。重複する割り当ては拒否します。')}>
      {fields('config', settings.config.keys, text('Search: Cmd+K; navigate: g h/w/i/t/c; rows: j/k; approvals: a/d; interrupt confirmation: Esc; help: ?.', '検索: Cmd+K、移動: g h/w/i/t/c、行: j/k、承認: a/d、中断の確認: Esc、一覧: ?。'), 'keys')}
    </SettingsSection>
    <div className="button-row"><button className="btn btn-primary" disabled={busy} onClick={() => void save('config')}>{text('Save personal settings', '個人の設定を保存')}</button><small>{text('Saves all config.toml sections. Invalid values retain the previous settings.', 'config.toml の全節を保存します。不正な値なら前の設定を保持します。')}</small></div>
    </>}
    <SettingsSection title={text('Appearance', '外観')} store="localStorage" hint={text('Applies immediately to this browser. Preferences are never sent to the API.', 'このブラウザで即座に反映します。見た目は api に送りません。')}>
      {(Object.entries(APPEARANCE_CHOICES) as [keyof Appearance, readonly string[]][]).map(([key, options]) => <label key={key}><span><strong>{text(({ theme: 'Theme', density: 'Density', diff: 'Diff layout', time: 'Time display', language: 'Language' })[key], ({ theme: 'テーマ', density: '密度', diff: '差分の表示方式', time: '時刻の表示', language: '言語' })[key])}</strong></span>
        <select aria-label={key} value={appearance[key]} onChange={event => { const next = { ...appearance, [key]: event.target.value } as Appearance; setAppearance(next); saveAppearance(next); onAppearance?.(next); }}>{options.map(option => <option key={option} value={option}>{option === 'ja' ? '日本語' : option === 'en' ? 'English' : option}</option>)}</select></label>)}
    </SettingsSection>
  </div>;
}
