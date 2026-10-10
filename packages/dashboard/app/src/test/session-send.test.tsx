import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { ConversationPage, type ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { createStore } from '../lib/store.ts';
import { listPanes, restoreWorkspace, workspaceKey } from '../lib/panes.ts';
import type { Ack } from '../lib/client.ts';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ack = (result: unknown = {}): Ack => ({ type: 'ack', cmd_id: 'cmd', ok: true, result });
function fixture(origin = 'managed', state = 'idle', evidence?: unknown) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Session', project: 'p', state, conversation_ids: ['c'] }],
    conversations: [{ id: 'c', provider: origin === 'observed' ? 'codex' : 'claude', project: 'p', origin, history_format: 'jsonl' }],
    runs: [{ id: 'r', conversation_id: 'c', generation: 1, state, last_evidence: evidence, launch: { cwd: '/repo', model: { model: 'model-a' } } }],
    messages: [{ id: 'old', role: 'assistant', body: 'Earlier response' }],
    message_memberships: [{ id: 'old-link', message_id: 'old', conversation_id: 'c', active: 1 }],
  } });
  target.setConnection('connected');
  let finish!: (value: Ack) => void;
  const command = vi.fn((name: string): Promise<Ack> => name === 'list_models'
    ? Promise.resolve(ack([{ model: 'model-a', displayName: 'Model A' }])) : new Promise(resolve => { finish = resolve; }));
  const client: ConversationClient = { command };
  function Wrapper() { return <MemoryRouter><Workbench project="p" session="root" conversationId="c" client={client} language="ja"
    renderConversation={(id, onConversation) => <ConversationPage target={target} client={client} conversationId={id} onConversation={onConversation} language="ja" embedded/>}/></MemoryRouter>; }
  return { target, command, client, Wrapper, finish: (value: Ack) => finish(value) };
}

it.each([
  ['managed', 'idle', undefined, 'send', { runId: 'r', input: { text: '続けてください' } }],
  ['observed', 'running', undefined, 'fork', { conversationId: 'c', cwd: '/repo', model: { model: 'model-a' }, input: { text: '続けてください' } }],
  ...['ended', 'failed', 'idle'].map<[string, string, unknown, string, unknown]>(state => ['observed', state, { kind: 'process_absent' }, 'adopt', { conversationId: 'c', cwd: '/repo', model: { model: 'model-a' }, input: { text: '続けてください' }, confirmStopped: true }]),
  ['observed', 'ended', { kind: 'host_exit', exit_code: 0 }, 'adopt', { conversationId: 'c', cwd: '/repo', model: { model: 'model-a' }, input: { text: '続けてください' }, confirmStopped: true }],
  ['observed', 'idle', { kind: 'turn_completed' }, 'fork', { conversationId: 'c', cwd: '/repo', model: { model: 'model-a' }, input: { text: '続けてください' } }],
])('sends %s/%s with its evidence and displays the input before acknowledgement', async (origin, state, evidence, name, payload) => {
  const f = fixture(String(origin), String(state), evidence);
  render(<f.Wrapper/>);
  await screen.findByRole('option', { name: 'Model A' });
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: '続けてください' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  expect(f.command).toHaveBeenCalledWith(name, payload);
  const messages = document.querySelectorAll('.message');
  expect(messages[messages.length - 1].textContent).toContain('続けてください');
  expect(screen.queryByRole('dialog')).toBeNull();
  const conversationId = name === 'fork' ? 'next' : 'c';
  await act(async () => f.finish(ack({ conversationId, runId: 'next-run' })));
  expect(screen.getByRole('textbox', { name: '入力' })).toHaveProperty('value', '');
  if (name === 'fork') {
    const tree = restoreWorkspace(localStorage.getItem(workspaceKey('p', 'root')), 'c')!;
    expect(listPanes(tree)[0].tabs).toEqual([{ id: 'initial-tab', kind: 'conversation', conversationId: 'next' }]);
    fireEvent.click(screen.getByRole('button', { name: 'ブラウザで続きを始めました。元の会話はそのまま残ります。' }));
    expect(screen.queryByText('ブラウザで続きを始めました。元の会話はそのまま残ります。')).toBeNull();
  }
  if (name !== 'send') {
    fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: '次の発言' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(f.command).toHaveBeenLastCalledWith('send', { runId: 'next-run', input: { text: '次の発言' } });
    await act(async () => f.finish(ack()));
  }
});

