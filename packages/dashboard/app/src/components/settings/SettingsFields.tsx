import { SettingMenu } from './Controls.tsx';
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
  quota: ['Quota', '利用枠'], performance: ['Track record', '実績'], constraints: ['Constraints', '制約'],
  model: ['Default model', 'デフォルトのモデル'], effort: ['Default effort', 'デフォルトの思考量'], authentication: ['Claude authentication', 'Claude の認証'], integrations: ['Claude integrations', 'Claude の外部連携'],
  mode: ['Approval mode', '承認の方式'], policy: ['Isolation policy', '隔離の方針'], repositories: ['Observed repositories', '監視対象リポジトリ'],
  claude: ['Observe Claude', 'Claude を監視'], codex: ['Observe Codex', 'Codex を監視'], kit: ['Observe legacy kit', '旧キットを監視'],
  quietStart: ['Quiet hours start', '通知を止める時間帯の開始'], quietEnd: ['Quiet hours end', '通知を止める時間帯の終了'], timezone: ['Time zone', 'タイムゾーン'], approvalException: ['Approvals bypass quiet hours', '承認待ちは時間帯によらず通知'],
  scope: ['Storage scope', '保存の範囲'], bodyRetentionDays: ['Body retention days', '本文の保持日数'], metadataRetentionDays: ['Metadata retention days (blank: forever)', 'メタ情報の保持日数'],
  defaults: ['Default redaction rules', '標準のマスキング規則'], patterns: ['Additional redaction patterns', '追加のマスキングパターン'],
  port: ['API port', 'API のポート'], commands: ['Acceptance commands', '受け入れコマンド'], exclude: ['Scope exclusions', '変更させないパス'],
  maxRoundTrips: ['Maximum review round trips', 'レビューの最大やりとり回数'],
  executor: ['Agent', 'エージェント'], family: ['Model family', 'モデル系統'], tier: ['Model tier', 'モデルランク'], kind: ['Constraint', '制約'], role: ['Role', '役割'],
};
export function labelSetting(key: string, language: 'en' | 'ja') { return assignmentSettingText[language][key as keyof typeof assignmentSettingText.en] ?? labels[key]?.[language === 'ja' ? 1 : 0] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2'); }
const constraintLabels: Record<string, [string, string]> = {
  reviewerDifferentFamily: ['Review with a different model family than the implementer', 'レビューは実装と別の系統のモデルで行う'],
  implementerNotOrchestrator: ["Implement with a model other than the main agent's", '実装はメインエージェントと別のモデルで行う'],
  minTierForRole: ['Use at least a tier model for a role', '役割にはランク以上のモデルを使う'],
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
    if (key === 'constraints' && Array.isArray(entry)) return <fieldset key={key}><legend>{labelSetting(key, language)}</legend>{entry.map((item, index) => {
      const constraint = item as { kind: string; role?: string; tier?: string };
      const change = (patch: Record<string, unknown>) => { const next = { ...constraint, ...patch }; update(entry.map((old, at) => at === index ? next.kind === 'minTierForRole' ? { kind: next.kind, role: next.role ?? 'implement', tier: next.tier ?? 'high' } : { kind: next.kind } : old)); };
      const menu = (field: 'kind' | 'role' | 'tier', options: string[]) => <SettingMenu label={(ja ? '制約' : 'constraints') + ' · ' + (index + 1) + ' · ' + labelSetting(field, language)} value={constraint[field] ?? ''} displayLabel={field === 'kind' && constraint.kind === 'minTierForRole' ? '' : undefined} options={options.map(value => ({ value, label: field === 'kind' ? labelConstraint(value, language) : field === 'tier' ? (ja ? ({ high: '上位', mid: '中位', low: '下位' })[value] : ({ high: 'High', mid: 'Mid', low: 'Low' })[value])! : (ja ? ({ implement: '実装', review: 'コードレビュー', research: 'リサーチ', document: 'ドキュメント', orchestrate: 'メインエージェント', advisor: 'アドバイザー', verify: '動作検証', proofread: '校正' })[value] : ({ implement: 'Implementation', review: 'Code review', research: 'Research', document: 'Documentation', orchestrate: 'Main agent', advisor: 'Advisor', verify: 'Verification', proofread: 'Proofreading' })[value]) ?? value }))} onChange={value => change({ [field]: value })}/>;
      return <fieldset key={index} className="settings-array-row settings-constraint-row" aria-label={labelSetting('kind', language) + ' ' + (index + 1)}>{constraint.kind === 'minTierForRole' ? <div className="settings-sentence">{ja ? <>{menu('role', ['implement', 'review', 'research', 'document', 'orchestrate', 'advisor', 'verify', 'proofread'])}には{menu('tier', ['high', 'mid', 'low'])}以上のモデルを使う</> : <>Use at least a {menu('tier', ['high', 'mid', 'low'])} model for {menu('role', ['implement', 'review', 'research', 'document', 'orchestrate', 'advisor', 'verify', 'proofread'])}</>}{menu('kind', choices.kind)}</div> : menu('kind', choices.kind)}<button type="button" className="btn btn-ghost" onClick={() => update(entry.filter((_, at) => at !== index))}>{ja ? '削除' : 'Remove'}</button></fieldset>;
    })}<button type="button" className="btn btn-secondary" onClick={() => update([...entry, { kind: 'reviewerDifferentFamily' }])}>{ja ? '制約を追加' : 'Add constraint'}</button></fieldset>;
    if (Array.isArray(entry) && (key === 'constraints' || path.startsWith('roles.'))) {
      const template = key === 'constraints' ? { kind: 'reviewerDifferentFamily' } : { executor: 'codex', model: 'gpt-6-astra', family: 'openai', tier: 'high' };
      return <fieldset key={key}><legend>{labelSetting(key, language)}</legend>{entry.map((item, index) => <fieldset key={index} className="settings-array-row" aria-label={key === 'constraints' ? `${labelSetting('kind', language)} ${index + 1}` : undefined}>{key !== 'constraints' && <legend>{index + 1}</legend>}
        <SettingsFields value={item as Record<string, unknown>} onChange={next => {
          if (key === 'constraints') next = next.kind === 'minTierForRole' ? { kind: next.kind, role: next.role ?? 'implement', tier: next.tier ?? 'high' } : { kind: next.kind };
          update(entry.map((old, at) => at === index ? next : old));
        }} language={language} prefix={`${path}.${index + 1}`}/>
        <div className="button-row">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => update(entry.filter((_, at) => at !== index))}>{ja ? '削除' : 'Remove'}</button></div></fieldset>)}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => update([...entry, template])}>{ja ? labelSetting(key, language) + 'を追加' : key === 'constraints' ? 'Add constraint' : 'Add ' + labelSetting(key, language)}</button></fieldset>;
    }
    const options = choices[path] ?? choices[key];
    const displayName = labelSetting(key, language);
    const unit = prefix === 'quota' && (key === 'softLimitPercent' || key === 'hardLimitPercent') ? '%' : prefix === 'performance' && key === 'minSamples' ? text.runs : undefined;
    const title = key === 'softLimitPercent' ? text.softTitle : key === 'hardLimitPercent' ? text.hardTitle : key === 'minSamples' ? text.samplesTitle : undefined;
    const input = <input aria-label={name} aria-invalid={quotaInvalid || undefined} title={quotaInvalid ? text.quotaError : title} max={unit === '%' ? 100 : undefined} type={typeof entry === 'number' || entry === null ? 'number' : key.startsWith('quiet') ? 'time' : 'text'} min={typeof entry === 'number' || entry === null ? 0 : undefined} step={unit ? 1 : undefined}
      value={entry === null ? '' : String(entry)} onChange={event => update(entry === null || typeof entry === 'number' ? event.target.value === '' && key === 'metadataRetentionDays' ? null : Number(event.target.value) : event.target.value)}/>;
    if (typeof entry === 'number' && ['maxRoundTrips', 'softLimitPercent', 'hardLimitPercent', 'minSamples'].includes(key)) {
      const parts = ja ? ({ maxRoundTrips: ['レビューのやりとりは ', ' 回まで'], softLimitPercent: ['使用率が ', '% を超えたモデルは後回しにする'], hardLimitPercent: ['使用率が ', '% を超えたモデルは使わない'], minSamples: ['すべての候補に ', ' 件以上の実績があれば、実績の順で選ぶ'] })[key]! : ({ maxRoundTrips: ['Up to ', ' review round trips'], softLimitPercent: ['Deprioritize a model above ', '% usage'], hardLimitPercent: ['Stop using a model above ', '% usage'], minSamples: ['Rank by results once every candidate has ', ' runs'] })[key]!;
      return <label className="settings-sentence" key={key}>{parts[0]}{input}{unit ? <><span>{unit}</span>{key === 'minSamples' ? (ja ? '以上の実績があれば、実績の順で選ぶ' : '') : parts[1].replace(ja ? new RegExp('^ ?' + unit) : new RegExp('^' + unit), '')}</> : parts[1]}</label>;
    }
    return <label key={key} title={quotaInvalid ? text.quotaError : title}><span><strong>{displayName}</strong></span>
      {options ? <SettingMenu label={name} value={entry === null ? '' : String(entry)} options={[...(inheritIsolation && path === 'isolation.policy' ? [{ value: '', label: ja ? '個人設定に従う' : 'Inherit default' }] : []), ...options.map(option => ({ value: option, label: key === 'kind' ? labelConstraint(option, language) : option }))]} onChange={value => update(value || null)}/>
      : Array.isArray(entry) ? <textarea aria-label={name} value={entry.join('\n')} rows={3} onChange={event => update(event.target.value.split('\n').filter(Boolean))}/>
      : typeof entry === 'boolean' ? <input aria-label={name} type="checkbox" checked={entry} onChange={event => update(event.target.checked)}/>
      : unit ? <span className="settings-number-unit">{input}<span>{unit}</span></span> : input}</label>;
  })}</>;
}
