import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MemoryRouter, useNavigate, useLocation } from 'react-router';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { createStore, type Row, type ScreenStore } from '../lib/store.ts';
import { createWorkspace, listPanes, workspaceKey, type PaneTree } from '../lib/panes.ts';
import type { Ack } from '../lib/client.ts';
import { OpenWorkspaceFile, WorkspaceConversationHeader } from '../lib/workspace-context.ts';

vi.mock('../pages/conversation/ConversationPage.tsx', () => ({
  ConversationPage: ({ conversationId, seriesIds, breadcrumb }: { conversationId: string; seriesIds?: string[]; breadcrumb?: ReactNode }) => {
    const openFile = useContext(OpenWorkspaceFile);
    const header = useContext(WorkspaceConversationHeader);
    const [actions, setActions] = useState<HTMLElement | null>(null);
    useLayoutEffect(() => { setActions(document.getElementById(`workspace-actions-${header?.tabId}`)); }, [header?.tabId]);
    return <>{breadcrumb}<div data-testid="open-conversation" data-series={JSON.stringify(seriesIds)}>{conversationId}</div>
      <textarea aria-label="Message"/><button onClick={() => openFile?.('draft.ts')}>Open draft file</button>
      {actions && createPortal(<button>Conversation action</button>, actions)}</>;
  },
}));
vi.mock('../pages/workspace/CodeTab.tsx', () => ({ CodeTab: () => <textarea aria-label="Code"/> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  open() {} loadAddon() {} onData() { return { dispose() {} }; } dispose() {} write() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

const requestedId = '["codex","019debcd-4d23-7391-8ff3-3c786e29370c"]';
const latestId = '["claude","fea1ff97-d236-4423-988d-f0090de135ec"]';
const latestRoot = createRoot('latest-root', [latestId], '2026-10-13T00:00:00Z');
const olderRoot = createRoot('older-root', [requestedId], '2026-10-12T00:00:00Z');
function createRoot(id: string, conversationIds: string[], timestamp: string): Row {
  return { id, project: 'other', name: id, state: 'idle', conversation_ids: conversationIds,
    last_activity_ts: timestamp, running_children: 0, total_children: 0 };
}
function openConversation(target: ScreenStore, query = '') {
  const client = { command: vi.fn(async (): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: true })) };
  return render(<MemoryRouter initialEntries={[`/c/${encodeURIComponent(requestedId)}${query}`]}>
    <WorkspacePage project="other" conversationId={requestedId} target={target} client={client} showRootList={false}/>
  </MemoryRouter>);
}
function saveRootWorkspace(rootId = 'older-root', conversationId = requestedId) {
  const tree: PaneTree = { kind: 'split', id: 'saved-split', direction: 'horizontal', ratio: 0.7,
    first: { kind: 'pane', id: 'saved-conversation-pane', tabs: [{ kind: 'conversation', id: 'saved-conversation', conversationId }], active: 'saved-conversation' },
    second: { kind: 'pane', id: 'saved-file-pane', tabs: [{ kind: 'code', id: 'saved-readme', path: 'README.md' }], active: 'saved-readme' },
  };
  localStorage.setItem(workspaceKey('other', rootId), JSON.stringify(tree));
  return tree;
}
function readSavedTabs(rootId: string) {
  return listPanes(JSON.parse(localStorage.getItem(workspaceKey('other', rootId))!)).flatMap(pane => pane.tabs);
}
function setFirstPage(target: ScreenStore) {
  target.setSnapshot({ seq: 1, generation: 1,
    projection: { roots: [latestRoot], conversations: [{ id: latestId, provider: 'claude' }] },
    pages: { roots: { total: 1001, next: 'roots-page-2' }, conversations: { total: 1001, next: 'conversations-page-2' } },
  });
}
function expectRequestedConversation() {
  expect(readOpenConversation().textContent).toBe(requestedId);
  expect(screen.queryByText('Conversation not found')).toBeNull();
}
function readOpenConversation() {
  return within(screen.getByRole('tabpanel', { name: /^Conversation/ })).getByTestId('open-conversation');
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the URL conversation through the snapshot and delayed root and conversation pages', async () => {
  const target = createStore();
  localStorage.setItem(workspaceKey('other', 'latest-root'), JSON.stringify(createWorkspace(latestId)));
  const saved = saveRootWorkspace();
  openConversation(target, '?root=latest-root');
  expectRequestedConversation();
  const original = readOpenConversation();
  const originalPanel = screen.getByRole('tabpanel', { name: /^Conversation/ });
  const message = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(message, { target: { value: 'Unsent message' } });
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
  act(() => setFirstPage(target));
  expectRequestedConversation();
  expect(readOpenConversation()).toBe(original);
  expect(screen.getByRole('tabpanel', { name: /^Conversation/ })).toBe(originalPanel);
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
  act(() => target.mergeProjection({ conversations: [{ id: requestedId, provider: 'codex' }] }, 1, undefined,
    { roots: { total: 1001, next: 'roots-page-2' }, conversations: { total: 1001, next: null } }));
  expectRequestedConversation();
  expect(readOpenConversation()).toBe(original);
  expect(screen.getByRole('tabpanel', { name: /^Conversation/ })).toBe(originalPanel);
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open draft file' }));
  const code = await screen.findByRole('textbox', { name: 'Code' });
  fireEvent.change(code, { target: { value: 'Unsaved code' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
  expect(JSON.parse(localStorage.getItem(workspaceKey('other', 'older-root'))!)).toEqual(saved);
  act(() => target.mergeProjection({ roots: [olderRoot] }, 1, undefined,
    { roots: { total: 1001, next: null }, conversations: { total: 1001, next: null } }));
  expectRequestedConversation();
  expect(readOpenConversation()).toBe(original);
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message);
  expect(message).toHaveProperty('value', 'Unsent message');
  expect(screen.getByRole('button', { name: 'Conversation action' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'draft.ts' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'README.md' })).toBeTruthy();
  expect(screen.getAllByRole('tab', { name: /^Conversation/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('tab', { name: 'draft.ts' }));
  expect(within(screen.getByRole('tabpanel', { name: 'draft.ts' })).getByRole('textbox', { name: 'Code' })).toBe(code);
  expect(code).toHaveProperty('value', 'Unsaved code');
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
  expect(localStorage.getItem(workspaceKey('other', 'older-root'))).toContain('draft.ts');
  expect(readSavedTabs('older-root')).toHaveLength(3);
  expect(JSON.parse(localStorage.getItem(workspaceKey('other', 'older-root'))!)).toMatchObject({ kind: 'split', direction: 'horizontal', ratio: 0.7 });
});

it('shows Conversation not found only after all pages and the direct lookup confirm absence', async () => {
  let finish: (value: unknown) => void = () => {};
  const response = new Promise(resolve => { finish = resolve; });
  vi.stubGlobal('fetch', vi.fn(() => response));
  const target = createStore(); setFirstPage(target); openConversation(target);
  expectRequestedConversation();
  act(() => target.mergeProjection({}, 1, undefined,
    { roots: { total: 1001, next: null }, conversations: { total: 1001, next: 'conversations-page-2' } }));
  expectRequestedConversation();
  act(() => target.mergeProjection({}, 1, undefined,
    { roots: { total: 1001, next: null }, conversations: { total: 1001, next: null } }));
  expectRequestedConversation();
  expect(screen.queryByText('Conversation not found')).toBeNull();
  await act(async () => { finish({ ok: true, json: async () => ({ generation: 1, projection: { conversations: [], messages: [] }, next: null }) }); });
  expect(screen.getByRole('status').textContent).toBe('Conversation not found');
  expect(screen.queryByTestId('open-conversation')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Conversation' })).toBeNull();
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
});

it('keeps a child conversation open when its delegated relation arrives after the root', () => {
  const target = createStore(); setFirstPage(target); openConversation(target);
  expectRequestedConversation();
  const original = readOpenConversation();
  act(() => target.mergeProjection({ conversations: [{ id: requestedId, provider: 'codex' }],
    relations: [{ id: 'child-relation', type: 'delegated', from_id: latestId, to_id: requestedId, active: 1 }] }, 1, undefined,
    { roots: { total: 1001, next: null }, conversations: { total: 1001, next: null } }));
  expectRequestedConversation();
  expect(readOpenConversation()).toBe(original);
  expect(readOpenConversation().getAttribute('data-series')).toBeNull();
  expect(screen.getByRole('button', { name: 'Back to latest-root' })).toBeTruthy();
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
  expect(localStorage.getItem(workspaceKey('other', 'latest-root'))).not.toBeNull();
});

it.each(['unattended', 'review'])('opens an existing %s conversation without a listed root', kind => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { roots: [latestRoot],
    conversations: [{ id: latestId, provider: 'claude' }, { id: requestedId, provider: 'codex', kind }],
    relations: kind === 'review' ? [{ id: 'review', type: 'review_of', from_id: requestedId, to_id: latestId, active: 1 }] : [],
  } });
  openConversation(target);
  expectRequestedConversation();
  expect(readOpenConversation().getAttribute('data-series')).toBe('[]');
  expect(localStorage.getItem(workspaceKey('other', requestedId))).not.toBeNull();
});

it('opens the URL member of a root series even if its saved workspace has another active conversation', () => {
  const target = createStore();
  const continuedId = '["codex","continued"]';
  const root = createRoot('series-root', [requestedId, continuedId], '2026-10-12T00:00:00Z');
  target.setSnapshot({ seq: 1, generation: 1, projection: { roots: [latestRoot, root],
    conversations: [{ id: latestId }, { id: requestedId }, { id: continuedId }],
  } });
  localStorage.setItem(workspaceKey('other', 'series-root'), JSON.stringify(createWorkspace(continuedId)));
  openConversation(target);
  expectRequestedConversation();
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
});

it('saves under the URL conversation during projection errors and merges it when the root arrives', async () => {
  const target = createStore(); setFirstPage(target); openConversation(target);
  saveRootWorkspace();
  act(() => target.mergeProjection({}, 1, undefined,
    { roots: { total: 1001, next: null }, conversations: { total: 1001, next: null } }, 'Unable to load the full activity list.'));
  expectRequestedConversation();
  expect(localStorage.getItem(workspaceKey('other', requestedId))).not.toBeNull();
  const message = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(message, { target: { value: 'Kept through error' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open draft file' }));
  await screen.findByRole('textbox', { name: 'Code' });
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toContain('draft.ts');
  act(() => target.mergeProjection({ roots: [olderRoot], conversations: [{ id: requestedId }] }, 1));
  fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message);
  expect(message).toHaveProperty('value', 'Kept through error');
  expect(screen.getByRole('tab', { name: 'README.md' })).toBeTruthy();
  expect(readSavedTabs('older-root')).toHaveLength(3);
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
});

function openRoutedWorkspace(target: ScreenStore, initialEntry: string) {
  const siblingId = 'sibling';
  const client = { subscribeTerminal: () => () => {}, command: vi.fn(async (name: string): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: true,
    result: name === 'terminal.open' ? { terminalId: 'test-terminal' } : {},
  })) };
  function Page() {
    const navigate = useNavigate();
    const location = useLocation();
    const conversationId = location.pathname.startsWith('/c/') ? decodeURIComponent(location.pathname.slice(3)) : undefined;
    return <><button onClick={() => navigate(`/c/${encodeURIComponent(requestedId)}`)}>Requested route</button>
      <button onClick={() => navigate(`/c/${siblingId}`)}>Sibling route</button>
      <button onClick={() => navigate('/p/other?root=older-root')}>Older root route</button>
      <button onClick={() => navigate('/p/other?root=latest-root')}>Latest root route</button>
      <button onClick={() => navigate('/p/other?root=latest-root&session=new-draft')}>New draft route</button>
      <WorkspacePage project="other" conversationId={conversationId} target={target} client={client} showRootList={false}/></>;
  }
  const view = render(<MemoryRouter initialEntries={[initialEntry]}><Page/></MemoryRouter>);
  return { ...view, client };
}

it('opens a query-selected child in its own root and returns to the root conversation', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { roots: [latestRoot],
    conversations: [{ id: latestId }, { id: requestedId }],
    relations: [{ id: 'child', type: 'delegated', from_id: latestId, to_id: requestedId, active: 1 }],
  } });
  openRoutedWorkspace(target, `/p/other?conversation=${encodeURIComponent(requestedId)}`);
  expectRequestedConversation();
  expect(readOpenConversation().getAttribute('data-series')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back to latest-root' }));
  expect(readOpenConversation().textContent).toBe(latestId);
});

