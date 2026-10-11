import { useEffect, useRef, useState } from 'react';
import { ProviderMark } from '../../components/RootViews.tsx';
import type { Policy } from '../../lib/settings.ts';
import type { Candidate, Role, Weight } from '../../../../../core/src/delegate/types.ts';

const ROLES: Role[] = ['orchestrate', 'advisor', 'research', 'implement', 'document', 'review', 'verify', 'proofread'];
const WEIGHTS: Weight[] = ['light', 'standard', 'heavy'];
const NAMES: Record<Role, [string, string]> = { orchestrate: ['Orchestrate', '根'], implement: ['Implement', '実装'], research: ['Research', '調査'], document: ['Document', '文書'], review: ['Review', 'レビュー'], advisor: ['Advisor', '助言'], verify: ['Verify', '検証'], proofread: ['Proofread', '校正'] };
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
const DEFAULT_MODEL = { claude: 'opus', codex: 'gpt-6-astra', antigravity: 'gemini-3.8-flash-high' };
export type ModelCatalog = Record<string, { state: string; models: { model: string; displayName: string; effort?: string }[] }>;
const PROVIDERS = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
export function ModelAssignments({ policy, onChange, language, models, onRefresh, onApply, applyDisabled }: {
  policy: Policy; onChange(value: Policy): void; language: 'en' | 'ja'; models: ModelCatalog;
  onRefresh?(provider: Candidate['executor']): void; onApply?(provider: Candidate['executor']): void; applyDisabled?: boolean;
}) {
  const ja = language === 'ja';
  const text = (en: string, jp: string) => ja ? jp : en;
  const displayText = (value: string) => ja ? value : BUILTIN_TEXT[value] ?? value;
  const weightName = (weight: Weight) => ({ light: text('Light', '軽い'), standard: text('Standard', '標準'), heavy: text('Heavy', '重い') })[weight];
  const [open, setOpen] = useState<{ role: Role; weight: Weight }>();
  const [criteriaRole, setCriteriaRole] = useState<Role>();
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<number | undefined>(undefined);
  function close() { setOpen(undefined); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLSelectElement>('select')?.focus();
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
  function bands(role: Role) { const value = policy.roles[role]; return Array.isArray(value) ? { standard: value } : value; }
  function update(role: Role, weight: Weight, candidates?: Candidate[]) {
    const next = { ...bands(role) };
    if (candidates === undefined) delete next[weight]; else next[weight] = candidates;
    onChange({ ...policy, roles: { ...policy.roles, [role]: next } });
  }
  function reorder(role: Role, weight: Weight, from: number, to: number) {
    const entries = [...(bands(role)[weight] ?? [])];
    entries.splice(to, 0, entries.splice(from, 1)[0]); update(role, weight, entries);
  }
  function findNote(model: string) {
    return policy.modelNotes.find(n => n.model === model) ?? policy.modelNotes.filter(n => model.startsWith(n.model + '-')).sort((a, b) => b.model.length - a.model.length)[0];
  }
  function describeNote(model: string) {
    const note = findNote(model);
    return note ? [note.latest ? text('Latest', '最新') : '', displayText(note.strength)].filter(Boolean).join(' · ') : '';
  }
  return <section className="model-assignments" aria-label={text('Model assignments', 'モデルの割り当て')}>
    <h3>{text('Model assignments', 'モデルの割り当て')}</h3>
    <div className="assignment-scroll"><table className="assignment-table"><thead><tr><th>{text('Role', '役割')}</th>{WEIGHTS.map(weight => <th key={weight}>{weightName(weight)}</th>)}</tr></thead>
      <tbody>{ROLES.map(role => {
        const hasCriteria = policy.criteria[role] !== undefined;
        const criteria = WEIGHTS.map(weight => displayText(policy.criteria[role]?.[weight] ?? '')).filter(Boolean).join(' · ');
        return <tr key={role}><th scope="row"><div className="assignment-role"><span>{NAMES[role][ja ? 1 : 0]}</span>{hasCriteria && <button className="btn btn-ghost assignment-icon" aria-label={NAMES[role][ja ? 1 : 0] + ' ' + text('Edit criteria', '基準を編集')} aria-expanded={criteriaRole === role} onClick={() => setCriteriaRole(criteriaRole === role ? undefined : role)}>✎</button>}</div>
          {hasCriteria && <small className="assignment-criteria-summary" title={criteria}>{criteria}</small>}
          {criteriaRole === role && <div className="assignment-criteria-editor">{WEIGHTS.map(weight => <label key={weight}>{weightName(weight)}<textarea autoFocus={weight === 'light'} aria-label={NAMES[role][ja ? 1 : 0] + ' ' + weightName(weight) + ' ' + text('Weight criteria', '重さの基準')} value={displayText(policy.criteria[role]?.[weight] ?? '')} onChange={event => onChange({ ...policy, criteria: { ...policy.criteria, [role]: { ...policy.criteria[role], [weight]: event.target.value } } })}/></label>)}<button className="btn btn-ghost" onClick={() => setCriteriaRole(undefined)}>{text('Done', '完了')}</button></div>}
        </th>{WEIGHTS.map(weight => {
          const inherited = weight !== 'standard' && bands(role)[weight] === undefined;
          const candidates = bands(role)[weight] ?? bands(role).standard ?? [];
          const candidate = candidates[0];
          const prefix = NAMES[role][ja ? 1 : 0] + ' ' + weightName(weight);
          const expanded = open?.role === role && open.weight === weight;
          const name = candidate && (models[candidate.executor]?.models.find(m => m.model === candidate.model)?.displayName || candidate.model);
          const edit = (index: number, patch: Partial<Candidate>) => update(role, weight, candidates.map((c, at) => at === index ? { ...c, ...patch } : c));
          return <td key={weight}><div className="assignment-cell">
            <button type="button" className={'btn ' + (inherited ? 'btn-ghost assignment-inherited' : 'btn-secondary assignment-model')} aria-label={prefix + ' ' + text('Edit assignment', '割り当てを編集')} aria-expanded={expanded} aria-haspopup="dialog" onClick={event => {
              if (expanded) { close(); return; }
              trigger.current = event.currentTarget;
              if (inherited) update(role, weight, structuredClone(candidates));
              setOpen({ role, weight });
            }}>{inherited ? text('Same as standard', '標準と同じ') : candidate ? <><ProviderMark provider={candidate.executor}/><span className="assignment-model-name" title={name}>{name}</span><span className="assignment-effort">· {candidate.effort ?? text('Default', '既定')}</span><span aria-hidden="true">▾</span></> : text('Choose model', 'モデルを選ぶ')}</button>
            {!inherited && candidates.length > 1 && <small className="assignment-count">{text('+' + (candidates.length - 1) + ' candidates', '+' + (candidates.length - 1) + ' 候補')}</small>}
            {expanded && <div ref={popup} role="dialog" aria-label={prefix + ' ' + text('Assignment', '割り当て')} className="assignment-popover">
              <header><span>{prefix}</span><button className="btn btn-ghost assignment-icon" aria-label={text('Close assignment', '割り当てを閉じる')} onClick={close}>×</button></header>
              <ol className="assignment-candidates">{candidates.map((entry, index) => {
                const label = prefix + ' ' + (index + 1) + ' ';
                const id = 'models-' + role + '-' + weight + '-' + index;
                return <li key={index} draggable onDragStart={() => { drag.current = index; }} onDragEnd={() => { drag.current = undefined; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag.current !== undefined) reorder(role, weight, drag.current, index); drag.current = undefined; }}>
                  <div className="assignment-provider"><ProviderMark provider={entry.executor}/><select aria-label={label + text('Provider', '提供元')} value={entry.executor} onChange={event => { const executor = event.target.value as Candidate['executor']; edit(index, { executor, family: FAMILY[executor], model: models[executor]?.models[0]?.model ?? DEFAULT_MODEL[executor] }); }}>{Object.entries(PROVIDERS).map(([provider, display]) => <option key={provider} value={provider}>{display}</option>)}</select><button className="btn btn-ghost assignment-icon" aria-label={label + text('Refresh ' + entry.executor + ' models', entry.executor + ' のモデルを更新')} onClick={() => onRefresh?.(entry.executor)}>↻</button></div>
                  <label>{text('Model', 'モデル')}<input aria-controls={id} aria-label={label + text('Model', 'モデル')} value={entry.model} onChange={event => edit(index, { model: event.target.value })}/></label>
                  <ul id={id} className="assignment-model-options" aria-label={label + text('Available models', 'モデルの一覧')}>{models[entry.executor]?.models.map(model => <li key={model.model}><button className="btn btn-ghost" aria-pressed={model.model === entry.model} onClick={() => edit(index, { model: model.model })}><span>{model.displayName || model.model}</span>{' '}{describeNote(model.model) && <small>{describeNote(model.model)}</small>}</button></li>)}</ul>
                  {describeNote(entry.model) && <small className="assignment-note">{describeNote(entry.model)}</small>}
                  <label>{text('Effort', '深さ')}<select aria-label={label + text('Effort', '深さ')} value={entry.effort ?? ''} onChange={event => { const next = { ...entry }; if (event.target.value) next.effort = event.target.value; else delete next.effort; update(role, weight, candidates.map((c, at) => at === index ? next : c)); }}><option value="">{text('Default', '既定')}</option>{[...new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', ...models[entry.executor]?.models.flatMap(m => m.effort ? [m.effort] : []) ?? [], ...entry.effort ? [entry.effort] : []])].map(effort => <option key={effort}>{effort}</option>)}</select></label>
                  <details><summary>{text('Options', '詳細')}</summary><label>{text('Tier', '水準')}<select aria-label={label + text('Tier', '水準')} value={entry.tier} onChange={event => edit(index, { tier: event.target.value as Candidate['tier'] })}>{['high', 'mid', 'low'].map(tier => <option key={tier}>{tier}</option>)}</select></label></details>
                  <div className="button-row"><button className="btn btn-ghost" disabled={index === 0} aria-label={label + text('Move up', '上へ')} onClick={() => reorder(role, weight, index, index - 1)}>↑</button><button className="btn btn-ghost" disabled={index === candidates.length - 1} aria-label={label + text('Move down', '下へ')} onClick={() => reorder(role, weight, index, index + 1)}>↓</button><button className="btn btn-ghost" aria-label={label + text('Remove', '削除')} onClick={() => update(role, weight, candidates.filter((_, at) => at !== index))}>{text('Remove', '削除')}</button></div>
                </li>;
              })}</ol>
              <button className="btn btn-secondary" aria-label={prefix + ' ' + text('Add candidate', '候補を追加')} onClick={() => update(role, weight, [...candidates, { executor: 'claude', model: 'opus', family: 'anthropic', tier: 'high' }])}>{text('Add candidate', '候補を追加')}</button>
              {weight !== 'standard' && <button className="btn btn-ghost" aria-label={prefix + ' ' + text('Use standard', '標準と同じにする')} onClick={() => { update(role, weight); close(); }}>{text('Use standard', '標準と同じにする')}</button>}
              <details className="assignment-notes-editor"><summary>{text('Edit model notes', '覚え書きを編集')}</summary>
                {policy.modelNotes.map((note, index) => <fieldset key={index}>{(['model', 'latest', 'strength', 'specialties'] as const).map(key => <label key={key}>{text(key, ({ model: 'モデル', latest: '最新', strength: '強さ', specialties: '得意' })[key])}<input aria-label={text('Model note', 'モデルの覚え書き') + ' ' + (index + 1) + ' ' + text(key, ({ model: 'モデル', latest: '最新', strength: '強さ', specialties: '得意' })[key])} type={key === 'latest' ? 'checkbox' : 'text'} checked={key === 'latest' ? note.latest : undefined} value={key === 'latest' ? undefined : displayText(note[key])} onChange={event => onChange({ ...policy, modelNotes: policy.modelNotes.map((n, at) => at === index ? { ...n, [key]: key === 'latest' ? event.target.checked : event.target.value } : n) })}/></label>)}<button className="btn btn-ghost" aria-label={text('Model note', 'モデルの覚え書き') + ' ' + (index + 1) + ' ' + text('Remove', '削除')} onClick={() => onChange({ ...policy, modelNotes: policy.modelNotes.filter((_, at) => at !== index) })}>{text('Remove', '削除')}</button></fieldset>)}
                <button className="btn btn-secondary" onClick={() => onChange({ ...policy, modelNotes: [...policy.modelNotes, { model: '', latest: false, strength: '', specialties: '' }] })}>{text('Add model note', '覚え書きを追加')}</button>
              </details>
              <p className="assignment-note">{text('Preview and save the policy to apply changes.', '変更は割り当てを試算して保存すると反映します。')}</p>
            </div>}
          </div>{role === 'orchestrate' && weight === 'heavy' && onApply && <details className="assignment-apply"><summary>{text('Apply to provider', '提供元に反映')}</summary>{Object.entries(PROVIDERS).map(([provider, display]) => <button key={provider} className="btn btn-ghost" disabled={applyDisabled} onClick={() => onApply(provider as Candidate['executor'])}>{text('Apply to', '反映') + ' ' + display}</button>)}</details>}</td>;
        })}</tr>;
      })}</tbody>
    </table></div>
  </section>;
}
