import { CommandDialog } from '../../components/command/Commands.tsx';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Segments } from '../../components/settings/Controls.tsx';
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
  const weightName = (weight: Weight) => ({ light: text('Light', '軽い作業'), standard: text('Standard', 'ふつうの作業'), heavy: text('Heavy', '重い作業') })[weight];
  const [open, setOpen] = useState<{ role: Role; weight: Weight }>();
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });
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
    <span id={headingId} className="sr-only">{text('Models by role', '役割別のモデル')}</span>
    {preset && <CommandDialog title={text('Changes', '変更の内容')} language={language} onClose={() => setPreset(undefined)}>
      <table><thead><tr><th>{text('Assignment', '割り当て')}</th><th>{text('Before', '変更前')}</th><th>{text('After', '変更後')}</th></tr></thead><tbody>{presetChanges.map(change => <tr key={change.role + change.weight}><th>{NAMES[change.role][ja ? 1 : 0]} {weightName(change.weight)}</th>{(['before', 'after'] as const).map(side => <td key={side}>{change[side].map(candidate => displayName(candidate) + (candidate.effort ? ' · ' + candidate.effort : '')).join(' → ')}{change[side === 'before' ? 'inheritedBefore' : 'inheritedAfter'] && ' · ' + text('Same as standard', 'ふつうと同じ')}</td>)}</tr>)}</tbody></table>
      <p className="assignment-note">{({ performance: text('Choose the strongest noted candidate for each role, breaking ties by model tier and candidate order.', '各役割でメモの強みが最大の候補を選び、同点ならモデルランクと候補順で決めます。'), balanced: text('Restore the default combination.', '初期設定の組み合わせに戻します。'), economy: text('Use light models for standard workloads too.', '軽量モデルを標準の負荷にも使います。') })[preset]}</p>
      {!presetChanges.length && <p>{text('No changes', '変更はありません')}</p>}
      <div className="button-row"><button className="btn btn-primary" onClick={() => { if (presetPolicy) onChange(presetPolicy); setPreset(undefined); }}>{text('Apply to table', '表に反映')}</button><button className="btn btn-ghost" onClick={() => setPreset(undefined)}>{text('Cancel', 'やめる')}</button></div>
      <p className="assignment-note">{text('After applying, use Save in this section', '表に反映したら、節の「保存」で保存する')}</p>
    </CommandDialog>}
    <div className="assignment-scroll"><table className="assignment-table"><thead><tr><th>{text('Role', '役割')}</th>{WEIGHTS.map(weight => <th key={weight}>{weightName(weight)}</th>)}</tr></thead>
      <tbody>{ROLES.map(role => {
        const hasCriteria = policy.criteria[role] !== undefined;
        return <Fragment key={role}><tr><th scope="row"><div className="assignment-role"><span>{NAMES[role][ja ? 1 : 0]}</span>{hasCriteria && <button className="btn btn-ghost assignment-icon" aria-label={ja ? NAMES[role][1] + 'の重さの基準を編集' : 'Edit workload criteria for ' + NAMES[role][0]} aria-expanded={criteriaRole === role} onClick={() => setCriteriaRole(criteriaRole === role ? undefined : role)}>✎</button>}</div>

        </th>{WEIGHTS.map(weight => {
          const inherited = weight !== 'standard' && bands(role)[weight] === undefined;
          const candidates = bands(role)[weight] ?? bands(role).standard ?? [];
          const candidate = candidates[0];
          const prefix = NAMES[role][ja ? 1 : 0] + ' ' + weightName(weight);
          const expanded = open?.role === role && open.weight === weight;
          const name = candidate ? displayName(candidate) : text('No models available', 'モデルを取得できない');
          return <td key={weight}><div className="assignment-cell">
            <button type="button" className={'btn ' + (inherited ? 'btn-ghost assignment-inherited' : 'btn-secondary assignment-model')} aria-label={prefix + ' ' + text('Edit assignment', '割り当てを編集')} aria-expanded={expanded} aria-haspopup="dialog" onClick={event => {
              if (expanded) { close(); return; }
              trigger.current = event.currentTarget;
              const rect = event.currentTarget.getBoundingClientRect();
              setPosition({ top: rect.bottom, left: Math.max(8, Math.min(rect.left, window.innerWidth - 448)) });
              setQuery('');
              setSelecting(0);
              setOpen({ role, weight });
            }}>{inherited ? <span title={name}>{name}</span> : candidate ? <><ProviderMark provider={candidate.executor}/><span className="assignment-model-name" title={name}>{name}</span>{candidate.effort && <span className="assignment-effort">{candidate.effort}</span>}<span aria-hidden="true">▾</span></> : text('Choose model', 'モデルを選ぶ')}</button>
            {inherited && <small className="assignment-count">{text('Same as standard', 'ふつうと同じ')}</small>}
            {!inherited && candidates.length > 1 && <small className="assignment-count" title={text('Used in order when the first model is over quota or blocked by a constraint', '利用枠の上限や制約で最初のモデルが使えないとき、順に使う')}>{text('Backup ', '予備 ')}{candidates.slice(1).map(displayName).join(' → ')}</small>}
            {expanded && <div ref={popup} role="dialog" aria-label={prefix + ' ' + text('Assignment', '割り当て')} className="assignment-popover" style={{ top: position.top, left: position.left, maxHeight: `calc(100dvh - ${position.top + 8}px)` }}>
              <header><span>{NAMES[role][ja ? 1 : 0]} · {weightName(weight)}</span><button className="btn btn-ghost assignment-icon" aria-label={text('Close assignment', '割り当てを閉じる')} onClick={close}>×</button></header>
              <ol className="assignment-candidates">{candidates.map((entry, index) => {
                const label = prefix + ' ' + (index + 1) + ' ';
                const depths = [...new Set([...DEPTHS[entry.executor], ...models[entry.executor]?.models.flatMap(model => model.effort ? [model.effort] : []) ?? []])];
                return <li key={index} draggable onDragStart={() => { drag.current = index; }} onDragEnd={() => { drag.current = undefined; }} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (drag.current !== undefined) reorder(role, weight, drag.current, index); drag.current = undefined; setSelecting(0); }}>
                  <span className="assignment-candidate-label">{index === 0 ? text('Model', '使うモデル') : text('Backup ', '予備 ') + index}</span><button className="btn btn-ghost" aria-pressed={selecting === index} onClick={() => setSelecting(index)}><span aria-hidden="true">⠿</span><ProviderMark provider={entry.executor}/>{displayName(entry)}</button>
                  {entry.executor !== 'antigravity' && <div role="group" aria-label={label + text('Effort', '思考量')} className="assignment-depths"><span>{text('Effort', '思考量')}</span>{['', ...depths].map(effort => <button key={effort} className="btn btn-ghost" aria-pressed={(entry.effort ?? '') === effort} onClick={() => { const next = { ...entry }; if (effort) next.effort = effort; else delete next.effort; update(role, weight, candidates.map((candidate, at) => at === index ? next : candidate)); }}>{effort || text('Auto', '自動')}</button>)}</div>}
                  <div className="button-row"><button className="btn btn-ghost" aria-label={label + text('Remove', '削除')} onClick={() => { update(role, weight, candidates.filter((_, at) => at !== index)); setSelecting(0); }}>{text('Remove', '削除')}</button></div>
                </li>;
              })}</ol>
              <button className="btn btn-secondary" aria-label={prefix + ' ' + text('Add backup', '予備を追加')} aria-pressed={selecting === candidates.length} onClick={() => setSelecting(candidates.length)}>{text('Add backup', '予備を追加')}</button>
              <input className="assignment-search" aria-label={text('Find a model', 'モデルを探す')} placeholder={text('Find a model', 'モデルを探す')} value={query} onChange={event => setQuery(event.target.value)}/><ul className="assignment-model-options" aria-label={prefix + ' ' + (selecting + 1) + ' ' + text('Available models', 'モデルの一覧')}>
                {(Object.keys(PROVIDERS) as Candidate['executor'][]).map(executor => {
                  const catalog = [...new Map([...(models[executor]?.models ?? []), ...ROLES.flatMap(role => WEIGHTS.flatMap(weight => bands(role)[weight] ?? [])).filter(candidate => candidate.executor === executor).map(candidate => ({ model: candidate.model, displayName: displayName(candidate) }))].map(model => [model.model, model])).values()];
                  const used = new Set(ROLES.flatMap(role => WEIGHTS.flatMap(weight => bands(role)[weight] ?? [])).filter(c => c.executor === executor).map(c => c.model));
                  const groups = partitionModels(catalog, used, new Set(policy.modelNotes.filter(n => n.latest).map(n => n.model)));
                  const matches = (model: typeof catalog[number]) => model.displayName.toLowerCase().includes(query.toLowerCase());
                  const renderModel = (model: typeof catalog[number]) => <button key={model.model} aria-label={model.displayName || model.model} className="btn btn-ghost" aria-pressed={candidates[selecting]?.executor === executor && candidates[selecting]?.model === model.model} onClick={() => {
                      const existing = candidates[selecting];
                      const known = ROLES.flatMap(role => WEIGHTS.flatMap(weight => bands(role)[weight] ?? [])).find(candidate => candidate.executor === executor && candidate.model === model.model);
                      const next: Candidate = { executor, family: FAMILY[executor], model: model.model, tier: known?.tier ?? 'mid' };
                      if (existing?.executor === executor && existing.effort && ([...DEPTHS[executor], ...models[executor]?.models.flatMap(model => model.effort ? [model.effort] : []) ?? []] as string[]).includes(existing.effort)) next.effort = existing.effort;
                      const entries = [...candidates]; entries[selecting] = next; update(role, weight, entries);
                    }}><ProviderMark provider={executor}/><span>{model.displayName || model.model}</span>{describeNote(model.model) && <small>{describeNote(model.model)}</small>}</button>;
                  return <li key={executor}><div className="assignment-provider"><span>{PROVIDERS[executor]}</span><button className="btn btn-ghost assignment-icon" aria-label={prefix + ' ' + text('Refresh ' + executor + ' models', PROVIDERS[executor] + ' のモデルを読み直す')} onClick={() => onRefresh?.(executor)}>↻</button></div>
                    {groups.current.filter(matches).map(renderModel)}
                    {groups.older.length > 0 && <details><summary>{text(groups.older.length + ' older versions', '古いバージョン ' + groups.older.length + ' 件')}</summary>{groups.older.filter(matches).map(renderModel)}</details>}
                  </li>;
                })}
              </ul>
              <details className="assignment-custom"><summary>{text('Enter a model name', '名前を直接入力')}</summary>
                {[...candidates, ...(selecting === candidates.length ? [{ executor: 'claude', model: '', family: 'anthropic', tier: 'high' } as Candidate] : [])].map((entry, index) => {
                  const label = prefix + ' ' + (index + 1) + ' ';
                  const change = (patch: Partial<Candidate>) => { const entries = [...candidates]; entries[index] = { ...entry, ...patch }; update(role, weight, entries); };
                  return <fieldset key={index}><label>{text('Provider', '提供元')}<Segments label={label + text('Provider', '提供元')} value={entry.executor} options={Object.entries(PROVIDERS).map(([value, label]) => ({ value, label }))} onChange={value => { const executor = value as Candidate['executor']; const entries = [...candidates]; entries[index] = { executor, family: FAMILY[executor], model: models[executor]?.models.find(m => m.model)?.model ?? DEFAULT_MODEL[executor], tier: 'mid' }; update(role, weight, entries); }}/></label>
                  <label>{text('Model', 'モデル')}<input aria-label={label + text('Model', 'モデル')} value={entry.model} onChange={event => change({ model: event.target.value })}/></label>
                  <label>{text('Tier', 'ランク')}<Segments label={label + text('Tier', 'ランク')} value={entry.tier} options={['high', 'mid', 'low'].map(value => ({ value, label: text(({ high: 'High', mid: 'Mid', low: 'Low' })[value]!, ({ high: '上位', mid: '中位', low: '下位' })[value]!) }))} onChange={tier => change({ tier: tier as Candidate['tier'] })}/></label></fieldset>;
                })}
              </details>
              {weight !== 'standard' && <button className="btn btn-ghost" aria-label={prefix + ' ' + text('Use the standard column', 'ふつうと同じにする')} onClick={() => { update(role, weight); close(); }}>{text('Use the standard column', 'ふつうと同じにする')}</button>}

            </div>}
          </div></td>;
        })}</tr>{criteriaRole === role && <tr className="assignment-criteria-row"><td><button className="btn btn-ghost" onClick={() => setCriteriaRole(undefined)}>{text('Close', '閉じる')}</button></td>{WEIGHTS.map(weight => <td key={weight}><textarea rows={1} autoFocus={weight === 'light'} aria-label={NAMES[role][ja ? 1 : 0] + ' ' + weightName(weight) + ' ' + text('Weight criteria', '重さの基準')} value={displayText(policy.criteria[role]?.[weight] ?? '')} onChange={event => onChange({ ...policy, criteria: { ...policy.criteria, [role]: { ...policy.criteria[role], [weight]: event.target.value } } })}/></td>)}</tr>}</Fragment>;
      })}</tbody>
    </table></div>
    <div className="button-row assignment-actions"><span>{text('Presets', 'おすすめの組み合わせ')}</span><Segments label={text('Presets', 'おすすめの組み合わせ')} value={preset ?? ''} options={(['performance', 'balanced', 'economy'] as const).map(value => ({ value, label: ({ performance: text('Performance', '性能重視'), balanced: text('Balanced', 'バランス'), economy: text('Economy', '節約') })[value] }))} onChange={value => { close(); setPreset(value as Preset); }}/>{onApply && <button className="btn btn-secondary assignment-apply-button" disabled={applyDisabled} title={applyDisabled ? text('Save first', '先に保存する') : text('Writes to the Claude Code, Codex and Antigravity config files', 'Claude Code、Codex、Antigravity の設定ファイルを書き換える')} onClick={onApply}>{text('Export', '書き出す')}</button>}</div>
  </section>;
}

export function partitionModels<T extends { model: string; displayName: string }>(catalog: T[], used: Set<string>, latest: Set<string>) {
  const parse = (name: string) => { const match = /^(.*?)[ -]?(\d+(?:\.\d+)?)(?:[ -](.+))?$/.exec(name); return match ? { key: match[1].replace(/[- ]$/, '') + '/' + (match[3] ?? ''), version: Number(match[2]) } : undefined; };
  const maximum = new Map<string, number>();
  for (const model of catalog) { const p = parse(model.displayName); if (p) maximum.set(p.key, Math.max(maximum.get(p.key) ?? 0, p.version)); }
  const current: T[] = [], older: T[] = [];
  for (const model of catalog) { const p = parse(model.displayName); (used.has(model.model) || latest.has(model.model) || !p || p.version === maximum.get(p.key) ? current : older).push(model); }
  return { current, older };
}
