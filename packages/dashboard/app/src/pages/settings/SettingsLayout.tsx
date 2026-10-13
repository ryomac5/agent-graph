import { useState, type ReactNode } from 'react';
import { SshSettings } from '../../components/SshSettings.tsx';
import { Segments } from '../../components/settings/Controls.tsx';
import { DEFAULT_KEYS, keyLabel, validateBindings, type KeyBindings, type KeyAction } from '../../lib/keys.ts';
import { requestSettings, type SettingsClient } from '../../lib/settings.ts';
import type { Row } from '../../lib/store.ts';

export function SettingsLayout({ children, client, projects, language, theme, onTheme, onLanguage, bindings, onKeys }: {
  children: ReactNode; client: SettingsClient; projects: Row[]; language: 'en' | 'ja'; theme: string;
  onTheme(value: 'system' | 'light' | 'dark'): void; onLanguage(value: 'en' | 'ja'): void; bindings: KeyBindings; onKeys(value: KeyBindings): void;
}) {
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
  const [active, setActive] = useState('models');
  const sections = [['models', text('Models', 'モデル')], ['rules', text('Selection rules', '選び方のルール')], ['appearance', text('Appearance', '表示')], ['ssh', text('SSH connections', 'SSH の接続先')], ['keys', text('Keyboard shortcuts', 'キーボードショートカット')]];
  return <><nav className="settings-nav" aria-label={text('Settings sections', '設定の節')}>{sections.map(([id, label]) => <button className="btn btn-ghost" key={id} aria-current={active === id ? 'location' : undefined} onClick={() => { setActive(id); const element = document.getElementById('settings-' + id); if (element instanceof HTMLDetailsElement) element.open = true; element?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{label}</button>)}</nav>{children}
    <section data-reload-ignore id="settings-appearance" className="settings-section" aria-label={text('Appearance', '表示')}><header><h2>{text('Appearance', '表示')}</h2></header><div className="settings-card"><div className="settings-row"><span>{text('Theme', 'テーマ')}</span><Segments label={text('Theme', 'テーマ')} value={theme} options={['system', 'light', 'dark'].map(value => ({ value, label: text(({ system: 'System', light: 'Light', dark: 'Dark' })[value]!, ({ system: 'OS に合わせる', light: 'ライト', dark: 'ダーク' })[value]!) }))} onChange={value => onTheme(value as 'system' | 'light' | 'dark')}/></div><div className="settings-row"><span>{text('Language', '言語')}</span><Segments label={text('Language', '言語')} value={language} options={[{ value: 'ja', label: '日本語' }, { value: 'en', label: 'English' }]} onChange={value => onLanguage(value as 'ja' | 'en')}/></div></div></section>
    <SshSettings client={client} projects={projects} language={language}/><KeySettings client={client} bindings={bindings} onSave={onKeys} language={language}/></>;
}
const GROUPS: { en: string; ja: string; keys: KeyAction[] }[] = [
  { en: 'Navigation', ja: '移動', keys: ['home', 'workspace', 'inbox', 'tree', 'changes', 'next', 'previous'] },
  { en: 'Conversation', ja: '会話', keys: ['nextTurn', 'recent1', 'recent2', 'recent3', 'recent4', 'recent5', 'recent6', 'recent7', 'recent8', 'recent9', 'interrupt'] },
  { en: 'Approval', ja: '承認', keys: ['allow', 'deny'] },
  { en: 'Screen', ja: '画面', keys: ['command', 'toggleSidebar', 'togglePanel', 'splitHorizontal', 'splitVertical', 'openFile', 'saveFile', 'help'] },
];
function KeySettings({ client, bindings, onSave, language }: { client: SettingsClient; bindings: KeyBindings; onSave(value: KeyBindings): void; language: 'en' | 'ja' }) {
  const [draft, setDraft] = useState<KeyBindings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
  function label(key: KeyAction) { return ({ toggleSidebar: text('Toggle sidebar', '左の区画を開閉'), togglePanel: text('Toggle panel', '右のパネルを開閉'), nextTurn: text('Open the next conversation that needs you', '次に確認が必要な会話を開く'), home: text('Go to Overview', '一覧を開く') } as Partial<Record<KeyAction, string>>)[key] ?? keyLabel(key, language); }
  return <details id="settings-keys" className="settings-section settings-fold"><summary><h2>{text('Keyboard shortcuts', 'キーボードショートカット')}</h2>{draft && <span className="settings-unsaved">{text('Unsaved', '未保存')}</span>}<span className="settings-summary">{Object.keys(DEFAULT_KEYS).length}{text(' shortcuts', ' 件')}</span></summary><div className="settings-card">{GROUPS.map(group => <fieldset key={group.en}><legend>{text(group.en, group.ja)}</legend>{group.keys.map(key => <label key={key}><span>{label(key)}</span><input aria-label={`keys · ${key}`} value={(draft ?? bindings)[key]} disabled={busy} onChange={event => setDraft(previous => ({ ...(previous ?? bindings), [key]: event.target.value }))}/></label>)}</fieldset>)}<div className="button-row settings-actions"><button className="btn btn-primary" disabled={busy || !draft} onClick={() => void (async () => { setBusy(true); setMessage(''); const revision = draft; try { const keys = validateBindings(revision!); await requestSettings(client, 'settings.write', { store: 'config', patch: { keys } }); onSave(keys); setDraft(previous => previous === revision ? undefined : previous); setMessage(text('Saved', '保存しました')); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } })()}>{text('Save', '保存')}</button></div>{message && <p role={['Saved', '保存しました'].includes(message) ? 'status' : 'alert'}>{message}</p>}</div></details>;
}
