import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { ModelAssignments, type ModelCatalog } from '../pages/settings/ModelAssignments.tsx';
import { createBalancedRoles, createPreset, readCandidates } from '../pages/settings/assignment-presets.ts';
import { roleWord } from '../pages/graph/rows.ts';
import { shownRole } from '../lib/roots.ts';
import type { Policy } from '../lib/settings.ts';

afterEach(cleanup);
const models: ModelCatalog = {
  claude: { state: 'known', models: [{ model: 'opus', displayName: 'Claude Opus' }, { model: 'sonnet', displayName: 'Claude Sonnet' }] },
  codex: { state: 'known', models: [{ model: 'gpt-6-astra', displayName: 'GPT-6 Astra' }, { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }] },
  antigravity: { state: 'known', models: [{ model: 'gemini-3.8-flash-high', displayName: 'Gemini Flash' }] },
};
function setup(policy = defaultPolicy(), language: 'ja' | 'en' = 'ja') {
  const change = vi.fn();
  function Editor() {
    const [value, setValue] = useState(policy);
    return <ModelAssignments policy={value} language={language} models={models} onChange={next => { change(next); setValue(next); }}/>;
  }
  render(<Editor/>);
  return change;
}
const edit = () => fireEvent.click(screen.getByRole('button', { name: '実装 標準 割り当てを編集' }));
it.each(['ja', 'en'] as const)('explains each preset and the required save without changing policy on selection in %s', language => {
  const change = setup(defaultPolicy(), language);
  const ja = language === 'ja';
  const presets = [
    [ja ? '性能重視' : 'Performance', ja ? '各役割で覚え書きの強さが最大の候補を選び、同点ならモデル水準と候補順で決めます。' : 'Choose the strongest noted candidate for each role, breaking ties by model tier and candidate order.'],
    [ja ? 'バランス' : 'Balanced', ja ? '既定の組み合わせに戻します。' : 'Restore the default combination.'],
    [ja ? '節約' : 'Economy', ja ? '軽量モデルを標準の負荷にも使います。' : 'Use light models for standard workloads too.'],
  ];
  for (const [name, description] of presets) {
    fireEvent.click(screen.getByRole('button', { name }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(description).className).toBe('assignment-note');
    expect(within(dialog).getByText(ja ? '確認して表に反映した後、試算して「割り当てを保存」で保存します。' : 'Confirm to update the table, then preview and save the policy.')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: ja ? '取り消す' : 'Cancel' }));
  }
});

it('omits Japanese descriptions and the same role names in assignments and graphs', () => {
  setup();
  expect(screen.getByRole('heading', { name: '役割別のモデル' })).toBeTruthy();
  expect(screen.queryByText('エージェントの役割とタスクの負荷に応じて、使用するAIモデルを設定します。')).toBeNull();
  const roles = {
    orchestrate: ['Main agent', 'メインエージェント', '直接の対話とタスクの進行を担当'],
    advisor: ['Advisor', 'アドバイザー', '難度の高い判断や方針決定を支援'],
    research: ['Research', 'リサーチ', 'ドキュメントや技術情報の調査'],
    implement: ['Implementation', '実装', '機能追加や修正のコード作成'],
    document: ['Documentation', 'ドキュメント', '仕様書や解説文などの文書作成'],
    review: ['Code review', 'コードレビュー', '変更差分の品質や安全性を検証'],
    verify: ['Verification', '動作検証', 'テスト実行と画面や実機の動作確認'],
    proofread: ['Proofreading', '校正', '誤字脱字の修正や表現の改善'],
  } as const;
  for (const [role, [en, ja, description]] of Object.entries(roles)) {
    expect(screen.getByText(ja)).toBeTruthy();
    expect(screen.queryByText(description)).toBeNull();
    expect(shownRole(role, 'ja')).toBe(ja);
    expect(shownRole(role, 'en')).toBe(en);
    expect(roleWord(role as keyof typeof roles, 'ja')).toBe(ja);
    expect(roleWord(role as keyof typeof roles, 'en')).toBe(en);
  }
  for (const name of ['軽量', '標準', '高負荷']) expect(screen.getByRole('columnheader', { name })).toBeTruthy();
  expect(screen.getAllByText('標準モデルを使用').length).toBeGreaterThan(0);
});

it.each(['ja', 'en'] as const)('shows ordered fallback models with catalog names in %s', language => {
  const policy = defaultPolicy();
  const standard = readCandidates(policy, 'implement', 'standard');
  policy.roles.implement = { standard: [...standard, { executor: 'antigravity', model: 'gemini-3.8-flash-high', family: 'google', tier: 'high' }] };
  setup(policy, language);
  expect(screen.getByText(language === 'ja' ? '上限時やエラー時: Claude Opus → Gemini Flash' : 'On limits or errors: Claude Opus → Gemini Flash')).toBeTruthy();
  expect(screen.queryByText(/\+\d+ 候補|\+\d+ candidates/)).toBeNull();
});

