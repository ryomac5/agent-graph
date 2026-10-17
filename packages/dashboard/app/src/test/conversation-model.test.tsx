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
      : name === 'list_models' ? [{ model: 'opus', displayName: 'Opus 5.5' }, { model: 'haiku', displayName: 'Haiku 5.5' }, { model: 'sonnet', displayName: 'Sonnet 5.5' }]
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
  const button = screen.getByRole('button', { name: /^Model · / });
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
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

it.each(['No, go back', 'Escape'])('allows Apply after cancelling the terminal confirmation with %s', async cancellation => {
  const { command, conversationId, openTerminal } = setup({ response: { result: {
    terminalId: 'terminal', command: { status: 'interactive', output: 'Switch model?\n❯ 1. Yes, switch to Sonnet 5.5\n  2. No, go back' },
  } } });
  fireEvent.click(screen.getByRole('button', { name: /^Model · / }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sonnet 5.5' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(openTerminal).toHaveBeenCalledExactlyOnceWith('terminal'));
  expect(command).toHaveBeenCalledWith('session.send', { conversationId, text: '/model sonnet' });
  await selectHaiku();
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  const error = 'Terminal is not ready for a message. Continue in the terminal tab.';
  command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'blocked', ok: false, error });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', error);
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
  // 端末側のキャンセルを模擬する。記録のモデルは変わらず、API が再び送信を受け付ける。
  const cancelConfirmation = vi.fn(() => command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'retry', ok: true,
    result: { command: { status: 'completed', output: '⎿  Set model to Haiku 5.5' } },
  }));
  render(<button onClick={cancelConfirmation} onKeyDown={event => { if (event.key === 'Escape') cancelConfirmation(); }}>No, go back</button>);
  if (cancellation === 'Escape') fireEvent.keyDown(screen.getByRole('button', { name: 'No, go back' }), { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: 'No, go back' }));
  await selectHaiku();
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.getByTitle('Claude · haiku')).toBeTruthy());
  expect(command.mock.calls.filter(([name]) => name === 'session.send')).toHaveLength(3);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('accepts the wrapped terminal model confirmation', async () => {
  setup({ response: { result: { command: { status: 'completed', output: '⎿  Set model to Sonnet 5.5 and saved as your\n   default for new sessions' } } } });
  fireEvent.click(screen.getByRole('button', { name: /^Model · / }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sonnet 5.5' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.getByTitle('Claude · sonnet')).toBeTruthy());
  expect(screen.getByRole('button', { name: /^Model · Sonnet 5.5/ })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['Haiku 5.5', 'haiku', 'claude-haiku-5-5'])('accepts only the applied model display name or alias: %s', async confirmed => {
  setup({ response: { result: { command: { status: 'completed', output: `Set model to ${confirmed} and saved as your default for new sessions` } } } });
  await selectHaiku();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(screen.getByTitle('Claude · haiku')).toBeTruthy());
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['Sonnet 5.5', 'Haiku 5.5 extra'])('keeps the displayed model when confirmation names a different model: %s', async confirmed => {
  setup({ response: { result: { command: { status: 'completed', output: `Set model to ${confirmed} and saved as your default for new sessions` } } } });
  await selectHaiku();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Model · Opus 5.5/ })).toBeTruthy();
});

it('reports an empty successful response as a failure', async () => {
  setup({ response: { result: {} } });
  await selectHaiku();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
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

it('updates the composer and model panel from projection after interactive confirmation without another reply', async () => {
  const { openTerminal, target, conversationId } = setup({ response: { result: {
    terminalId: 'terminal', command: { status: 'interactive', output: 'Switch model?' },
  } } });
  await selectHaiku();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(openTerminal).toHaveBeenCalledExactlyOnceWith('terminal'));
  expect(screen.getByTitle('Claude · opus')).toBeTruthy();
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    runs: { upsert: [{ id: 'r', conversation_id: conversationId, generation: 1, state: 'idle', model: 'Haiku 5.5' }], remove: [] },
  } }));
  expect(screen.getByTitle('Claude · Haiku 5.5')).toBeTruthy();
  expect(screen.getByRole('button', { name: /^Model · Haiku 5.5/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Model · / }));
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
});
