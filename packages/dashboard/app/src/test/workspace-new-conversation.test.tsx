import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { SessionCreate } from '../components/SessionCreate.tsx';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { createStore } from '../lib/store.ts';
import { listPanes, workspaceKey, type PaneTree } from '../lib/panes.ts';
import type { Ack } from '../lib/client.ts';

vi.mock('../pages/workspace/CodeTab.tsx', () => ({ CodeTab: () => <textarea aria-label="Code"/> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  open() {} loadAddon() {} onData() { return { dispose() {} }; } dispose() {} write() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const newId = '["claude","new-conversation"]';
function deferAck() {
  let resolve!: (ack: Ack) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Ack>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
const host = { terminalId: 'terminal', conversationId: newId, provider: 'claude', cwd: '/repo', projectId: 'p' };
const hostsAck: Ack = { type: 'ack', cmd_id: 'cmd', ok: true, result: { hosts: [host] } };
const projects = [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }];
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 1, projection: {}, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])('shows the new + conversation before its root and merges without losing drafts or tabs (paginated: %s)', async paginated => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects,
    roots: [{ id: 'old-root', name: 'Previous root', project: 'p', state: 'idle', conversation_ids: ['old'] }],
    conversations: [{ id: 'old', provider: 'claude', origin: 'managed', project: 'p' }],
    messages: [{ id: 'old-message', role: 'assistant', body: 'Previous history' }],
    message_memberships: [{ id: 'old-link', message_id: 'old-message', conversation_id: 'old', active: 1 }],
  }, pages: paginated ? { roots: { total: 2, next: 'next-root' } } : undefined });
  target.setConnection('connected');
  const discovery = deferAck(), pageHosts = deferAck();
  let launched = false, discovered = false;
  const command = vi.fn(async (name: string): Promise<Ack> => {
    if (name === 'session.launch') launched = true;
    if (name === 'session.hosts') {
      if (!launched) return { ...hostsAck, result: { hosts: [] } };
      if (!discovered) { discovered = true; return discovery.promise; }
      return pageHosts.promise;
    }
    return { type: 'ack', cmd_id: 'cmd', ok: true,
    result: name === 'session.launch' || name === 'terminal.open' ? { terminalId: 'terminal' }
      : name === 'list_models' ? [{ model: 'opus', displayName: 'Opus' }]
      : name === 'settings.read' ? { config: {} } : {},
  }; });
  const client = { command, subscribeTerminal: () => () => {} };
  function Page() {
    const [creating, setCreating] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();
    return <><button aria-label="Create session" onClick={() => setCreating(true)}>+</button>
      <output data-testid="url">{location.search}</output>
      {creating && <SessionCreate client={client} projects={projects} onClose={() => setCreating(false)} onCreated={(project, conversation, host) => {
        setCreating(false); navigate(`/p/${project}?conversation=${encodeURIComponent(conversation)}`, { state: { sessionHost: host } });
      }}/>}
      <WorkspacePage project="p" target={target} client={client} panelVisible={false}/></>;
  }
  render(<MemoryRouter initialEntries={['/p/p?root=old-root']}><Page/></MemoryRouter>);
  expect(await screen.findByText('Previous history')).toBeTruthy();
  const workbench = screen.getByLabelText('Workbench');
  const previousWorkspace = localStorage.getItem(workspaceKey('p', 'old-root'));
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
  fireEvent.click(screen.getByRole('button', { name: /^Create ⌘/ }));
  await vi.waitFor(() => expect(discovered).toBe(true));
  await act(async () => discovery.resolve(hostsAck));
  await vi.waitFor(() => expect(screen.getByTestId('url').textContent).toBe(`?conversation=${encodeURIComponent(newId)}`));
  expect(screen.queryByText('Previous history')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Previous root' })).toBeNull();
  expect(screen.queryByText('Conversation not found')).toBeNull();
  expect(screen.getByLabelText('Workbench')).toBe(workbench);
  const message = screen.getByRole('textbox', { name: 'Message' });
  await act(async () => pageHosts.resolve(hostsAck));
  expect(screen.queryByText('Conversation not found')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message);
  fireEvent.change(message, { target: { value: 'Unsent new message' } });
  const tabId = screen.getByRole('tab', { name: 'Conversation' }).id;
  const saved: PaneTree = { kind: 'split', id: 'saved-split', direction: 'horizontal', ratio: 0.7,
    first: { kind: 'pane', id: 'saved-conversation-pane', tabs: [{ kind: 'conversation', id: 'saved-conversation', conversationId: newId }], active: 'saved-conversation' },
    second: { kind: 'pane', id: 'saved-file-pane', tabs: [{ kind: 'code', id: 'saved-readme', path: 'README.md' }], active: 'saved-readme' },
  };
  localStorage.setItem(workspaceKey('p', 'new-root'), JSON.stringify(saved));
  fireEvent.click(screen.getByRole('button', { name: 'Open tab' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await vi.waitFor(() => expect(command).toHaveBeenCalledWith('terminal.open', expect.anything()));
  const terminalSurface = screen.getByRole('tabpanel', { name: 'Terminal' }).querySelector('.terminal-surface');
  expect(terminalSurface).not.toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
  act(() => target.mergeProjection({
    conversations: [{ id: newId, provider: 'claude', name: 'New conversation', origin: 'observed', project: 'p' }],
    messages: [{ id: 'new-message', role: 'assistant', body: 'New history' }],
    message_memberships: [{ id: 'new-link', message_id: 'new-message', conversation_id: newId, active: 1 }],
  }, 1));
  const history = await screen.findByText('New history');
  expect(screen.queryByText('Previous history')).toBeNull();
  expect(screen.getByRole('tab', { name: 'New conversation' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message);
  expect(localStorage.getItem(workspaceKey('p', 'new-root'))).toBe(JSON.stringify(saved));
  act(() => target.mergeProjection({
    roots: [{ id: 'new-root', name: 'New root', user_name: 'New root', project: 'p', state: 'idle', conversation_ids: [newId] }],
  }, 1, undefined, { roots: { total: 2, next: null } }));
  expect(screen.getByRole('tab', { name: 'New root', selected: true })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message);
  expect(message).toHaveProperty('value', 'Unsent new message');
  expect(within(screen.getByRole('tabpanel', { name: 'New root' })).getByText('New history')).toBe(history);
  expect(screen.getByRole('button', { name: 'Conversation menu' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'README.md' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'New root' }).id).toBe(tabId);
  fireEvent.click(screen.getByRole('tab', { name: 'Terminal' }));
  expect(screen.getByRole('tabpanel', { name: 'Terminal' }).querySelector('.terminal-surface')).toBe(terminalSurface);
  expect(command.mock.calls.filter(([name]) => name === 'terminal.open')).toHaveLength(1);
  expect(command.mock.calls.filter(([name]) => name === 'terminal.close')).toHaveLength(0);
  expect(localStorage.getItem(workspaceKey('p', newId))).toBeNull();
  expect(listPanes(JSON.parse(localStorage.getItem(workspaceKey('p', 'new-root'))!)).flatMap(pane => pane.tabs)).toHaveLength(3);
  expect(localStorage.getItem(workspaceKey('p', 'old-root'))).toBe(previousWorkspace);
  fireEvent.click(screen.getByRole('link', { name: 'Previous root' }));
  expect(await screen.findByText('Previous history')).toBeTruthy();
  expect(screen.getByTestId('url').textContent).toBe('?root=old-root');
});

it.each([[newId, true, 'ok'], [newId, false, 'ok'], ['missing-conversation', false, 'ok'],
  ['missing-conversation', false, 'ok:false'], ['missing-conversation', false, 'reject']] as const)('waits for the first host response before deciding whether a URL conversation exists (%s, exists: %s, response: %s)', async (conversationId, exists, response) => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { projects, conversations: [], roots: [] } });
  target.setConnection('connected');
  const pending = deferAck();
  const command = vi.fn(async (name: string): Promise<Ack> => name === 'session.hosts' ? pending.promise
    : { type: 'ack', cmd_id: 'cmd', ok: true, result: {} });
  render(<MemoryRouter initialEntries={[`/p/p?conversation=${encodeURIComponent(conversationId)}`]}><WorkspacePage project="p" target={target} client={{ command }} panelVisible={false}/></MemoryRouter>);
  await vi.waitFor(() => expect(command).toHaveBeenCalledWith('session.hosts', {}));
  expect(screen.queryByText('Conversation not found')).toBeNull();
  expect(screen.getByText('Loading…').getAttribute('role')).toBe('status');
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  await act(async () => {
    if (response === 'reject') pending.reject(new Error('Host refresh failed'));
    else pending.resolve({ ...hostsAck, ok: response !== 'ok:false', result: { hosts: exists ? [host] : [] } });
  });
  expect(screen.queryByText('Loading…')).toBeNull();
  if (exists) {
    expect(screen.queryByText('Conversation not found')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  } else {
    expect(screen.getByText('Conversation not found')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  }
});
