import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
function fixture(origin = 'managed', state = 'idle', evidence?: unknown, provider = origin === 'observed' ? 'codex' : 'claude') {
  const conversationId = origin === 'observed' && provider !== 'antigravity' ? JSON.stringify([provider, 'native-id']) : 'c';
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Session', project: 'p', state, conversation_ids: [conversationId] }],
    conversations: [{ id: conversationId, provider, project: 'p', origin, history_format: 'jsonl' }],
    runs: [{ id: 'r', conversation_id: conversationId, generation: 1, state, last_evidence: evidence, launch: { cwd: '/repo', model: { model: 'model-a' } } }],
    messages: [{ id: 'old', role: 'assistant', body: 'Earlier response' }],
    message_memberships: [{ id: 'old-link', message_id: 'old', conversation_id: conversationId, active: 1 }],
  } });
  target.setConnection('connected');
  let finish!: (value: Ack) => void;
  const command = vi.fn((name: string): Promise<Ack> => name === 'list_models'
    ? Promise.resolve(ack([{ model: 'model-a', displayName: 'Model A' }])) : name === 'session.hosts' ? Promise.resolve(ack({ hosts: [] })) : name === 'session.launch' ? Promise.resolve(ack({ terminalId: 'terminal' })) : new Promise(resolve => { finish = resolve; }));
  const client: ConversationClient = { command };
  function Wrapper() { return <MemoryRouter><Workbench project="p" session="root" conversationId={conversationId} client={client} language="ja"
    renderConversation={(id, onConversation) => <ConversationPage target={target} client={client} conversationId={id} onConversation={onConversation} language="ja" embedded/>}/></MemoryRouter>; }
  return { target, command, client, Wrapper, finish: (value: Ack) => finish(value) };
}

it.each([
  ['managed', 'idle', undefined],
  ['observed', 'running', undefined],
  ...['ended', 'failed', 'idle'].map<[string, string, unknown]>(state => ['observed', state, { kind: 'process_absent' }]),
  ['observed', 'ended', { kind: 'host_exit', exit_code: 0 }],
  ['observed', 'idle', { kind: 'turn_completed' }],
])('sends %s/%s with its evidence and displays the input before acknowledgement', async (origin, state, evidence) => {
  const f = fixture(String(origin), String(state), evidence);
  render(<f.Wrapper/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: '続けてください' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  const observed = origin === 'observed';
  const conversationId = observed ? '["codex","native-id"]' : 'c';
  await waitFor(() => expect(f.command).toHaveBeenCalledWith(observed ? 'session.send' : 'send', observed ? { conversationId, text: '続けてください' } : { runId: 'r', input: { text: '続けてください' } }));
  if (observed) expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider: 'codex', resume: 'native-id', model: 'model-a' });
  const messages = document.querySelectorAll('.message');
  expect(messages[messages.length - 1].textContent).toContain('続けてください');
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => f.finish(ack()));
  expect(screen.getByRole('textbox', { name: '入力' })).toHaveProperty('value', '');
  if (observed) {
    fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: '次の発言' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(f.command).toHaveBeenLastCalledWith('session.send', { conversationId, text: '次の発言' }));
    expect(f.command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(1);
    expect(f.command.mock.calls.some(([name]) => ['fork', 'adopt'].includes(name))).toBe(false);
    await act(async () => f.finish(ack()));
  }
});

