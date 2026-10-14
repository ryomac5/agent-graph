import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { OpenWorkspaceTerminal } from '../lib/workspace-context.ts';
import { createStore } from '../lib/store.ts';
import type { Ack } from '../lib/client.ts';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup({ provider = 'claude', hosted = true, disconnected = false, response = {} as Partial<Ack> } = {}) {
  const conversationId = JSON.stringify([provider, 'session']);
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    conversations: [{ id: conversationId, provider, origin: 'observed', cwd: '/repo' }],
    runs: [{ id: 'r', conversation_id: conversationId, generation: 1, state: 'idle', model: 'opus' }],
  } });
  target.setConnection('connected');
  const command = vi.fn(async (name: string): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: true,
    result: name === 'session.hosts' ? { hosts: hosted ? [{ conversationId, terminalId: 'terminal', launchModel: 'opus', disconnected }] : [] }
      : name === 'list_models' ? [{ model: 'opus', displayName: 'Opus 5.5' }, { model: 'haiku', displayName: 'Haiku 5.5' }]
      : name === 'settings.models' ? { defaults: { model: 'haiku' } }
      : {}, ...(name === 'session.send' ? response : {}),
  }));
  const openTerminal = vi.fn();
  render(<MemoryRouter><OpenWorkspaceTerminal.Provider value={openTerminal}>
    <ConversationPage conversationId={conversationId} target={target} client={{ command }}/>
  </OpenWorkspaceTerminal.Provider></MemoryRouter>);
  return { conversationId, target, command, openTerminal };
}

async function selectHaiku() {
  fireEvent.click(screen.getByRole('button', { name: /^Model · / }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Haiku 5.5' }));
}

it('sends exactly one model command to an open Claude terminal and updates the model only after confirmation', async () => {
  let finish!: (ack: Ack) => void;
  const pending = new Promise<Ack>(resolve => { finish = resolve; });
  const { command, conversationId, target } = setup();
  await selectHaiku();
  command.mockImplementationOnce(() => pending);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(command.mock.calls.filter(([name]) => name === 'session.send')).toHaveLength(1);
  expect(command).toHaveBeenCalledWith('session.send', { conversationId, text: '/model haiku' });
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
  await act(async () => { finish({ type: 'ack', cmd_id: 'apply', ok: true, result: {
    delivery: 'terminal', terminalId: 'terminal', command: { status: 'completed', output: '⎿  Set model to Haiku 5.5' },
  } }); });
  expect(screen.getByTitle('Claude · haiku')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Model · Haiku 5.5/ })).toBeTruthy();
  expect(command.mock.calls.filter(([name]) => ['session.launch', 'set_model'].includes(name))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^Model · / }));
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  // 次の観測が届いたら、ローカルの適用結果より記録を優先する。
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    runs: { upsert: [{ id: 'r', conversation_id: conversationId, generation: 1, state: 'idle', model: 'claude-haiku-5-5' }], remove: [] },
  } }));
  expect(screen.getByTitle('Claude · claude-haiku-5-5')).toBeTruthy();
});

it('keeps an interactive model switch in the existing terminal flow without claiming success', async () => {
  const { openTerminal } = setup({ response: { result: { terminalId: 'terminal', command: { status: 'interactive', output: 'Switch model?' } } } });
  await selectHaiku();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(openTerminal).toHaveBeenCalledExactlyOnceWith('terminal'));
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
  expect(screen.getByRole('status', { name: 'Command result' }).textContent).toContain('Switch model?');
});

it.each([
  { ok: false, error: 'Terminal is not ready' },
  { ok: true, result: { command: { status: 'completed', output: 'Invalid model: haiku' } } },
])('does not change the displayed model for an unconfirmed switch: %j', async response => {
  const { command } = setup({ response });
  await selectHaiku();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('session.send', expect.anything()));
  if (!response.ok) expect(await screen.findByRole('alert')).toHaveProperty('textContent', response.error);
  else await screen.findByRole('status', { name: 'Command result' });
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
});

it.each([{ hosted: false }, { disconnected: true }, { provider: 'codex' }])('disables terminal model Apply when unavailable: %j', async options => {
  const { command } = setup(options);
  await selectHaiku();
  const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(apply);
  expect(command.mock.calls.filter(([name]) => name === 'session.send')).toHaveLength(0);
  if (options.provider === 'codex') expect(screen.getByText('Change the model in the Codex terminal. /model requires interactive selection.')).toBeTruthy();
});
