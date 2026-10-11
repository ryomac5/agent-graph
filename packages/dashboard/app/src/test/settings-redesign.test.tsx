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
it.each(['en', 'ja'] as const)('orders five sections, folds rules and keys, and avoids selects in %s', async language => {
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'test', ok: true, result: { connections: [] } })) };
  const policy = defaultPolicy();
  const { container } = render(<div className="settings-page"><SettingsLayout client={client} projects={[]} language={language} theme="system" onTheme={vi.fn()} onLanguage={vi.fn()} bindings={DEFAULT_KEYS} onKeys={vi.fn()}><PolicyEditor client={client} policy={policy} models={{}} language={language} dirty={false} onChange={vi.fn()} onSaved={vi.fn()} onRefresh={vi.fn()}/></SettingsLayout></div>);
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
it('keeps used and latest older models visible while folding only obsolete versions', () => {
  const names = ['Opus 5.5', 'Opus 5', 'Opus 4.6', 'GPT-6.1-Sol', 'GPT-6-Sol', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash', 'GPT-Reserve'];
  const catalog = names.map(model => ({ model, displayName: model }));
  const result = partitionModels(catalog, new Set(['Opus 5']), new Set(['Gemini 3.5 Flash']));
  expect(result.current.map(model => model.model)).toEqual(['Opus 5.5', 'Opus 5', 'GPT-6.1-Sol', 'Gemini 3.8 Flash', 'Gemini 3.5 Flash', 'GPT-Reserve']);
  expect(result.older.map(model => model.model)).toEqual(['Opus 4.6', 'GPT-6-Sol']);
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
  expect(within(dialog).queryByText('モデルのメモを編集')).toBeNull();
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
