import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage, type ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { createStore } from '../lib/store.ts';
import type { Ack, TerminalNotice } from '../lib/client.ts';
import { Markdown } from '../components/conversation/Markdown.tsx';
import { readFileSync } from 'node:fs';

const SESSION = '12345678-1234-1234-1234-123456789abc';
const conversationId = JSON.stringify(['claude', SESSION]);
const terminalInput = vi.hoisted(() => ({ send: undefined as ((data: string) => void) | undefined }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; element?: HTMLPreElement;
  open(host: HTMLElement) { this.element = document.createElement('pre'); host.append(this.element); }
  loadAddon() {} onData(listener: (data: string) => void) { terminalInput.send = listener; } dispose() {}
  write(data: string) { this.element!.textContent += data; }
  reset() { this.element!.textContent = ''; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const ack = (result: unknown = {}): Ack => ({ type: 'ack', cmd_id: 'cmd', ok: true, result });
function fixture({ hosted = false, state = 'running', evidence }: { hosted?: boolean; state?: string; evidence?: unknown } = {}) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', root_path: '/repo', state: 'registered' }],
    conversations: [{ id: conversationId, provider: 'claude', origin: 'observed', project: 'p', history_format: 'jsonl' }],
    runs: [{ id: 'r', conversation_id: conversationId, state, last_evidence: evidence, launch: { cwd: '/repo', model: { model: 'opus' } } }],
  } });
  target.setConnection('connected');
  const subscribers = new Set<(notice: TerminalNotice) => void>();
  const connected = new Set<() => void>();
  let launched = hosted;
  let discover = true;
  const command = vi.fn(async (name: string, _payload?: unknown): Promise<Ack> => {
    if (name === 'list_models') return ack([{ model: 'opus', displayName: 'Opus' }]);
    if (name === 'session.launch') { launched = true; return ack({ terminalId: 'terminal', pid: 123 }); }
    if (name === 'session.hosts') return ack({ hosts: launched && discover ? [{ conversationId, terminalId: 'terminal', pid: 123, startedAt: 'now' }] : [] });
    if (name === 'terminal.attach') return ack({ terminalId: 'terminal', scrollback: 'Restored output' });
    return ack();
  });
  const client: ConversationClient = { command, subscribeConnected(listener) { connected.add(listener); return () => { connected.delete(listener); }; }, subscribeTerminal(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; } };
  function Wrapper({ newSession = false }: { newSession?: boolean }) { return <MemoryRouter><Workbench project="p" session="s" conversationId={newSession ? '' : conversationId} newSession={newSession ? 'draft' : undefined} client={client} language="ja"
    renderConversation={(id, onConversation) => <ConversationPage conversationId={id} target={target} client={client} language="ja" embedded onConversation={onConversation} newSession={{ projectId: 'p', cwd: '/repo' }}/>}/></MemoryRouter>; }
  return { target, command, client, Wrapper, reconnect: () => connected.forEach(listener => listener()), setDiscover: (value: boolean) => { discover = value; }, setHosted: (value: boolean) => { launched = value; }, emit: (notice: TerminalNotice) => subscribers.forEach(listener => listener(notice)) };
}
async function send(text = '続けてください') {
  await screen.findByRole('option', { name: 'Opus' });
  fireEvent.change(screen.getByRole('textbox', { name: '入力' }), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送信' })); });
}
it.each([
  { hosted: true, state: 'running', evidence: undefined, warning: false },
  { hosted: false, state: 'idle', evidence: { kind: 'process_absent' }, warning: false },
  { hosted: false, state: 'running', evidence: { kind: 'message' }, warning: true },
  { hosted: false, state: 'idle', evidence: { kind: 'turn_completed' }, warning: true },
])('sends the observed Claude conversation through its terminal: %j', async ({ warning, ...options }) => {
  const f = fixture(options); render(<f.Wrapper/>);
  await vi.waitFor(() => expect((screen.getByRole('button', { name: 'ターミナル' }) as HTMLButtonElement).disabled).toBe(!options.hosted));
  expect(Boolean(screen.queryByText('この会話は別の場所で動いています。ここで送ると、別の続きになります。'))).toBe(warning);
  await send();
  expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: '続けてください' });
  const launches = f.command.mock.calls.filter(([name]) => name === 'session.launch');
  expect(launches).toHaveLength(options.hosted ? 0 : 1);
  if (!options.hosted) expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider: 'claude', resume: SESSION, model: 'opus' });
  expect(f.command.mock.calls.some(([name]) => ['send', 'adopt', 'fork'].includes(name))).toBe(false);
  expect(screen.getByRole('textbox', { name: '入力' })).toHaveProperty('value', '');
  await send('次の発言');
  expect(f.command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(options.hosted ? 0 : 1);
});
it('interrupts and opens the hosted terminal in a neighboring pane, restores output and keeps it on tab close', async () => {
  const f = fixture({ hosted: true }); const view = render(<f.Wrapper/>);
  await vi.waitFor(() => expect((screen.getByRole('button', { name: 'ターミナル' }) as HTMLButtonElement).disabled).toBe(false));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '中断' })); });
  expect(f.command).toHaveBeenCalledWith('session.interrupt', { conversationId });
  fireEvent.click(screen.getByRole('button', { name: 'ターミナル' }));
  await screen.findByText('Restored output');
  expect(document.querySelectorAll('[data-pane-id]')).toHaveLength(2);
  expect(f.command).toHaveBeenCalledWith('terminal.attach', { terminalId: 'terminal' });
  act(() => { f.emit({ type: 'terminal', event: 'output', terminalId: 'terminal', data: ' Live output' }); });
  expect(screen.getByText('Restored output Live output')).toBeTruthy();
  act(() => { terminalInput.send?.('y'); });
  expect(f.command).toHaveBeenCalledWith('terminal.input', { terminalId: 'terminal', data: 'y' });
  await act(async () => { f.reconnect(); });
  expect(f.command.mock.calls.filter(([name]) => name === 'terminal.attach')).toHaveLength(2);
  expect(screen.getByText('Restored output')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '閉じる ターミナル' }));
  view.unmount();
  expect(f.command.mock.calls.some(([name]) => name === 'terminal.close')).toBe(false);
});
it('waits for the new conversation before sending its first message', async () => {
  const f = fixture(); f.setDiscover(false); render(<f.Wrapper newSession/>);
  await send('最初の発言');
  expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider: 'claude', model: 'opus' });
  expect(f.command.mock.calls.some(([name]) => name === 'session.send')).toBe(false);
  expect(screen.getByRole('textbox', { name: '入力' })).toHaveProperty('value', '最初の発言');
  fireEvent.click(screen.getByRole('button', { name: 'ターミナル' }));
  await screen.findByText('Restored output');
  expect(f.command).toHaveBeenCalledWith('terminal.attach', { terminalId: 'terminal' });
  f.setDiscover(true);
  await vi.waitFor(() => expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: '最初の発言' }));
  await vi.waitFor(() => expect(screen.getByRole('textbox', { name: '入力' })).toHaveProperty('value', ''));
});
it('updates terminal availability every five seconds', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await act(async () => { render(<f.Wrapper/>); });
  f.setHosted(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole('button', { name: 'ターミナル' })).toHaveProperty('disabled', false);
  f.setHosted(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole('button', { name: 'ターミナル' })).toHaveProperty('disabled', true);
});
it('preserves the message when terminal launch fails', async () => {
  const f = fixture();
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(name => name === 'session.launch' ? Promise.resolve({ type: 'ack', cmd_id: 'cmd', ok: false, error: 'Terminal unavailable' }) : original(name));
  render(<f.Wrapper/>); await send();
  expect(screen.getByRole('alert').textContent).toContain('Terminal unavailable');
  expect(screen.getByRole('textbox', { name: '入力' })).toHaveProperty('value', '続けてください');
  expect(document.querySelector('.message-user')).toBeNull();
});
it('can send to a hosted Claude terminal while the runner is unavailable', async () => {
  const f = fixture({ hosted: true });
  f.target.setConnection('runner_unavailable');
  render(<f.Wrapper/>);
  await send('端末への発言');
  expect(f.command).toHaveBeenCalledWith('session.send', { conversationId, text: '端末への発言' });
});
it('reuses a resumed terminal before its session file is discovered', async () => {
  const f = fixture(); f.setDiscover(false); render(<f.Wrapper/>);
  await send('最初');
  await send('次');
  expect(f.command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(1);
  expect(f.command.mock.calls.filter(([name]) => name === 'session.send').map(call => call[1])).toEqual([
    { conversationId, text: '最初' }, { conversationId, text: '次' },
  ]);
});
it('puts task checkboxes beside a separate wrapping text column in both tight and loose lists', () => {
  render(<MemoryRouter><Markdown text={'- [ ] 長い **作業** の文\n  - 入れ子\n\n- [x] 完了\n\n  続きの段落'}/></MemoryRouter>);
  for (const item of document.querySelectorAll('.task-list-item')) {
    expect(item.firstElementChild?.tagName).toBe('INPUT');
    expect(item.children[1].className).toBe('md-task-content');
    expect(item.children[1].textContent!.trim().length).toBeGreaterThan(0);
  }
  const css = readFileSync('app/src/components/conversation/markdown.css', 'utf8');
  expect(css).toContain('grid-template-columns: 16px minmax(0, 1fr)');
  expect(css).toContain('.md-task-content > p:first-child { margin-top: 0; }');
  const documentCss = readFileSync('app/src/components/files/document.css', 'utf8');
  expect(documentCss).toContain("li[data-type='taskItem'] > label { flex: 0 0 auto;");
  expect(documentCss).toContain("li[data-type='taskItem'] > div { flex: 1; min-width: 0; }");
});
