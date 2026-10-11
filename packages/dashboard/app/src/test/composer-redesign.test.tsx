import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ChoiceMenu } from '../components/ChoiceMenu.tsx';
import { findOlderModels, readRecommendedModel, readVisibleModels } from '../components/conversation/models.ts';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { createStore } from '../lib/store.ts';
import { buildRows } from '../pages/graph/rows.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('resolves actual executor candidates before config, including legacy role arrays', () => {
  const claude = { executor: 'claude', model: 'opus' }; const codex = { executor: 'codex', model: 'gpt-6-astra' };
  expect(readRecommendedModel({ policy: { roles: { orchestrate: { standard: [codex, claude, { ...claude, model: 'sonnet' }] } } }, config: { agents: { claude: { model: 'haiku' } } } }, 'claude')).toBe('opus');
  expect(readRecommendedModel({ policy: { roles: { orchestrate: [codex, claude] } } }, 'codex')).toBe('gpt-6-astra');
  expect(readRecommendedModel({ config: { agents: { codex: { model: 'gpt-6.1-sol' } } } }, 'codex')).toBe('gpt-6.1-sol');
  expect(readRecommendedModel({}, 'claude')).toBe('');
});
it('folds older versions per family while retaining assigned and latest models', () => {
  const models = ['Opus 5.5', 'Opus 5', 'Sonnet 5.5', 'Sonnet 4.6', 'GPT-6.1-Sol', 'GPT-6-Sol', 'Gemini 3.8 Flash', 'Gemini 3 Flash', 'GPT-Reserve'].map(displayName => ({ model: displayName, displayName }));
  const visible = readVisibleModels({ policy: { roles: { implement: { heavy: [{ model: 'Sonnet 4.6' }] } }, modelNotes: [{ model: 'GPT-6-Sol', latest: true }] } });
  expect(findOlderModels(models, visible)).toEqual(new Set(['Opus 5', 'Gemini 3 Flash']));
});
it('focuses the selected menu row and supports arrows, Enter, Escape and older versions', () => {
  const choose = vi.fn();
  render(<ChoiceMenu name="Model" label="Opus" value="opus" choices={[{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'old', label: 'Opus 5', older: true }]} onChange={choose} olderLabel="1 older versions"/>);
  const trigger = screen.getByRole('button', { name: 'Model' }); fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Opus' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Sonnet' }));
  // jsdom では Enter の click を再現する。
  fireEvent.click(document.activeElement!); expect(choose).toHaveBeenCalledWith('sonnet');
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: '1 older versions' }));
  expect(screen.getByRole('menuitemradio', { name: 'Opus 5' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger); expect(screen.queryByRole('menuitemradio', { name: 'Opus 5' })).toBeNull();
});
it.each(['en', 'ja'] as const)('preserves the provider default until the policy recommendation is explicitly chosen in %s', async language => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projection: {}, generation: 0, next: null }) })));
  const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'p', root_path: '/repo' }] } }); target.setConnection('connected');
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: name === 'settings.read' ? { policy: { roles: { orchestrate: { standard: [{ executor: 'claude', model: 'claude-opus-5-5' }] } } } } : name === 'list_models' ? [{ model: 'default', displayName: 'Default (recommended)' }, { model: 'sonnet', displayName: 'Sonnet 5.5' }, { model: 'opus', displayName: 'Opus 5.5' }] : { hosts: [] } }));
  render(<MemoryRouter><ConversationPage target={target} client={{ command }} newSession={{ cwd: '/repo', projectId: 'p' }} language={language}/></MemoryRouter>);
  await act(async () => {});
  const label = language === 'ja' ? 'モデル · モデルを取得できない' : 'Model · No models available';
  fireEvent.click(screen.getByRole('button', { name: label }));
  const recommended = language === 'ja' ? 'おすすめ · モデルを取得できない' : 'Recommended · No models available';
  expect(screen.getByRole('menuitemradio', { name: recommended }).getAttribute('aria-checked')).toBe('true');
  expect((screen.getByRole('button', { name: language === 'ja' ? '適用' : 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: /^(Effort|思考量) · / })).toBeNull();
  expect(document.querySelector('.composer select')).toBeNull();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }));
  fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '適用' : 'Apply' }));
  fireEvent.change(screen.getByRole('textbox', { name: language === 'ja' ? '入力' : 'Message' }), { target: { value: 'Begin' } });
  fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '送信' : 'Send' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider: 'claude', model: 'opus' }));
  await act(async () => {});
});
it('adds sixteen pixels to row geometry in narrow panels without changing counts or grouping', () => {
  const tree = { roots: ['root'], edges: [], unresolved: [], nodes: [{ id: 'root', kind: 'conversation' as const, label: 'Root', role: 'orchestrate', state: 'idle', provider: 'claude', model: 'opus', children: ['child'], attempts: [] }, { id: 'child', kind: 'conversation' as const, label: 'Child', role: 'implement', state: 'running', provider: 'codex', model: 'gpt-6.1-sol', children: [], attempts: [] }] };
  const wide = buildRows(tree, { now: 0 }); const narrow = buildRows(tree, { now: 0, compact: true });
  expect(wide.rows.map(row => row.height)).toEqual([32, 52]);
  expect(narrow.rows.map(row => row.height)).toEqual([48, 68]);
  expect(narrow.running).toBe(wide.running); expect(narrow.roles).toEqual(wide.roles);
});
