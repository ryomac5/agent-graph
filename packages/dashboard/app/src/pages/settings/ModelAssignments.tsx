import { useRef } from 'react';
import { ProviderMark } from '../../components/RootViews.tsx';
import type { Policy } from '../../lib/settings.ts';
import type { Candidate, Role, Weight } from '../../../../../core/src/delegate/types.ts';

const ROLES: Role[] = ['orchestrate', 'implement', 'research', 'document', 'review', 'advisor', 'plan', 'proofread'];
const WEIGHTS: Weight[] = ['light', 'standard', 'heavy'];
const NAMES: Record<Role, [string, string]> = { orchestrate: ['Root', '根'], implement: ['Implementation', '実装'], research: ['Research', '調査'], document: ['Documentation', '文書'], review: ['Review', 'レビュー'], advisor: ['Advisor', '助言'], plan: ['Planning', '計画'], proofread: ['Proofreading', '校正'] };
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
export function ModelAssignments({ policy, onChange, language, models }: { policy: Policy; onChange(value: Policy): void; language: 'en' | 'ja'; models: ModelCatalog }) {
  const ja = language === 'ja';
  const text = (en: string, jp: string) => ja ? jp : en;
  const displayText = (value: string) => ja ? value : BUILTIN_TEXT[value] ?? value;
  const drag = useRef<{ role: Role; weight: Weight; index: number } | undefined>(undefined);
  function bands(role: Role) { const value = policy.roles[role]; return Array.isArray(value) ? { standard: value } : value; }
  function update(role: Role, weight: Weight, candidates?: Candidate[]) {
    const next = { ...bands(role) };
    if (candidates === undefined) delete next[weight]; else next[weight] = candidates;
    onChange({ ...policy, roles: { ...policy.roles, [role]: next } });
  }
  function reorder(role: Role, weight: Weight, from: number, to: number) {
    const entries = [...(bands(role)[weight] ?? bands(role).standard ?? [])];
    entries.splice(to, 0, entries.splice(from, 1)[0]); update(role, weight, entries);
  }
  return <section className="model-assignments" aria-label={text('Model assignments', 'モデルの割り当て')}><h3>{text('Model assignments', 'モデルの割り当て')}</h3>
    <p className="muted-text">{text('Candidates are tried in order. Drag to reorder or use the arrow buttons. Model names can also be entered manually.', '候補は上から順に試します。ドラッグか矢印で並べ替えます。モデル名は手入力もできます。')}</p>
    <div className="assignment-scroll"><table className="assignment-table"><thead><tr><th>{text('Role', '役割')}</th>{WEIGHTS.map(weight => <th key={weight}>{text(({ light: 'Light', standard: 'Standard', heavy: 'Heavy' })[weight], ({ light: '軽い', standard: '標準', heavy: '重い' })[weight])}</th>)}</tr></thead>
    <tbody>{ROLES.map(role => <tr key={role}><th scope="row">{NAMES[role][ja ? 1 : 0]}</th>{WEIGHTS.map(weight => {
      const inherited = weight !== 'standard' && bands(role)[weight] === undefined;
      const candidates = bands(role)[weight] ?? bands(role).standard ?? [];
      const prefix = `${NAMES[role][ja ? 1 : 0]} ${text(({ light: 'Light', standard: 'Standard', heavy: 'Heavy' })[weight], ({ light: '軽い', standard: '標準', heavy: '重い' })[weight])}`;
      const edit = (index: number, patch: Partial<Candidate>) => update(role, weight, candidates.map((c, at) => at === index ? { ...c, ...patch } : c));
      return <td key={weight}>
        {weight !== 'standard' && <label className="assignment-inherit"><input aria-label={`${prefix} ${text('Use standard', '標準を使う')}`} type="checkbox" checked={inherited} onChange={event => update(role, weight, event.target.checked ? undefined : structuredClone(candidates))}/>{text('Use standard', '標準を使う')}</label>}
        <ol className="assignment-candidates">{candidates.map((candidate, index) => {
          const note = policy.modelNotes.find(n => n.model === candidate.model) ?? policy.modelNotes.filter(n => candidate.model.startsWith(`${n.model}-`)).sort((a, b) => b.model.length - a.model.length)[0];
          const id = `models-${role}-${weight}-${index}`;
          return <li key={index} draggable={!inherited} onDragStart={() => { drag.current = { role, weight, index }; }} onDragEnd={() => { drag.current = undefined; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const source = drag.current; if (!inherited && source?.role === role && source.weight === weight) reorder(role, weight, source.index, index); drag.current = undefined; }}>
            <div className="assignment-choice"><ProviderMark provider={candidate.executor}/><select disabled={inherited} aria-label={`${prefix} ${index + 1} ${text('Provider', '提供元')}`} value={candidate.executor} onChange={event => { const executor = event.target.value as Candidate['executor']; edit(index, { executor, family: FAMILY[executor], model: models[executor]?.models[0]?.model ?? DEFAULT_MODEL[executor] }); }}>{Object.keys(FAMILY).map(provider => <option key={provider}>{provider}</option>)}</select></div>
            <input disabled={inherited} list={id} aria-label={`${prefix} ${index + 1} ${text('Model', 'モデル')}`} value={candidate.model} onChange={event => edit(index, { model: event.target.value })}/>
            <datalist id={id}>{models[candidate.executor]?.models.map(model => <option key={model.model} value={model.model}>{model.displayName}</option>)}</datalist>
            <select disabled={inherited} aria-label={`${prefix} ${index + 1} ${text('Effort', '深さ')}`} value={candidate.effort ?? ''} onChange={event => { const next = { ...candidate }; if (event.target.value) next.effort = event.target.value; else delete next.effort; update(role, weight, candidates.map((c, at) => at === index ? next : c)); }}>
              <option value="">{text('Default effort', '既定の深さ')}</option>{[...new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', ...models[candidate.executor]?.models.flatMap(m => m.effort ? [m.effort] : []) ?? [], ...candidate.effort ? [candidate.effort] : []])].map(effort => <option key={effort}>{effort}</option>)}</select>
            <select disabled={inherited} aria-label={`${prefix} ${index + 1} ${text('Tier', '水準')}`} value={candidate.tier} onChange={event => edit(index, { tier: event.target.value as Candidate['tier'] })}>{['high', 'mid', 'low'].map(tier => <option key={tier}>{tier}</option>)}</select>
            {note && <small className="assignment-note">{[note.latest ? text('Latest', '最新') : '', displayText(note.strength), displayText(note.specialties)].filter(Boolean).join(' · ')}</small>}
            <div className="button-row"><button className="btn btn-ghost" disabled={inherited || index === 0} aria-label={`${prefix} ${index + 1} ${text('Move up', '上へ')}`} onClick={() => reorder(role, weight, index, index - 1)}>↑</button><button className="btn btn-ghost" disabled={inherited || index === candidates.length - 1} aria-label={`${prefix} ${index + 1} ${text('Move down', '下へ')}`} onClick={() => reorder(role, weight, index, index + 1)}>↓</button><button className="btn btn-ghost" disabled={inherited} aria-label={`${prefix} ${index + 1} ${text('Remove', '削除')}`} onClick={() => update(role, weight, candidates.filter((_, at) => at !== index))}>{text('Remove', '削除')}</button></div>
          </li>;
        })}</ol>
        <button className="btn btn-secondary" disabled={inherited} aria-label={`${prefix} ${text('Add candidate', '候補を追加')}`} onClick={() => update(role, weight, [...candidates, { executor: 'claude', model: 'opus', family: 'anthropic', tier: 'high' }])}>{text('Add candidate', '候補を追加')}</button>
        <label className="assignment-criteria">{text('Weight criteria', '重さの基準')}<textarea aria-label={`${prefix} ${text('Weight criteria', '重さの基準')}`} value={displayText(policy.criteria[role]?.[weight] ?? '')} onChange={event => onChange({ ...policy, criteria: { ...policy.criteria, [role]: { ...policy.criteria[role], [weight]: event.target.value } } })}/></label>
      </td>;
    })}</tr>)}</tbody></table></div>
    <h3>{text('Model notes', 'モデルの覚え書き')}</h3><p className="muted-text">{text('Latest and strongest are separate judgments. Notes do not change candidate order.', '最新と強さは別の判断材料です。覚え書きは候補の順番を変えません。')}</p>
    <div className="assignment-scroll"><table><thead><tr>{[text('Model', 'モデル'), text('Latest', '最新'), text('Strength', '強さ'), text('Specialties', '得意'), text('Actions', '操作')].map(name => <th key={name}>{name}</th>)}</tr></thead><tbody>{policy.modelNotes.map((note, index) => <tr key={index}>{(['model', 'latest', 'strength', 'specialties'] as const).map(key => <td key={key}><input aria-label={`${text('Model note', 'モデルの覚え書き')} ${index + 1} ${text(key, ({ model: 'モデル', latest: '最新', strength: '強さ', specialties: '得意' })[key])}`} type={key === 'latest' ? 'checkbox' : 'text'} checked={key === 'latest' ? note.latest : undefined} value={key === 'latest' ? undefined : displayText(note[key])} onChange={event => onChange({ ...policy, modelNotes: policy.modelNotes.map((n, at) => at === index ? { ...n, [key]: key === 'latest' ? event.target.checked : event.target.value } : n) })}/></td>)}<td><button className="btn btn-ghost" aria-label={`${text('Model note', 'モデルの覚え書き')} ${index + 1} ${text('Remove', '削除')}`} onClick={() => onChange({ ...policy, modelNotes: policy.modelNotes.filter((_, at) => at !== index) })}>{text('Remove', '削除')}</button></td></tr>)}</tbody></table></div>
    <button className="btn btn-secondary" onClick={() => onChange({ ...policy, modelNotes: [...policy.modelNotes, { model: '', latest: false, strength: '', specialties: '' }] })}>{text('Add model note', '覚え書きを追加')}</button>
  </section>;
}