it.each(['send', 'session.send', 'session.launch'])('shows a %s failure and preserves input for retry', async name => {
  const f = fixture(name === 'send' ? 'managed' : 'observed', name === 'session.launch' ? 'ended' : 'running', name === 'session.launch' ? { kind: 'session_end' } : undefined);
  if (name === 'session.launch') f.command.mockImplementation(async command => command === 'list_models' ? ack([{ model: 'model-a', displayName: 'Model A' }]) : command === 'session.hosts' ? ack({ hosts: [] }) : { type: 'ack', cmd_id: 'cmd', ok: false, error: 'Runner unavailable' });
  render(<f.Wrapper/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  const input = screen.getByRole('textbox', { name: '入力' });
  fireEvent.change(input, { target: { value: '再試行する発言' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  if (name !== 'session.launch') {
    await waitFor(() => expect(f.command.mock.calls.some(([command]) => command === name)).toBe(true));
    await act(async () => f.finish({ type: 'ack', cmd_id: 'cmd', ok: false, error: 'Runner unavailable' }));
  }
  expect((await screen.findByRole('alert')).textContent).toBe('Runner unavailable');
  expect(input).toHaveProperty('value', '再試行する発言');
  expect(document.querySelector('.message-user')).toBeNull();
});

it('replaces optimistic input with the recorded message without duplicating it', async () => {
  const f = fixture(); render(<f.Wrapper/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
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

it.each(['claude', 'codex'])('creates a %s session from the project plus, opens its tab and sends through the terminal', async provider => {
  const f = fixture();
  const conversationId = JSON.stringify([provider, '12345678-1234-1234-1234-123456789abc']);
  let launched = false;
  f.command.mockImplementation(async (name: string) => {
    if (name === 'settings.models') return ack({ defaults: { model: 'model-a', displayName: 'Model A', effort: 'high', modelSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model' }, effortSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model_reasoning_effort' } } });
    if (name === 'list_models') return ack([{ model: 'model-a', displayName: 'Model A' }]);
    if (name === 'ssh.read') return ack({ connections: [] });
    if (name === 'git.branches') return ack({ branches: ['main', 'origin/main'] });
    if (name === 'session.launch') { launched = true; return ack({ terminalId: 'terminal', pid: 123 }); }
    if (name === 'session.hosts') return ack({ hosts: launched ? [{ terminalId: 'terminal', conversationId, provider, projectId: 'p', cwd: '/repo' }] : [] });
    return ack();
  });
  render(<MemoryRouter initialEntries={['/p/p']}><App target={f.target} client={f.client}/></MemoryRouter>);
  localStorage.setItem('agent-graph-session-provider', provider);
  fireEvent.click(screen.getByRole('button', { name: 'Start conversation: Project' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await vi.waitFor(() => expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider, target: { kind: 'local' } }));
  await vi.waitFor(() => {
    const raw = localStorage.getItem(workspaceKey('p', conversationId));
    expect(raw).not.toBeNull();
    const saved = restoreWorkspace(raw, conversationId)!;
    expect(listPanes(saved)[0].tabs).toHaveLength(1);
    expect(listPanes(saved)[0].tabs.at(-1)).toMatchObject({ kind: 'conversation', conversationId });
    expect(listPanes(saved)[0].active).toBe(listPanes(saved)[0].tabs.at(-1)!.id);
  });
  const previous = restoreWorkspace(localStorage.getItem(workspaceKey('p', 'root')), 'c')!;
  expect(listPanes(previous)[0].tabs).toHaveLength(1);
  expect(listPanes(previous)[0].tabs[0]).toMatchObject({ kind: 'conversation', conversationId: 'c' });
  expect(screen.queryByText('Earlier response')).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await vi.waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: 'First message' }));
  expect(f.command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(1);
});

it('renames tabs, cancels with Escape, restores names and order, and clears custom names', () => {
  const f = fixture();
  localStorage.setItem(workspaceKey('p', 'root'), JSON.stringify({ kind: 'pane', id: 'pane', tabs: [{ kind: 'conversation', id: 'first', conversationId: 'c' }, { kind: 'conversation', id: 'second', conversationId: 'other', name: 'Other session' }], active: 'first' }));
  const view = render(<f.Wrapper/>);
  fireEvent.doubleClick(screen.getByRole('tab', { name: 'Session' }));
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
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['作業の相談', 'Other session']);
  expect(localStorage.getItem(workspaceKey('p', 'root'))).toBe(saved);
  fireEvent.doubleClick(screen.getByRole('tab', { name: '作業の相談' }));
  input = screen.getByRole('textbox', { name: 'タブの名前' });
  fireEvent.change(input, { target: { value: '   ' } }); fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getAllByRole('tab', { name: 'Session' })).toHaveLength(1);
  expect(screen.getByRole('tab', { name: 'Other session' })).toBeTruthy();
});

it('opens exactly one empty tab for a project without sessions and keeps it when its root arrives', async () => {
  const f = fixture();
  f.target.setSnapshot({ seq: 1, generation: 0, projection: { projects: f.target.getSnapshot().projection.projects } });
  const conversationId = '["codex","started"]';
  let launched = false;
  f.command.mockImplementation(async (name: string) => {
    if (name === 'settings.models') return ack({ defaults: { model: 'model-a', displayName: 'Model A', effort: 'high', modelSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model' }, effortSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model_reasoning_effort' } } });
    if (name === 'list_models') return ack([{ model: 'model-a', displayName: 'Model A' }]);
    if (name === 'session.launch') { launched = true; return ack({ terminalId: 'started-terminal' }); }
    if (name === 'session.hosts') return ack({ hosts: launched ? [{ terminalId: 'started-terminal', conversationId, provider: 'codex', projectId: 'p', cwd: '/repo' }] : [] });
    return ack([]);
  });
  render(<MemoryRouter initialEntries={['/p/p?session=draft']}><App target={f.target} client={f.client}/></MemoryRouter>);
  expect(document.querySelectorAll('.workbench [role=tab]')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Begin' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: 'Begin' }));
  act(() => f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    roots: { upsert: [{ id: 'new-root', project: 'p', conversation_ids: [conversationId], state: 'idle' }], remove: [] },
    conversations: { upsert: [{ id: conversationId, project: 'p', provider: 'codex', origin: 'observed' }], remove: [] },
    runs: { upsert: [{ id: 'started-run', conversation_id: conversationId, generation: 1, state: 'idle', launch: { cwd: '/repo', model: { model: 'model-a' } } }], remove: [] },
  } }));
  expect(document.querySelectorAll('.workbench [role=tab]')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Continue' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: 'Continue' });
  expect(f.command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(1);
});

it('keeps the first input and shows the reason when starting fails', async () => {
  const f = fixture();
  f.command.mockImplementation(async (name: string) => name === 'settings.models' ? ack({ defaults: { model: 'model-a', displayName: 'Model A', effort: 'high', modelSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model' }, effortSource: { kind: 'file', path: '/repo/.codex/config.toml', key: 'model_reasoning_effort' } } }) : name === 'list_models' ? ack([{ model: 'model-a', displayName: 'Model A' }]) : name === 'session.launch' ? { type: 'ack', cmd_id: 'cmd', ok: false, error: 'Host unavailable' } : ack([]));
  render(<MemoryRouter initialEntries={['/p/p?session=draft']}><App target={f.target} client={f.client}/></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First input' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
  expect(screen.getByRole('alert').textContent).toBe('Host unavailable');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'First input');
  expect(screen.getByRole('tab', { name: 'New session' })).toBeTruthy();
});

it.each(['explicit', 'derived'])('keeps the conversation and run reachable with %s API identities after launch', async identity => {
  const f = fixture('observed', 'running', undefined, 'antigravity'); render(<f.Wrapper/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: 'Continue with context' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await act(async () => f.finish(ack({ conversationId: 'runner-id', runId: identity === 'explicit' ? 'runner-run' : 'runner-id:1' })));
  act(() => f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0,
    identities: { conversations: { 'runner-id': 'claude:native' }, runs: identity === 'explicit' ? { 'runner-run': 'claude:native:1' } : {} }, changes: {
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

it.each(['claude', 'codex'])('resumes observed %s using the ID provider before its provider row arrives', async provider => {
  const f = fixture('observed', 'idle', undefined, provider);
  const state = f.target.getSnapshot();
  f.target.setSnapshot({ seq: 2, generation: 0, projection: { ...state.projection, conversations: state.projection.conversations!.map(({ provider: _, ...row }) => row) } });
  render(<f.Wrapper/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: 'Resume from ID' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider, resume: 'native-id', model: 'model-a' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId: JSON.stringify([provider, 'native-id']), text: 'Resume from ID' }));
  expect(f.command.mock.calls.some(([name]) => ['fork', 'adopt'].includes(name))).toBe(false);
  await act(async () => f.finish(ack()));
});

it.each(['claude', 'codex'])('sends observed %s to an existing terminal host without relaunching', async provider => {
  const f = fixture('observed', 'running', undefined, provider);
  const conversationId = JSON.stringify([provider, 'native-id']);
  f.command.mockImplementation(async name => name === 'list_models' ? ack([{ model: 'model-a', displayName: 'Model A' }]) : name === 'session.hosts' ? ack({ hosts: [{ terminalId: 'existing', conversationId, provider, projectId: 'p', cwd: '/repo' }] }) : ack());
  render(<f.Wrapper/>);
  await waitFor(() => expect(screen.getByRole('button', { name: /^(Model|モデル) · / }).textContent).toContain('Model A'));
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: 'Existing host' } });
  fireEvent.click(screen.getByRole('button', { name: '送信' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: 'Existing host' }));
  expect(f.command.mock.calls.some(([name]) => ['session.launch', 'fork', 'adopt'].includes(name))).toBe(false);
});

it('restores a failed bubble after reload and resends its text through the existing send route', async () => {
  const f = fixture('observed', 'idle', { kind: 'turn_completed' }, 'claude');
  const conversationId = '["claude","native-id"]';
  f.target.setSendWatches([{ id: 'delivery', conversation_id: conversationId, body: 'Missing message', attachments: [], state: 'failed', sent_ts: '2026-10-13T10:00:00Z' }]);
  render(<f.Wrapper/>);
  expect(await screen.findByText('未配達')).toBeTruthy();
  expect(screen.getByText('Missing message')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '再送' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: 'Missing message', attachments: [], retryOf: 'delivery' }));
  await act(async () => f.finish(ack()));
});

it('removes the failed bubble and retry action when the watch closes or expires', async () => {
  const f = fixture('observed', 'idle', { kind: 'turn_completed' }, 'claude');
  f.target.setSendWatches([{ id: 'delivery', conversation_id: '["claude","native-id"]', body: 'Late message', attachments: [], state: 'failed' }]);
  render(<f.Wrapper/>);
  expect(await screen.findByText('未配達')).toBeTruthy();
  act(() => f.target.setSendWatches([]));
  expect(screen.queryByText('未配達')).toBeNull();
  expect(screen.queryByRole('button', { name: '再送' })).toBeNull();
});
