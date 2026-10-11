import { useEffect, useId, useRef, useState } from 'react';
import { ProviderMark } from '../../components/RootViews.tsx';
import type { Policy } from '../../lib/settings.ts';
import type { Candidate, Role, Weight } from '../../../../../core/src/delegate/types.ts';

import { ROLES, WEIGHTS, readBands, createPreset, listPresetChanges, findModelNote, type Preset } from './assignment-presets.ts';
const NAMES: Record<Role, [string, string]> = { orchestrate: ['Main agent', 'メインエージェント'], implement: ['Implementation', '実装'], research: ['Research', 'リサーチ'], document: ['Documentation', 'ドキュメント'], review: ['Code review', 'コードレビュー'], advisor: ['Advisor', 'アドバイザー'], verify: ['Verification', '動作検証'], proofread: ['Proofreading', '校正'] };
const BUILTIN_TEXT: Record<string, string> = {
  '1 ファイルの小さな直しや、名前の置き換え。': 'Small changes or renaming in one file.',
  '1 つのパッケージの中の機能の追加。': 'A feature added within one package.',
  '複数のパッケージにまたがる変更、設計を伴う変更、性能や安全の直し。': 'Changes across packages, design work, performance or safety fixes.',
  '見た目や文言の差分。': 'Visual or wording changes.',
  'ふつうの差分。': 'Regular changes.',
  '台帳、権限、安全に触る差分。': 'Changes to the ledger, permissions or safety.',
  '150 行以下の 1 ファイル。': 'One file of 150 lines or fewer.',
  '長い文書や設計書。': 'Long documents or design specifications.',
  'SWE-bench で最上位。': 'Top performance on SWE-bench.',
  '日本語の性能が高い。': 'Strong Japanese language performance.',
};
const FAMILY = { claude: 'anthropic', codex: 'openai', antigravity: 'google' } as const;
const DEPTHS = { claude: ['low', 'medium', 'high', 'xhigh', 'max'], codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], antigravity: [] } as const;
const DEFAULT_MODEL = { claude: 'opus', codex: 'gpt-6-astra', antigravity: 'gemini-3.8-flash-high' };
export type ModelCatalog = Record<string, { state: string; models: { model: string; displayName: string; effort?: string }[] }>;
const PROVIDERS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
export function ModelAssignments({ policy, onChange, language, models, onRefresh, onApply, applyDisabled }: {
  policy: Policy; onChange(value: Policy): void; language: 'en' | 'ja'; models: ModelCatalog;
  onRefresh?(provider: Candidate['executor']): void; onApply?(): void; applyDisabled?: boolean;
}) {
  const ja = language === 'ja';
  const headingId = useId();
  const text = (en: string, jp: string) => ja ? jp : en;
  const displayText = (value: string) => ja ? value : BUILTIN_TEXT[value] ?? value;
  const weightName = (weight: Weight) => ({ light: text('Light', '軽量'), standard: text('Standard', '標準'), heavy: text('Heavy', '高負荷') })[weight];
  const [open, setOpen] = useState<{ role: Role; weight: Weight }>();
  const [selecting, setSelecting] = useState(0);
  const [preset, setPreset] = useState<Preset>();
  const [criteriaRole, setCriteriaRole] = useState<Role>();
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<number | undefined>(undefined);
  function close() { setOpen(undefined); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLButtonElement>('.assignment-model-options li > button')?.focus();
    function outside(event: PointerEvent) {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(undefined);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  function bands(role: Role) { return readBands(policy, role); }
  function displayName(candidate: Candidate) { return models[candidate.executor]?.models.find(model => model.model === candidate.model)?.displayName || candidate.model; }
  function describeNote(model: string) {
    const note = findModelNote(policy, model);
    return note ? [note.latest ? text('Latest', '最新') : '', displayText(note.strength), displayText(note.specialties)].filter(Boolean).join(' · ') : '';
  }
  function update(role: Role, weight: Weight, candidates?: Candidate[]) {
    const next = { ...bands(role) };
    if (candidates === undefined) delete next[weight]; else next[weight] = candidates;
    onChange({ ...policy, roles: { ...policy.roles, [role]: next } });
  }
  function reorder(role: Role, weight: Weight, from: number, to: number) {
    const entries = [...(bands(role)[weight] ?? bands(role).standard ?? [])];
    entries.splice(to, 0, entries.splice(from, 1)[0]); update(role, weight, entries);
  }
  const presetPolicy = preset && createPreset(policy, preset);
  const presetChanges = presetPolicy ? listPresetChanges(policy, presetPolicy) : [];
  return <section className="model-assignments" aria-labelledby={headingId}>
    <h3 id={headingId}>{text('Models by role', '役割別のモデル')}</h3>
    <div className="button-row assignment-actions">{(['performance', 'balanced', 'economy'] as const).map(value => <button key={value} className="btn btn-secondary" onClick={() => { close(); setPreset(value); }}>{({ performance: text('Performance', '性能重視'), balanced: text('Balanced', 'バランス'), economy: text('Economy', '節約') })[value]}</button>)}{onApply && <button className="btn btn-secondary assignment-apply-button" disabled={applyDisabled} onClick={onApply}>{text('Apply to configuration files', '設定ファイルに反映')}</button>}</div>
    {preset && <div role="dialog" aria-label={text('Preset changes', 'まとめて変更する内容')} className="assignment-preset">
      <table><thead><tr><th>{text('Assignment', '割り当て')}</th><th>{text('Before', '変更前')}</th><th>{text('After', '変更後')}</th></tr></thead><tbody>{presetChanges.map(change => <tr key={change.role + change.weight}><th>{NAMES[change.role][ja ? 1 : 0]} {weightName(change.weight)}</th>{(['before', 'after'] as const).map(side => <td key={side}>{change[side].map(candidate => displayName(candidate) + (candidate.effort ? ' · ' + candidate.effort : '')).join(' → ')}{change[side === 'before' ? 'inheritedBefore' : 'inheritedAfter'] && ' · ' + text('Use standard model', '標準モデルを使用')}</td>)}</tr>)}</tbody></table>
      <p className="assignment-note">{({ performance: text('Choose the strongest noted candidate for each role, breaking ties by model tier and candidate order.', '各役割でメモの強みが最大の候補を選び、同点ならモデルランクと候補順で決めます。'), balanced: text('Restore the default combination.', '初期設定の組み合わせに戻します。'), economy: text('Use light models for standard workloads too.', '軽量モデルを標準の負荷にも使います。') })[preset]}</p>
      {!presetChanges.length && <p>{text('No changes', '変更はありません')}</p>}
      <div className="button-row"><button className="btn btn-primary" onClick={() => { if (presetPolicy) onChange(presetPolicy); setPreset(undefined); }}>{text('Confirm changes', '確認して表に反映')}</button><button className="btn btn-ghost" onClick={() => setPreset(undefined)}>{text('Cancel', '取り消す')}</button></div>
      <p className="assignment-note">{text('Confirm to update the table, then preview and save the policy.', '確認して表に反映した後、プレビューして「割り当てを保存」で保存します。')}</p>
    </div>}
    <div className="assignment-scroll"><table className="assignment-table"><thead><tr><th>{text('Role', '役割')}</th>{WEIGHTS.map(weight => <th key={weight}>{weightName(weight)}</th>)}</tr></thead>
      <tbody>{ROLES.map(role => {
        const hasCriteria = policy.criteria[role] !== undefined;
        return <tr key={role}><th scope="row"><div className="assignment-role"><span>{NAMES[role][ja ? 1 : 0]}</span>{hasCriteria && <button className="btn btn-ghost assignment-icon" aria-label={NAMES[role][ja ? 1 : 0] + ' ' + text('Edit criteria', '基準を編集')} aria-expanded={criteriaRole === role} onClick={() => setCriteriaRole(criteriaRole === role ? undefined : role)}>✎</button>}</div>
          {criteriaRole === role && <div className="assignment-criteria-editor">{WEIGHTS.map(weight => <label key={weight}>{weightName(weight)}<textarea autoFocus={weight === 'light'} aria-label={NAMES[role][ja ? 1 : 0] + ' ' + weightName(weight) + ' ' + text('Weight criteria', '重さの基準')} value={displayText(policy.criteria[role]?.[weight] ?? '')} onChange={event => onChange({ ...policy, criteria: { ...policy.criteria, [role]: { ...policy.criteria[role], [weight]: event.target.value } } })}/></label>)}<button className="btn btn-ghost" onClick={() => setCriteriaRole(undefined)}>{text('Done', '完了')}</button></div>}
        </th>{WEIGHTS.map(weight => {
          const inherited = weight !== 'standard' && bands(role)[weight] === undefined;
          const candidates = bands(role)[weight] ?? bands(role).standard ?? [];
          const candidate = candidates[0];
          const prefix = NAMES[role][ja ? 1 : 0] + ' ' + weightName(weight);
          const expanded = open?.role === role && open.weight === weight;
          const name = candidate && (models[candidate.executor]?.models.find(m => m.model === candidate.model)?.displayName || candidate.model);
          return <td key={weight}><div className="assignment-cell">
            <button type="button" className={'btn ' + (inherited ? 'btn-ghost assignment-inherited' : 'btn-secondary assignment-model')} aria-label={prefix + ' ' + text('Edit assignment', '割り当てを編集')} aria-expanded={expanded} aria-haspopup="dialog" onClick={event => {
              if (expanded) { close(); return; }
              trigger.current = event.currentTarget;
              setSelecting(0);
              setOpen({ role, weight });
            }}>{inherited ? text('Use standard model', '標準モデルを使用') : candidate ? <><ProviderMark provider={candidate.executor}/><span className="assignment-model-name" title={name}>{name}</span><span className="assignment-effort">· {candidate.effort ?? text('Default', 'おまかせ')}</span><span aria-hidden="true">▾</span></> : text('Choose model', 'モデルを選ぶ')}</button>
            {!inherited && candidates.length > 1 && <small className="assignment-count">{text('On limits or errors: ', '上限時やエラー時: ')}{candidates.slice(1).map(displayName).join(' → ')}</small>}
            {expanded && <div ref={popup} role="dialog" aria-label={prefix + ' ' + text('Assignment', '割り当て')} className="assignment-popover">
              <header><span>{prefix}</span><button className="btn btn-ghost assignment-icon" aria-label={text('Close assignment', '割り当てを閉じる')} onClick={close}>×</button></header>
              <ol className="assignment-candidates">{candidates.map((entry, index) => {
                const label = prefix + ' ' + (index + 1) + ' ';
                const depths = [...new Set([...DEPTHS[entry.executor], ...models[entry.executor]?.models.flatMap(model => model.effort ? [model.effort] : []) ?? []])];
                return <li key={index} draggable onDragStart={() => { drag.current = index; }} onDragEnd={() => { drag.current = undefined; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag.current !== undefined) reorder(role, weight, drag.current, index); drag.current = undefined; setSelecting(0); }}>
                  <button className="btn btn-ghost" aria-pressed={selecting === index} onClick={() => setSelecting(index)}><span aria-hidden="true">⠿</span><ProviderMark provider={entry.executor}/>{displayName(entry)}</button>
                  <div role="group" aria-label={label + text('Effort', '思考量')} className="assignment-depths">{['', ...depths].map(effort => <button key={effort} className="btn btn-ghost" aria-pressed={(entry.effort ?? '') === effort} onClick={() => { const next = { ...entry }; if (effort) next.effort = effort; else delete next.effort; update(role, weight, candidates.map((candidate, at) => at === index ? next : candidate)); }}>{effort || text('Default', 'おまかせ')}</button>)}</div>
                  <div className="button-row"><button className="btn btn-ghost" disabled={index === 0} aria-label={label + text('Move up', '上へ')} onClick={() => { reorder(role, weight, index, index - 1); setSelecting(index - 1); }}>↑</button><button className="btn btn-ghost" disabled={index === candidates.length - 1} aria-label={label + text('Move down', '下へ')} onClick={() => { reorder(role, weight, index, index + 1); setSelecting(index + 1); }}>↓</button><button className="btn btn-ghost" aria-label={label + text('Remove', '削除')} onClick={() => { update(role, weight, candidates.filter((_, at) => at !== index)); setSelecting(0); }}>{text('Remove', '削除')}</button></div>
                </li>;
              })}</ol>
              <button className="btn btn-secondary" aria-label={prefix + ' ' + text('Add fallback model', 'フォールバックモデルを追加')} aria-pressed={selecting === candidates.length} onClick={() => setSelecting(candidates.length)}>{text('Add fallback model', 'フォールバックモデルを追加')}</button>
              <ul className="assignment-model-options" aria-label={prefix + ' ' + (selecting + 1) + ' ' + text('Available models', 'モデルの一覧')}>
                {(Object.keys(PROVIDERS) as Candidate['executor'][]).map(executor => {
                  const catalog = [...new Map([...(models[executor]?.models ?? []), ...ROLES.flatMap(role => WEIGHTS.flatMap(weight => bands(role)[weight] ?? [])).filter(candidate => candidate.executor === executor).map(candidate => ({ model: candidate.model, displayName: displayName(candidate) }))].map(model => [model.model, model])).values()];
                  return <li key={executor}><div className="assignment-provider"><span>{PROVIDERS[executor]}</span><button className="btn btn-ghost assignment-icon" aria-label={prefix + ' ' + text('Refresh ' + executor + ' models', executor + ' のモデルを更新')} onClick={() => onRefresh?.(executor)}>↻</button></div>
                    {catalog.map(model => <button key={model.model} aria-label={model.displayName || model.model} className="btn btn-ghost" aria-pressed={candidates[selecting]?.executor === executor && candidates[selecting]?.model === model.model} onClick={() => {
                      const existing = candidates[selecting];
                      const known = ROLES.flatMap(role => WEIGHTS.flatMap(weight => bands(role)[weight] ?? [])).find(candidate => candidate.executor === executor && candidate.model === model.model);
                      const next: Candidate = { executor, family: FAMILY[executor], model: model.model, tier: known?.tier ?? 'mid' };
                      if (existing?.executor === executor && existing.effort && ([...DEPTHS[executor], ...models[executor]?.models.flatMap(model => model.effort ? [model.effort] : []) ?? []] as string[]).includes(existing.effort)) next.effort = existing.effort;
                      const entries = [...candidates]; entries[selecting] = next; update(role, weight, entries);
                    }}><ProviderMark provider={executor}/><span>{model.displayName || model.model}</span>{describeNote(model.model) && <small>{describeNote(model.model)}</small>}</button>)}
                  </li>;
                })}
              </ul>
              <details className="assignment-custom"><summary>{text('Other models', 'その他のモデル')}</summary>
                {[...candidates, ...(selecting === candidates.length ? [{ executor: 'claude', model: '', family: 'anthropic', tier: 'high' } as Candidate] : [])].map((entry, index) => {
                  const label = prefix + ' ' + (index + 1) + ' ';
                  const change = (patch: Partial<Candidate>) => { const entries = [...candidates]; entries[index] = { ...entry, ...patch }; update(role, weight, entries); };
                  return <fieldset key={index}><label>{text('Provider', '提供元')}<select aria-label={label + text('Provider', '提供元')} value={entry.executor} onChange={event => { const executor = event.target.value as Candidate['executor']; const entries = [...candidates]; entries[index] = { executor, family: FAMILY[executor], model: models[executor]?.models[0]?.model ?? DEFAULT_MODEL[executor], tier: 'mid' }; update(role, weight, entries); }}>{Object.entries(PROVIDERS).map(([provider, display]) => <option key={provider} value={provider}>{display}</option>)}</select></label>
                  <label>{text('Model', 'モデル')}<input aria-label={label + text('Model', 'モデル')} value={entry.model} onChange={event => change({ model: event.target.value })}/></label>
                  <label>{text('Tier', 'ランク')}<select aria-label={label + text('Tier', 'ランク')} value={entry.tier} onChange={event => change({ tier: event.target.value as Candidate['tier'] })}>{['high', 'mid', 'low'].map(tier => <option key={tier}>{tier}</option>)}</select></label></fieldset>;
                })}
              </details>
              {weight !== 'standard' && <button className="btn btn-ghost" aria-label={prefix + ' ' + text('Use standard model', '標準モデルを使用')} onClick={() => { update(role, weight); close(); }}>{text('Use standard model', '標準モデルを使用')}</button>}
              <details className="assignment-notes-editor"><summary>{text('Edit model notes', 'モデルのメモを編集')}</summary>
                {policy.modelNotes.map((note, index) => <fieldset key={index}>{(['model', 'latest', 'strength', 'specialties'] as const).map(key => <label key={key}>{text(key, ({ model: 'モデル', latest: '最新', strength: '強み', specialties: '得意分野' })[key])}<input aria-label={text('Model note', 'モデルのメモ') + ' ' + (index + 1) + ' ' + text(key, ({ model: 'モデル', latest: '最新', strength: '強み', specialties: '得意分野' })[key])} type={key === 'latest' ? 'checkbox' : 'text'} checked={key === 'latest' ? note.latest : undefined} value={key === 'latest' ? undefined : displayText(note[key])} onChange={event => onChange({ ...policy, modelNotes: policy.modelNotes.map((n, at) => at === index ? { ...n, [key]: key === 'latest' ? event.target.checked : event.target.value } : n) })}/></label>)}<button className="btn btn-ghost" aria-label={text('Model note', 'モデルのメモ') + ' ' + (index + 1) + ' ' + text('Remove', '削除')} onClick={() => onChange({ ...policy, modelNotes: policy.modelNotes.filter((_, at) => at !== index) })}>{text('Remove', '削除')}</button></fieldset>)}
                <button className="btn btn-secondary" onClick={() => onChange({ ...policy, modelNotes: [...policy.modelNotes, { model: '', latest: false, strength: '', specialties: '' }] })}>{text('Add model note', 'モデルのメモを追加')}</button>
              </details>
            </div>}
          </div></td>;
        })}</tr>;
      })}</tbody>
    </table></div>
  </section>;
}