it.each(['send', 'fork', 'adopt'])('shows a %s failure and preserves input for retry', async name => {
  const f = fixture(name === 'send' ? 'managed' : 'observed', name === 'adopt' ? 'ended' : 'running', name === 'adopt' ? { kind: 'session_end' } : undefined);
  render(<f.Wrapper/>);
  await screen.findByRole('option', { name: 'Model A' });
  const input = screen.getByRole('textbox', { name: '入力' });
  fireEvent.change(input, { target: { value: '再試行する発言' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await act(async () => f.finish({ type: 'ack', cmd_id: 'cmd', ok: false, error: 'Runner unavailable' }));
  expect(screen.getByRole('alert').textContent).toBe('Runner unavailable');
  expect(input).toHaveProperty('value', '再試行する発言');
  expect(document.querySelector('.message-user')).toBeNull();
});

it('replaces optimistic input with the recorded message without duplicating it', async () => {
  const f = fixture(); render(<f.Wrapper/>);
  await screen.findByRole('option', { name: 'Model A' });
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: 'Recorded input' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await act(async () => {
    f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
      messages: { upsert: [{ id: 'recorded', role: 'user', body: 'Recorded input' }], remove: [] },
      message_memberships: { upsert: [{ id: 'recorded-link', message_id: 'recorded', conversation_id: 'c', active: 1 }], remove: [] },
    } });
    f.finish(ack());
  });
  expect(screen.getAllByText('Recorded input')).toHaveLength(1);
});

it.each(['claude', 'codex'])('starts a %s session from the project menu and uses send for its next message', async provider => {
  const f = fixture();
  let launched = false;
  f.command.mockImplementation(async (name: string) => {
    if (name === 'list_models') return ack([{ model: 'model-a', displayName: 'Model A' }]);
    if (name === 'session.launch') { launched = true; return ack({ terminalId: 'terminal', pid: 123 }); }
    if (name === 'session.hosts') return ack({ hosts: launched ? [{ terminalId: 'terminal', conversationId: 'started' }] : [] });
    return name === 'start' ? ack({ conversationId: 'started', runId: 'started-run' }) : ack([]);
  });
  render(<MemoryRouter initialEntries={['/p/p']}><App target={f.target} client={f.client}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'New task: Project' }));
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['New session', 'New task']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'New session' }));
  const tabs = screen.getAllByRole('tab');
  expect(tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')[0].textContent).toBe('New session');
  const providerSelect = screen.getByRole('combobox', { name: 'Provider' });
  expect(providerSelect).toHaveProperty('value', 'claude');
  fireEvent.change(providerSelect, { target: { value: provider } });
  await screen.findByRole('option', { name: 'Model A' });
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'First message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await vi.waitFor(() => expect(f.command).toHaveBeenCalledWith(provider === 'claude' ? 'session.launch' : 'start', provider === 'claude' ? { projectId: 'p', provider: 'claude', model: 'model-a' } : { provider, cwd: '/repo', model: { model: 'model-a' }, input: { text: 'First message' } }));
  await vi.waitFor(() => {
    const saved = restoreWorkspace(localStorage.getItem(workspaceKey('p', 'root')), 'c')!;
    expect(listPanes(saved)[0].tabs).toHaveLength(2);
    expect(listPanes(saved)[0].tabs.at(-1)).toMatchObject({ kind: 'conversation', conversationId: 'started' });
  });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Second message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await vi.waitFor(() => expect(f.command).toHaveBeenCalledWith(provider === 'claude' ? 'session.send' : 'send', provider === 'claude' ? { conversationId: 'started', text: 'Second message' } : { runId: 'started-run', input: { text: 'Second message' } }));
});