it('selects grouped catalog rows, preserves family and shows official provider marks with notes', () => {
  const policy = defaultPolicy(); policy.modelNotes[0].latest = true;
  const change = setup(policy); edit();
  const list = screen.getByRole('list', { name: '実装 標準 1 モデルの一覧' });
  for (const provider of ['Claude', 'Codex', 'Antigravity']) expect(within(list).getByText(provider)).toBeTruthy();
  expect(within(list).getByText('最新 · SWE-bench で最上位。')).toBeTruthy();
  expect(within(list).getByText('日本語の性能が高い。')).toBeTruthy();
  const row = within(list).getByRole('button', { name: 'Claude Sonnet' });
  expect(row.querySelector('img')?.getAttribute('src')).toBe('/brand/claude.svg');
  expect(screen.getByLabelText('実装 標準 1 モデル').closest('details')).toHaveProperty('open', false);
  fireEvent.click(row);
  expect(readCandidates(change.mock.lastCall![0], 'implement', 'standard')[0]).toEqual({ executor: 'claude', model: 'sonnet', family: 'anthropic', tier: 'mid' });
  fireEvent.click(screen.getByText('その他のモデル'));
  fireEvent.change(screen.getByRole('textbox', { name: '実装 標準 1 モデル' }), { target: { value: 'custom-model' } });
  expect(readCandidates(change.mock.lastCall![0], 'implement', 'standard')[0].model).toBe('custom-model');
});

it('switches effort using provider-specific buttons and clears incompatible effort on provider changes', () => {
  const change = setup(); edit();
  const group = screen.getByRole('group', { name: '実装 標準 1 深さ' });
  fireEvent.click(within(group).getByRole('button', { name: 'xhigh' }));
  expect(readCandidates(change.mock.lastCall![0], 'implement', 'standard')[0].effort).toBe('xhigh');
  fireEvent.click(within(screen.getByRole('list', { name: '実装 標準 1 モデルの一覧' })).getByRole('button', { name: 'Claude Opus' }));
  expect(within(group).queryByRole('button', { name: 'none' })).toBeNull();
  expect(within(group).queryByRole('button', { name: 'ultra' })).toBeNull();
  fireEvent.click(within(group).getByRole('button', { name: 'max' }));
  fireEvent.click(within(screen.getByRole('list', { name: '実装 標準 1 モデルの一覧' })).getByRole('button', { name: 'Gemini Flash' }));
  expect(readCandidates(change.mock.lastCall![0], 'implement', 'standard')[0]).not.toHaveProperty('effort');
  expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['既定']);
});

it('adds fallbacks from the same list and supports drag ordering', () => {
  const change = setup(); edit();
  fireEvent.click(screen.getByRole('button', { name: '実装 標準 代わりに使うモデルを足す' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('list', { name: '実装 標準 3 モデルの一覧' })).getByRole('button', { name: 'Gemini Flash' }));
  expect(readCandidates(change.mock.lastCall![0], 'implement', 'standard')).toHaveLength(3);
  const rows = document.querySelectorAll('.assignment-candidates > li');
  fireEvent.dragStart(rows[2]); fireEvent.dragOver(rows[1]); fireEvent.drop(rows[1]);
  expect(readCandidates(change.mock.lastCall![0], 'implement', 'standard').map(candidate => candidate.model)).toEqual(['gpt-6-astra', 'gemini-3.8-flash-high', 'opus']);
  expect(screen.queryByText('上限時やエラー時は Gemini Flash に切り替え、さらに Claude Opus')).toBeNull();
});

it('opening an inherited assignment leaves the policy untouched until a model is chosen', () => {
  const change = setup();
  fireEvent.click(screen.getByRole('button', { name: 'アドバイザー 軽量 割り当てを編集' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'アドバイザー 軽量 割り当てを編集' }).textContent).toBe('標準モデルを使用');
});

it.each(['性能重視', 'バランス', '節約'])('previews changed cells, allows cancellation and only updates the table after confirming %s', name => {
  const policy = defaultPolicy();
  if (name === 'バランス') policy.roles.implement = { standard: [{ executor: 'claude', model: 'custom-opus', family: 'anthropic', tier: 'high' }] };
  const original = structuredClone(policy);
  const change = setup(policy);
  fireEvent.click(screen.getByRole('button', { name }));
  const dialog = screen.getByRole('dialog', { name: 'まとめて変更する内容' });
  expect(within(dialog).getByRole('columnheader', { name: '変更前' })).toBeTruthy();
  expect(within(dialog).getByRole('columnheader', { name: '変更後' })).toBeTruthy();
  expect(within(dialog).getAllByRole('row').length).toBeGreaterThan(1);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '取り消す' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name }));
  fireEvent.click(screen.getByRole('button', { name: '確認して表に反映' }));
  const next = change.mock.lastCall![0] as Policy;
  expect(next.quota).toEqual(original.quota); expect(next.modelNotes).toEqual(original.modelNotes);
  if (name === '節約') expect(readCandidates(next, 'implement', 'standard')).toEqual(readCandidates(original, 'implement', 'light'));
  if (name === 'バランス') expect(next.roles).toEqual(defaultPolicy().roles);
  if (name === '性能重視') {
    expect(readCandidates(next, 'implement', 'light')[0].model).toBe('gpt-6-astra');
    expect(readCandidates(next, 'implement', 'heavy')[0].effort).toBe('xhigh');
  }
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps the balanced preset aligned with core defaults and compares explicit numeric strengths', () => {
  const policy = defaultPolicy();
  expect(createBalancedRoles()).toEqual(policy.roles);
  policy.modelNotes = [{ model: 'opus', strength: '95', latest: false, specialties: '' }, { model: 'gpt-6-astra', strength: '80', latest: true, specialties: '' }];
  const next = createPreset(policy, 'performance');
  expect(readCandidates(next, 'implement', 'standard')[0].model).toBe('opus');
});
