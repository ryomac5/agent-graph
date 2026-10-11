import type { ReactNode } from 'react';
import { assignmentSettingText } from '../../lib/i18n.ts';
import { PerformanceWeights } from './PerformanceWeights.tsx';

const choices: Record<string, string[]> = {
  authentication: ['subscription', 'api_key'], integrations: ['disabled', 'strict', 'enabled'],
  'approval.mode': ['untrusted', 'on-request', 'never'], 'isolation.policy': ['read-only', 'workspace-write', 'danger-full-access'],
  'storage.scope': ['metadata', 'message_body', 'tool_output', 'full_diff'], executor: ['claude', 'codex', 'antigravity'], family: ['anthropic', 'openai', 'google'], tier: ['high', 'mid', 'low'],
  kind: ['reviewerDifferentFamily', 'implementerNotOrchestrator', 'minTierForRole'], role: ['implement', 'review', 'research', 'document', 'orchestrate', 'advisor', 'plan', 'proofread'],
};
const labels: Record<string, [string, string]> = {
  quota: ['Quota', '利用枠'], performance: ['Performance', '実績'], constraints: ['Constraints', '制約'],
  model: ['Default model', '既定のモデル'], effort: ['Default effort', '既定の深さ'], authentication: ['Claude authentication', 'Claude の認証'], integrations: ['Claude integrations', 'Claude の外部連携'],
  mode: ['Approval mode', '承認の方式'], policy: ['Isolation policy', '隔離の方針'], repositories: ['Observed repositories', '観測するリポジトリ'],
  claude: ['Observe Claude', 'Claude を観測'], codex: ['Observe Codex', 'Codex を観測'], kit: ['Observe legacy kit', '旧キットを観測'],
  quietStart: ['Quiet hours start', '静かな時間の開始'], quietEnd: ['Quiet hours end', '静かな時間の終了'], timezone: ['Time zone', 'タイムゾーン'], approvalException: ['Approvals bypass quiet hours', '承認待ちは静かな時間の例外'],
  scope: ['Storage scope', '保存の範囲'], bodyRetentionDays: ['Body retention days', '本文の保持日数'], metadataRetentionDays: ['Metadata retention days (blank: forever)', 'メタ情報の保持日数'],
  defaults: ['Default redaction rules', '既定の秘匿規則'], patterns: ['Additional redaction patterns', '追加の秘匿の正規表現'],
  port: ['API port', 'API のポート'], commands: ['Acceptance commands', '受け入れコマンド'], exclude: ['Scope exclusions', '範囲の除外'],
  maxRoundTrips: ['Maximum review round trips', 'レビューの最大往復回数'],
  executor: ['Agent', 'エージェント'], family: ['Model family', 'モデルの系列'], tier: ['Model tier', 'モデルの水準'], kind: ['Constraint', '制約'], role: ['Role', '役割'],
};
export function labelSetting(key: string, language: 'en' | 'ja') { return assignmentSettingText[language][key as keyof typeof assignmentSettingText.en] ?? labels[key]?.[language === 'ja' ? 1 : 0] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2'); }
const constraintLabels: Record<string, [string, string]> = {
  reviewerDifferentFamily: ['Reviewer from a different model family', '異なるモデル系列のレビュアー'],
  implementerNotOrchestrator: ['Implementer separate from orchestrator', '進行役とは別の実装担当'],
  minTierForRole: ['Minimum model tier for a role', '役割ごとのモデル水準の下限'],
};
export function labelConstraint(kind: string, language: 'en' | 'ja') {
  return constraintLabels[kind]?.[language === 'ja' ? 1 : 0] ?? labelSetting(kind, language);
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section" aria-label={title}><header><h2>{title}</h2></header><div className="settings-card">{children}</div></section>;
}
export function SettingsFields({ value, onChange, language, prefix = '', inheritIsolation = false }: {
  value: Record<string, unknown>; onChange(value: Record<string, unknown>): void; language: 'en' | 'ja'; prefix?: string; inheritIsolation?: boolean;
}) {
  const ja = language === 'ja';
  const text = assignmentSettingText[language];
  if (prefix === 'performance.weights') return <PerformanceWeights value={value} onChange={onChange} language={language}/>;
  const quotaInvalid = prefix === 'quota' && Number(value.softLimitPercent) > Number(value.hardLimitPercent);
  return <>{Object.entries(value).map(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const name = `${prefix ? prefix.split('.').map(part => ja ? labelSetting(part, language) : part).join(' · ') + ' · ' : ''}${labelSetting(key, language)}`;
    const update = (next: unknown) => onChange({ ...value, [key]: next });
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) return <fieldset key={key}><legend>{prefix === 'agents' ? key : labelSetting(key, language)}</legend><SettingsFields value={entry as Record<string, unknown>} onChange={update} language={language} prefix={path} inheritIsolation={inheritIsolation}/></fieldset>;
    if (Array.isArray(entry) && (key === 'constraints' || path.startsWith('roles.'))) {
      const template = key === 'constraints' ? { kind: 'reviewerDifferentFamily' } : { executor: 'codex', model: 'gpt-6-astra', family: 'openai', tier: 'high' };
      return <fieldset key={key}><legend>{labelSetting(key, language)}</legend>{entry.map((item, index) => <fieldset key={index} className="settings-array-row" aria-label={key === 'constraints' ? `${labelSetting('kind', language)} ${index + 1}` : undefined}>{key !== 'constraints' && <legend>{index + 1}</legend>}
        <SettingsFields value={item as Record<string, unknown>} onChange={next => {
          if (key === 'constraints') next = next.kind === 'minTierForRole' ? { kind: next.kind, role: next.role ?? 'implement', tier: next.tier ?? 'high' } : { kind: next.kind };
          update(entry.map((old, at) => at === index ? next : old));
        }} language={language} prefix={`${path}.${index + 1}`}/>
        <div className="button-row"><button type="button" className="btn btn-secondary btn-sm" disabled={index === 0} aria-label={`${name} ${index + 1} ${ja ? '上へ' : 'Move up'}`} onClick={() => { const next = [...entry]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; update(next); }}>{ja ? '上へ' : 'Move up'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => update(entry.filter((_, at) => at !== index))}>{ja ? '削除' : 'Remove'}</button></div></fieldset>)}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => update([...entry, template])}>{ja ? labelSetting(key, language) + 'を追加' : key === 'constraints' ? 'Add constraint' : 'Add ' + labelSetting(key, language)}</button></fieldset>;
    }
    const options = choices[path] ?? choices[key];
    const displayName = labelSetting(key, language);
    const unit = prefix === 'quota' && (key === 'softLimitPercent' || key === 'hardLimitPercent') ? '%' : prefix === 'performance' && key === 'minSamples' ? text.runs : undefined;
    const title = key === 'softLimitPercent' ? text.softTitle : key === 'hardLimitPercent' ? text.hardTitle : key === 'minSamples' ? text.samplesTitle : undefined;
    const input = <input aria-label={name} aria-invalid={quotaInvalid || undefined} title={quotaInvalid ? text.quotaError : title} max={unit === '%' ? 100 : undefined} type={typeof entry === 'number' || entry === null ? 'number' : key.startsWith('quiet') ? 'time' : 'text'} min={typeof entry === 'number' || entry === null ? 0 : undefined} step={unit ? 1 : undefined}
      value={entry === null ? '' : String(entry)} onChange={event => update(entry === null || typeof entry === 'number' ? event.target.value === '' && key === 'metadataRetentionDays' ? null : Number(event.target.value) : event.target.value)}/>;
    return <label key={key} title={quotaInvalid ? text.quotaError : title}><span><strong>{displayName}</strong></span>
      {options ? <select className={key === 'kind' ? 'settings-constraint' : undefined} aria-label={name} value={entry === null ? '' : String(entry)} onChange={event => update(event.target.value || null)}>
        {inheritIsolation && path === 'isolation.policy' ? <option value="">{ja ? '個人の既定を継ぐ' : 'Inherit default'}</option> : null}
        {options.map(option => <option key={option} value={option}>{key === 'kind' ? labelConstraint(option, language) : option}</option>)}</select>
      : Array.isArray(entry) ? <textarea aria-label={name} value={entry.join('\n')} rows={3} onChange={event => update(event.target.value.split('\n').filter(Boolean))}/>
      : typeof entry === 'boolean' ? <input aria-label={name} type="checkbox" checked={entry} onChange={event => update(event.target.checked)}/>
      : unit ? <span className="settings-number-unit">{input}<span>{unit}</span></span> : input}</label>;
  })}</>;
}