it('reuses sibling tabs, unsent inputs and the terminal session within the same root', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { roots: [latestRoot],
    conversations: [{ id: latestId }, { id: requestedId }, { id: 'sibling' }],
    relations: [requestedId, 'sibling'].map(to_id => ({ id: to_id, type: 'delegated', from_id: latestId, to_id, active: 1 })),
  } });
  const { client, unmount } = openRoutedWorkspace(target, `/c/${encodeURIComponent(requestedId)}`);
  const workbench = screen.getByLabelText('Workbench');
  const message = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(message, { target: { value: 'Unsent sibling message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Open tab' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await vi.waitFor(() => expect(client.command).toHaveBeenCalledWith('terminal.open', expect.anything()));
  for (let i = 0; i < 3; i++) {
    fireEvent.click(screen.getByRole('button', { name: 'Sibling route' }));
    expect(readOpenConversation().textContent).toBe('sibling');
    expect(screen.getByLabelText('Workbench')).toBe(workbench);
    fireEvent.click(screen.getByRole('button', { name: 'Requested route' }));
    expectRequestedConversation();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(message);
    expect(message).toHaveProperty('value', 'Unsent sibling message');
    expect(within(screen.getByLabelText('Workbench')).getAllByRole('tab')).toHaveLength(3);
  }
  expect(client.command.mock.calls.filter(([name]) => name === 'terminal.open')).toHaveLength(1);
  expect(client.command.mock.calls.filter(([name]) => name === 'terminal.close')).toHaveLength(0);
  expect(readSavedTabs('latest-root')).toHaveLength(3);
  expect(localStorage.getItem(workspaceKey('other', requestedId))).toBeNull();
  unmount();
  expect(client.command).toHaveBeenCalledWith('terminal.close', { terminalId: 'test-terminal' });
});

it('keeps the normal project default, restores each selected root and creates one draft tab', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { roots: [latestRoot, olderRoot], conversations: [{ id: latestId }, { id: requestedId }] } });
  saveRootWorkspace();
  openRoutedWorkspace(target, '/p/other');
  expect(readOpenConversation().textContent).toBe(latestId);
  fireEvent.click(screen.getByRole('button', { name: 'Open draft file' }));
  await screen.findByRole('textbox', { name: 'Code' });
  const latestSaved = readSavedTabs('latest-root');
  fireEvent.click(screen.getByRole('button', { name: 'Older root route' }));
  expectRequestedConversation();
  expect(screen.getByRole('tab', { name: 'README.md' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'draft.ts' })).toBeNull();
  expect(readSavedTabs('latest-root')).toEqual(latestSaved);
  fireEvent.click(screen.getByRole('button', { name: 'Latest root route' }));
  expect(screen.getByRole('tab', { name: 'draft.ts', selected: true })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'README.md' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New draft route' }));
  expect(screen.getByRole('tab', { name: 'New session', selected: true })).toBeTruthy();
  expect(within(screen.getByLabelText('Workbench')).getAllByRole('tab')).toHaveLength(3);
});

it('renames the root through the existing tab context menu instead of saving a local tab label', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { roots: [latestRoot], conversations: [{ id: latestId }] } });
  const client = { command: vi.fn(async (): Promise<Ack> => ({ type: 'ack', cmd_id: 'rename', ok: true })) };
  render(<MemoryRouter initialEntries={['/p/other?root=latest-root']}><WorkspacePage project="other" target={target} client={client} showRootList={false}/></MemoryRouter>);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'Conversation' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Tab name' }), { target: { value: 'Shared name' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tab name' }), { key: 'Enter' });
  await vi.waitFor(() => expect(client.command).toHaveBeenCalledWith('session.rename', { rootId: 'latest-root', name: 'Shared name' }));
  await vi.waitFor(() => expect(screen.queryByRole('textbox', { name: 'Tab name' })).toBeNull());
  expect(readSavedTabs('latest-root')[0].name).toBeUndefined();
});
