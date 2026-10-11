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
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: name === 'settings.models' ? { defaults: { model: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', effort: 'medium', modelSource: { kind: 'file', path: '/repo/.claude/settings.local.json', key: 'model' }, effortSource: { kind: 'provider', key: 'model default effort' } } } : name === 'settings.read' ? { policy: { roles: { orchestrate: { standard: [{ executor: 'claude', model: 'claude-opus-5-5' }] } } } } : name === 'list_models' ? [{ model: 'default', displayName: 'Default (recommended)' }, { model: 'sonnet', displayName: 'Sonnet 5.5' }, { model: 'opus', displayName: 'Opus 5.5' }] : { hosts: [] } }));
  render(<MemoryRouter><ConversationPage target={target} client={{ command }} newSession={{ cwd: '/repo', projectId: 'p' }} language={language}/></MemoryRouter>);
  await act(async () => {});
  const label = language === 'ja' ? 'モデル · Sonnet 5.5' : 'Model · Sonnet 5.5';
  fireEvent.click(screen.getByRole('button', { name: label }));
  const recommended = language === 'ja' ? 'おすすめ · Sonnet 5.5' : 'Recommended · Sonnet 5.5';
  expect(screen.getByRole('menuitemradio', { name: recommended }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('menuitemradio', { name: recommended }).title).toBe('/repo/.claude/settings.local.json · model');
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
it.each(['en', 'ja'] as const)('shows unavailable only when provider defaults cannot be resolved in %s', async language => {
  const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'p', root_path: '/repo' }] } }); target.setConnection('connected');
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result:
    name === 'list_models' ? [{ model: 'opus', displayName: 'Opus 5.5' }]
      : name === 'settings.models' ? { defaults: { model: null, displayName: null, effort: null, modelSource: { kind: 'provider', key: 'account default' } } }
        : name === 'settings.read' ? { policy: { roles: { orchestrate: { standard: [{ executor: 'claude', model: 'opus' }] } } } } : { hosts: [] } }));
  render(<MemoryRouter><ConversationPage target={target} client={{ command }} newSession={{ cwd: '/repo', projectId: 'p' }} language={language}/></MemoryRouter>);
  await waitFor(() => expect(command).toHaveBeenCalledWith('settings.models', { provider: 'claude', cwd: '/repo' }));
  await act(async () => {});
  const unknown = language === 'ja' ? 'モデルを取得できない' : 'No models available';
  fireEvent.click(screen.getByRole('button', { name: `${language === 'ja' ? 'モデル' : 'Model'} · ${unknown}` }));
  expect(screen.getByRole('menuitemradio', { name: `${language === 'ja' ? 'おすすめ' : 'Recommended'} · ${unknown}` }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }).getAttribute('aria-checked')).toBe('false');
});
it('launches without a model override and shows the resolved Codex effort and provenance before selection', async () => {
  const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'p', root_path: '/repo' }] } }); target.setConnection('connected');
  let launched = false;
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result:
    name === 'list_models' ? [{ model: 'other', displayName: 'Other model' }]
      : name === 'settings.models' ? { defaults: { model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', effort: 'high', modelSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model' }, effortSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model_reasoning_effort' } } }
        : name === 'session.launch' ? (launched = true, { terminalId: 't' })
          : name === 'session.hosts' ? { hosts: launched ? [{ terminalId: 't', conversationId: '["codex","native"]' }] : [] } : {} }));
  render(<MemoryRouter><ConversationPage target={target} client={{ command }} newSession={{ cwd: '/repo', projectId: 'p' }}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await screen.findByRole('button', { name: 'Model · GPT-6.1-Sol' });
  fireEvent.click(screen.getByRole('button', { name: 'Effort · high' }));
  const auto = screen.getByRole('menuitemradio', { name: 'Auto' }); expect(auto.title).toBe('/repo/.codex/config.toml · model_reasoning_effort');
  fireEvent.click(auto);
  expect(screen.getByRole('button', { name: 'Effort · Auto' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Begin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider: 'codex' }));
  await act(async () => {});
});
it('discards a default model response from the previous working directory', async () => {
  const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'p', root_path: '/repo' }] } }); target.setConnection('connected');
  const response = (model: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: { defaults: { model, displayName: model, modelSource: { kind: 'file', path: '/settings.json', key: 'model' } } } });
  let first!: (value: ReturnType<typeof response>) => void;
  const command = vi.fn(async (name: string, payload?: unknown) => {
    if (name === 'settings.models') return (payload as { cwd: string }).cwd === '/repo' ? new Promise<ReturnType<typeof response>>(resolve => { first = resolve; }) : response('Sonnet 5.5');
    return { type: 'ack' as const, cmd_id: 'cmd', ok: true, result: name === 'list_models' ? [{ model: 'default', displayName: 'Default (recommended)' }] : {} };
  });
  const client = { command };
  const view = render(<MemoryRouter><ConversationPage target={target} client={client} newSession={{ cwd: '/repo', projectId: 'p' }}/></MemoryRouter>);
  await waitFor(() => expect(first).toBeTypeOf('function'));
  view.rerender(<MemoryRouter><ConversationPage target={target} client={client} newSession={{ cwd: '/other', projectId: 'p' }}/></MemoryRouter>);
  await screen.findByRole('button', { name: 'Model · Sonnet 5.5' });
  await act(async () => first(response('Opus 5.5')));
  expect(screen.getByRole('button', { name: 'Model · Sonnet 5.5' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Model · Opus 5.5' })).toBeNull();
});
