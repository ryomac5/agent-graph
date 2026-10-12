import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { defaultPolicy } from '../../../../core/src/assign/policy.ts';
import { DEFAULT_KEYS } from '../lib/keys.ts';
import { SettingMenu } from '../components/settings/Controls.tsx';
import { SettingsLayout } from '../pages/settings/SettingsLayout.tsx';
import { PolicyEditor } from '../pages/settings/PolicyEditor.tsx';
import { ModelAssignments, partitionModels } from '../pages/settings/ModelAssignments.tsx';

afterEach(cleanup);
it('fills the rules card with weight rows and separators while preserving the fixed columns', () => {
  const css = readFileSync('app/src/pages/settings/settings.css', 'utf8');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  try {
    const { container } = render(<div className="settings-page"><PolicyEditor client={{ command: vi.fn() }} policy={defaultPolicy()} models={{}} language="ja" dirty={false} onChange={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()}/></div>);
    const card = container.querySelector('#settings-rules .settings-card')!;
    expect(getComputedStyle(card).width).toBe('100%');
    expect(getComputedStyle(card).maxWidth).toBe('none');
    expect(card.querySelector('.settings-sentence')).toBeTruthy();
    expect(card.querySelector('.settings-constraint-row')).toBeTruthy();
    const weights = card.querySelector('.settings-weights')!;
    expect(getComputedStyle(weights).width).toBe('100%');
    expect(getComputedStyle(weights).maxWidth).toBe('none');
    const rows = weights.querySelectorAll('.settings-weight-row');
    expect(rows).toHaveLength(4);
    // jsdom は実寸を計算しないため、全幅と残り幅を使う指定を確かめる。
    for (const row of rows) {
      expect(getComputedStyle(row).width).toBe('100%');
      const label = getComputedStyle(row.querySelector('label')!);
      expect(label.flexGrow).toBe('1');
      expect(label.gridTemplateColumns).toBe('200px minmax(0, 1fr)');
      expect(getComputedStyle(row.querySelector('input[type="range"]')!).width).toBe('100%');
      expect(getComputedStyle(row.querySelector('.settings-number-unit')!).flexShrink).toBe('0');
      expect(getComputedStyle(row.querySelector('input[type="number"]')!).width).toBe('64px');
      expect(row.lastElementChild?.textContent).toBe('%');
    }
    expect(css.match(/\.settings-weight-row\s*\{([^}]+)\}/)![1]).toContain('border-bottom: var(--border)');
  } finally {
    style.remove();
  }
});
it.each(['en', 'ja'] as const)('orders five sections, folds rules and keys, and avoids selects in %s', async language => {
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'test', ok: true, result: { connections: [] } })) };
  const policy = defaultPolicy();
  const { container } = render(<div className="settings-page"><SettingsLayout client={client} projects={[]} language={language} theme="system" onTheme={vi.fn()} onLanguage={vi.fn()} bindings={DEFAULT_KEYS} onKeys={vi.fn()}><PolicyEditor client={client} policy={policy} models={{ claude: { state: "unknown", models: [] }, codex: { state: "unknown", models: [] }, antigravity: { state: "unknown", models: [] } }} language={language} dirty={false} onChange={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()}/></SettingsLayout></div>);
  expect([...container.querySelectorAll('[id^="settings-"]')].map(element => element.id)).toEqual(['settings-models', 'settings-rules', 'settings-appearance', 'settings-ssh', 'settings-keys']);
  for (const id of ['rules', 'ssh', 'keys']) expect(container.querySelector('#settings-' + id)).toHaveProperty('open', false);
  expect(container.querySelector('#settings-rules .settings-summary')?.textContent).toContain('70%');
  expect(container.querySelector('#settings-keys .settings-summary')?.textContent).toContain('28');
  expect(container.querySelectorAll('select')).toHaveLength(0);
  expect(container.querySelectorAll('.assignment-table tbody > tr')).toHaveLength(8);
  const cells = [...container.querySelectorAll('.assignment-table tbody td')];
  expect(cells).toHaveLength(24);
  cells.forEach(cell => expect(cell.querySelector('button')?.textContent?.trim()).toBeTruthy());
  expect(container.querySelectorAll('.assignment-inherited')).toHaveLength(10);
  expect(container.textContent).not.toMatch(/デフォルト|標準モデルを使用|On limits or errors/);
  await screen.findByRole('button', { name: language === 'ja' ? '接続先を追加' : 'Add connection', hidden: true });
});
it('keeps used older models visible while folding only obsolete versions', () => {
  const names = ['Opus 5.5', 'Opus 5', 'Opus 4.6', 'GPT-6.1-Sol', 'GPT-6-Sol', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash', 'GPT-Reserve'];
  const catalog = names.map(model => ({ model, displayName: model }));
  const result = partitionModels(catalog, new Set(['Opus 5']));
  expect(result.current.map(model => model.model)).toEqual(['Opus 5.5', 'Opus 5', 'GPT-6.1-Sol', 'Gemini 3.8 Flash', 'GPT-Reserve']);
  expect(result.older.map(model => model.model)).toEqual(['Opus 4.6', 'GPT-6-Sol', 'Gemini 3.5 Flash']);
});
it('searches catalog names and leaves Antigravity without effort controls', () => {
  function Editor() { const [policy, setPolicy] = useState(defaultPolicy()); return <ModelAssignments policy={policy} onChange={setPolicy} language="ja" models={{ antigravity: { state: 'known', models: [{ model: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash' }] } }}/>; }
  render(<Editor/>);
  fireEvent.click(screen.getByRole('button', { name: '実装 ふつうの作業 割り当てを編集' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('使うモデル')).toBeTruthy();
  expect(within(dialog).getByText('予備 1')).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: '実装 ふつうの作業 予備を追加' })).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'モデルを探す' }), { target: { value: 'Gemini' } });
  const list = within(dialog).getByRole('list', { name: '実装 ふつうの作業 1 モデルの一覧' });
  expect(within(list).queryByRole('button', { name: 'opus' })).toBeNull();
  fireEvent.click(within(list).getByRole('button', { name: 'Gemini 3.8 Flash' }));
  expect(within(dialog).queryByRole('group', { name: '実装 ふつうの作業 1 思考量' })).toBeNull();
});
it('focuses the selected menu row, navigates with arrows and returns focus after selection', () => {
  const change = vi.fn();
  render(<SettingMenu label="Choice" value="b" options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]} onChange={change}/>);
  const trigger = screen.getByRole('button', { name: 'Choice' });
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Beta' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Alpha' }));
  fireEvent.click(document.activeElement!);
  expect(change).toHaveBeenCalledWith('a');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('keeps the model save action alongside export and the preset controls', () => {
  const client = { command: vi.fn() };
  const { container } = render(<PolicyEditor client={client} policy={defaultPolicy()} models={{}} language="ja" dirty={false} onChange={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()}/>);
  const actions = container.querySelector('#settings-models .assignment-actions')!;
  expect(within(actions as HTMLElement).getByRole('button', { name: '保存' })).toBeTruthy();
  expect(within(actions as HTMLElement).getByRole('button', { name: '書き出す' })).toBeTruthy();
  expect(actions.lastElementChild?.textContent).toBe('保存');
  const summary = container.querySelector('#settings-rules .settings-summary')!;
  expect(summary.parentElement?.tagName).toBe('SUMMARY');
});
it('uses the documented shortcut descriptions in both languages', () => {
  for (const language of ['ja', 'en'] as const) {
    const { container, unmount } = render(<SettingsLayout client={{ command: vi.fn(async () => ({ ok: true, type: 'ack' as const, cmd_id: 'test', result: { connections: [] } })) }} projects={[]} language={language} theme="light" onTheme={vi.fn()} onLanguage={vi.fn()} bindings={DEFAULT_KEYS} onKeys={vi.fn()}><></></SettingsLayout>);
    const keys = container.querySelector('#settings-keys')!;
    for (const label of language === 'ja' ? ['承認を許可', '承認を拒否', '次の行へ', '前の行へ', 'この一覧を開く'] : ['Allow approval', 'Deny approval', 'Next row', 'Previous row', 'Show shortcuts']) expect(keys.textContent).toContain(label);
    unmount();
  }
});