it('renames tabs, cancels with Escape, restores names and order, and clears custom names', () => {
  const f = fixture(); const view = render(<f.Wrapper/>);
  fireEvent.doubleClick(screen.getByRole('tab', { name: '会話' }));
  let input = screen.getByRole('textbox', { name: 'タブの名前' });
  fireEvent.change(input, { target: { value: '作業の相談' } }); fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.contextMenu(screen.getByRole('tab', { name: '作業の相談' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '名前を変える' }));
  input = screen.getByRole('textbox', { name: 'タブの名前' });
  fireEvent.change(input, { target: { value: '取り消す名前' } }); fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('tab', { name: '作業の相談' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'タブを開く' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '会話' }));
  const saved = localStorage.getItem(workspaceKey('p', 'root'));
  view.unmount(); render(<f.Wrapper/>);
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['作業の相談', '会話']);
  expect(localStorage.getItem(workspaceKey('p', 'root'))).toBe(saved);
  fireEvent.doubleClick(screen.getByRole('tab', { name: '作業の相談' }));
  input = screen.getByRole('textbox', { name: 'タブの名前' });
  fireEvent.change(input, { target: { value: '   ' } }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getAllByRole('tab', { name: '会話' })).toHaveLength(2);
});

it('opens exactly one empty tab for a project without sessions and keeps it when its root arrives', async () => {
  const f = fixture();
  f.target.setSnapshot({ seq: 1, generation: 0, projection: { projects: f.target.getSnapshot().projection.projects } });
  f.command.mockImplementation(async (name: string) => name === 'list_models' ? ack([{ model: 'model-a', displayName: 'Model A' }]) : name === 'start' ? ack({ conversationId: 'started', runId: 'started-run' }) : ack([]));
  render(<MemoryRouter initialEntries={['/p/p?session=draft']}><App target={f.target} client={f.client}/></MemoryRouter>);
  expect(document.querySelectorAll('.workbench [role=tab]')).toHaveLength(1);
  fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: 'codex' } });
  await screen.findByRole('option', { name: 'Model A' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Begin' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  act(() => f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    roots: { upsert: [{ id: 'new-root', project: 'p', conversation_ids: ['started'], state: 'idle' }], remove: [] },
    conversations: { upsert: [{ id: 'started', project: 'p', provider: 'claude', origin: 'managed' }], remove: [] },
    runs: { upsert: [{ id: 'started-run', conversation_id: 'started', generation: 1, state: 'idle', launch: { cwd: '/repo', model: { model: 'model-a' } } }], remove: [] },
  } }));
  expect(document.querySelectorAll('.workbench [role=tab]')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Continue' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(f.command).toHaveBeenCalledWith('send', { runId: 'started-run', input: { text: 'Continue' } });
});

it('keeps the first input and shows the reason when starting fails', async () => {
  const f = fixture();
  f.command.mockImplementation(async (name: string) => name === 'list_models' ? ack([{ model: 'model-a', displayName: 'Model A' }]) : name === 'session.launch' ? { type: 'ack', cmd_id: 'cmd', ok: false, error: 'Host unavailable' } : ack([]));
  render(<MemoryRouter initialEntries={['/p/p?session=draft']}><App target={f.target} client={f.client}/></MemoryRouter>);
  await screen.findByRole('option', { name: 'Model A' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First input' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(screen.getByRole('alert').textContent).toBe('Host unavailable');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'First input');
  expect(screen.getByRole('tab', { name: 'New session' })).toBeTruthy();
});

it('keeps the conversation and run reachable when API identities change after launch', async () => {
  const f = fixture('observed', 'running'); render(<f.Wrapper/>);
  await screen.findByRole('option', { name: 'Model A' });
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: 'Continue with context' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await act(async () => f.finish(ack({ conversationId: 'runner-id', runId: 'runner-run' })));
  act(() => f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0,
    identities: { conversations: { 'runner-id': 'claude:native' }, runs: { 'runner-run': 'claude:native:1' } }, changes: {
      conversations: { upsert: [{ id: 'claude:native', provider: 'claude', origin: 'managed', history_format: 'jsonl' }], remove: [] },
      runs: { upsert: [{ id: 'claude:native:1', conversation_id: 'claude:native', state: 'idle', generation: 1, launch: { cwd: '/repo', model: { model: 'model-a' } } }], remove: [] },
    } }));
  expect(screen.getByText('Continue with context')).toBeTruthy();
  const saved = restoreWorkspace(localStorage.getItem(workspaceKey('p', 'root')), 'c')!;
  expect(listPanes(saved)[0].tabs[0]).toMatchObject({ conversationId: 'claude:native' });
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: 'Next message' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  expect(f.command).toHaveBeenLastCalledWith('send', { runId: 'claude:native:1', input: { text: 'Next message' } });
  await act(async () => f.finish(ack()));
});
