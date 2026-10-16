import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { OpenWorkspaceTerminal } from '../lib/workspace-context.ts';
import { createStore } from '../lib/store.ts';
import type { Ack } from '../lib/client.ts';

const id = '["claude","session"]';
const ack = (result: unknown = {}): Ack => ({ type: 'ack', cmd_id: 'cmd', ok: true, result });
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture(sendAck = ack()) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }],
    conversations: [{ id, provider: 'claude', origin: 'observed', project: 'p', cwd: '/repo', history_format: 'jsonl' }],
    runs: [{ id: 'r', conversation_id: id, generation: 1, state: 'idle', launch: { cwd: '/repo' } }],
  } });
  target.setConnection('connected');
  const openTerminal = vi.fn();
  const onConversation = vi.fn();
  const command = vi.fn(async (name: string) => {
    if (name === 'session.hosts') return ack({ hosts: [{ conversationId: id, terminalId: 'terminal', provider: 'claude', projectId: 'p', cwd: '/repo' }] });
    if (name === 'session.commands') return ack({ commands: [
      { name: 'help', description: 'Show help' }, { name: 'model', description: 'Choose a model' },
      { name: 'sample:check', description: 'Plugin check', argumentHint: '[target]' },
    ] });
    if (name === 'session.send') return sendAck;
    return ack([]);
  });
  const client = { command };
  const view = render(<MemoryRouter><OpenWorkspaceTerminal.Provider value={openTerminal}>
    <ConversationPage client={client} conversationId={id} target={target} onConversation={onConversation}/>
  </OpenWorkspaceTerminal.Provider></MemoryRouter>);
  return { command, target, openTerminal, onConversation, view, input: screen.getByRole('textbox', { name: 'Message' }) };
}

it('shows and filters commands, accepts keyboard or mouse choices and keeps focus in the composer', async () => {
  const f = fixture();
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.change(f.input, { target: { value: '/' } });
  expect(await screen.findByRole('listbox', { name: 'Slash commands' })).toBeTruthy();
  expect(screen.getAllByRole('option')).toHaveLength(3);
  expect(f.command).toHaveBeenCalledWith('session.commands', { conversationId: id, projectId: 'p', provider: 'claude' });
  fireEvent.keyDown(f.input, { key: 'ArrowDown' });
  fireEvent.keyDown(f.input, { key: 'Enter' });
  expect(f.input).toHaveProperty('value', '/model ');
  expect(f.command.mock.calls.some(([name]) => name === 'session.send')).toBe(false);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.change(f.input, { target: { value: '/sam' } });
  fireEvent.click(await screen.findByRole('option', { name: /sample:check/ }));
  expect(f.input).toHaveProperty('value', '/sample:check ');
  fireEvent.change(f.input, { target: { value: '/' } });
  await screen.findByRole('listbox');
  fireEvent.keyDown(f.input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(f.input).toHaveProperty('value', '/');
});

it('displays a transient command result without waiting for a jsonl message', async () => {
  const f = fixture(ack({ delivery: 'terminal', terminalId: 'terminal', command: { text: '/help', output: 'Help\n  Commands and shortcuts', status: 'completed' } }));
  fireEvent.change(f.input, { target: { value: '/help' } });
  await screen.findByRole('listbox');
  fireEvent.keyDown(f.input, { key: 'Enter', metaKey: true });
  expect((await screen.findByRole('status', { name: 'Command result' })).textContent).toContain('Commands and shortcuts');
  expect(f.input).toHaveProperty('value', '');
  expect(document.querySelector('.message-user')).toBeNull();
  expect(f.openTerminal).not.toHaveBeenCalled();
});

it('hands an interactive model picker to its existing terminal', async () => {
  const f = fixture(ack({ delivery: 'terminal', terminalId: 'terminal', command: { text: '/model', output: 'Select model', status: 'interactive' } }));
  fireEvent.change(f.input, { target: { value: '/model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(f.openTerminal).toHaveBeenCalledWith('terminal'));
  expect(screen.getByRole('status', { name: 'Command result' }).textContent).toContain('Select model');
  expect(f.command.mock.calls.some(([name]) => name === 'session.interrupt')).toBe(false);
});

it('preserves the draft and explains a blocked send without opening a terminal tab', async () => {
  const f = fixture({ type: 'ack', cmd_id: 'cmd', ok: false, error: 'Terminal is not ready for a message. Continue in the terminal tab.', result: { terminalId: 'terminal' } });
  fireEvent.change(f.input, { target: { value: 'After a panel' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Terminal is not ready');
  expect(screen.getByRole('alert').textContent).toContain('Continue in the terminal tab.');
  expect(f.input).toHaveProperty('value', 'After a panel');
  expect(document.querySelector('.message-user')).toBeNull();
  expect(f.openTerminal).not.toHaveBeenCalled();
});

it('follows the actual new conversation returned by /clear', async () => {
  const next = '["claude","new-session"]';
  const f = fixture(ack({ delivery: 'terminal', conversationId: next }));
  fireEvent.change(f.input, { target: { value: '/clear' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(f.onConversation).toHaveBeenCalledWith(next));
  expect(f.input).toHaveProperty('value', '');
});
