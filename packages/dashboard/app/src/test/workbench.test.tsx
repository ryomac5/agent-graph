import { useContext, useLayoutEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { FileTreePanel, useFileExplorer } from '../pages/files/FilesPage.tsx';
import { DiffView } from '../components/diff/DiffView.tsx';
import { parseDiff } from '../components/diff/model.ts';
import { OpenWorkspaceFile, WorkspaceConversationHeader, type ConversationTabMetadata } from '../lib/workspace-context.ts';
import { createStore } from '../lib/store.ts';
import { workspaceKey } from '../lib/panes.ts';
import { DEFAULT_KEYS } from '../lib/keys.ts';
import type { Ack, TerminalNotice } from '../lib/client.ts';
const terminalInput = vi.hoisted(() => ({ send: undefined as ((data: string) => void) | undefined }));
import type { ConversationClient } from '../pages/conversation/ConversationPage.tsx';
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; element?: HTMLPreElement;
  open(host: HTMLElement) { this.element = document.createElement('pre'); host.append(this.element); }
  loadAddon() {} onData(listener: (data: string) => void) { terminalInput.send = listener; return { dispose() {} }; } dispose() {}
  write(data: string) { this.element!.textContent += data; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture(editable = true, language: 'en' | 'ja' = 'en') {
  let disk = 'const value = 1;', hash = 'h1';
  const subscribers = new Set<(notice: TerminalNotice) => void>();
  let opened = 0;
  const client: ConversationClient = { subscribeTerminal(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, command: vi.fn(async (name: string, payload?: unknown): Promise<Ack> => {
    const p = payload as { path?: string; baseHash?: string; content?: string };
    if (name === 'files.write') { if (p.baseHash !== hash) return { type: 'ack', cmd_id: 'c', ok: false, error: 'conflict' }; disk = p.content!; hash = 'saved'; }
    const result = name === 'files.worktrees' ? { worktree: '/repo', worktrees: [{ path: '/repo', detached: false }] }
      : name === 'files.list' ? { entries: [{ name: 'file.ts', path: 'file.ts', kind: 'file', changed: false, git: [] }, { name: 'other.txt', path: 'other.txt', kind: 'file', changed: false, git: [] }] }
      : name === 'terminal.open' ? { terminalId: `terminal-${++opened}`, cwd: '/repo', shell: '/bin/zsh' }
      : name === 'files.read' ? { path: p.path, worktree: '/repo', state: 'text', content: disk, size: disk.length, hash, editable } : { hash };
    return { type: 'ack', cmd_id: 'c', ok: true, result };
  }) };
  const target = createStore();
  function Wrapper({ session = 'session', bindings = DEFAULT_KEYS }: { session?: string; bindings?: typeof DEFAULT_KEYS }) {
    const opener = useRef<(path: string, worktree?: string) => void>(() => {});
    const explorer = useFileExplorer({ client, project: 'p', target, embedded: true });
    return <OpenWorkspaceFile.Provider value={(path, worktree) => opener.current(path, worktree)}>
      <Workbench key={session} project="p" session={session} conversationId="c" client={client} language={language} bindings={bindings} registerOpenFile={opener} renderConversation={() => <textarea aria-label="Message"/>}/>
      <FileTreePanel explorer={explorer} language={language}/>
      <DiffView files={parseDiff('diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n')} layout="unified" attribution="unknown" evidenceUrl="#evidence"/>
    </OpenWorkspaceFile.Provider>;
  }
  const view = render(<MemoryRouter><Wrapper/></MemoryRouter>);
  return { client, Wrapper, view, changeDisk: (content: string) => { disk = content; hash = content; }, emit: (notice: TerminalNotice) => subscribers.forEach(listener => listener(notice)) };
}
function panes() { return [...document.querySelectorAll<HTMLElement>('[data-pane-id]')]; }
function tabs(pane = panes()[0]) { return within(pane).getAllByRole('tab'); }
async function openCode() { const item = await screen.findByRole('treeitem', { name: 'file.ts' }); fireEvent.doubleClick(item.querySelector('.tree-row')!); await screen.findAllByRole('textbox', { name: 'Code' }); }
function edit(text: string) {
  const input = screen.getByRole('textbox', { name: 'Code' });
  const view = EditorView.findFromDOM(input)!;
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}
it('splits with Cmd+D and Cmd+Shift+D inside an input, prevents bookmarks and restores layout', async () => {
  const f = fixture(); const input = screen.getByRole('textbox', { name: 'Message' });
  expect(fireEvent.keyDown(input, { key: 'd', metaKey: true })).toBe(false); expect(panes()).toHaveLength(2);
  expect(fireEvent.keyDown(panes()[1], { key: 'd', metaKey: true, shiftKey: true })).toBe(false); expect(panes()).toHaveLength(3);
  expect(document.querySelector('.workbench-split.vertical')).toBeTruthy();
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(panes().slice(1).every(pane => within(pane).queryAllByRole('tab').length === 0)).toBe(true);
  await vi.waitFor(() => expect(document.activeElement).toBe(panes()[2]));
  const saved = localStorage.getItem(workspaceKey('p', 'session'));
  f.view.unmount(); render(<MemoryRouter><f.Wrapper/></MemoryRouter>);
  expect(panes()).toHaveLength(3); expect(localStorage.getItem(workspaceKey('p', 'session'))).toBe(saved);
});
it('only opens code on double click, selects existing files, and opens diff filenames', async () => {
  const f = fixture(); const item = await screen.findByRole('treeitem', { name: 'file.ts' });
  fireEvent.click(item.querySelector('.tree-row')!); expect(tabs()).toHaveLength(1);
  await openCode(); expect(tabs().map(tab => tab.textContent)).toEqual(['Conversation', 'file.ts']);
  fireEvent.click(tabs()[0]); fireEvent.doubleClick(screen.getByRole('button', { name: 'file.ts', expanded: true }));
  expect(tabs()).toHaveLength(2); expect(tabs()[1].getAttribute('aria-selected')).toBe('true');
  expect(f.client.command).toHaveBeenCalledWith('files.read', expect.objectContaining({ path: 'file.ts', projectId: 'p' }));
});
it('passes the meta nonce to CodeMirror', async () => {
  const meta = document.createElement('meta');
  meta.name = 'agent-graph-style-nonce'; meta.content = 'editor-style-nonce';
  document.head.append(meta);
  try {
    fixture(); await openCode();
    const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Code' }))!;
    expect(view.state.facet(EditorView.cspNonce)).toBe(meta.content);
  } finally { meta.remove(); }
});
it('saves with Cmd+S, shows conflict choices, compares and discards changes', async () => {
  const f = fixture(); await openCode(); edit('mine');
  expect(tabs()[1].textContent).toContain('●');
  await act(async () => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 's', metaKey: true }));
  expect(f.client.command).toHaveBeenCalledWith('files.write', expect.objectContaining({ content: 'mine', baseHash: 'h1' }));
  expect(tabs()[1].textContent).not.toContain('●');
  edit('my second edit'); f.changeDisk('changed disk');
  await act(async () => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 's', metaKey: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  expect(screen.getByText('changed disk')).toBeTruthy(); expect(screen.getByText('Your changes')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Overwrite' })));
  expect(f.client.command).toHaveBeenCalledWith('files.write', expect.objectContaining({ content: 'my second edit', baseHash: 'changed disk' }));
  edit('third'); f.changeDisk('latest disk');
  await act(async () => fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 's', metaKey: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard' })); expect(screen.getByRole('textbox', { name: 'Code' }).textContent).toBe('latest disk');
});
it('confirms closing dirty tabs and preserves edits when closing an empty split', async () => {
  fixture(); await openCode(); edit('unsaved');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  fireEvent.click(screen.getByRole('button', { name: 'Close file.ts' })); expect(tabs()).toHaveLength(2);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 'd', metaKey: true });
  expect(panes()).toHaveLength(2); expect(within(panes()[1]).queryByRole('textbox', { name: 'Code' })).toBeNull();
  fireEvent.click(within(panes()[1]).getByRole('button', { name: 'Close pane' }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(panes()).toHaveLength(1);
  expect(within(panes()[0]).getByRole('textbox', { name: 'Code' }).textContent).toBe('unsaved');
});
it('shows a read-only reason and blocks saving redacted files', async () => {
  const f = fixture(false); await openCode(); expect(screen.getByText('Files with redacted content cannot be edited.')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Code' }).getAttribute('contenteditable')).toBe('false');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 's', metaKey: true });
  expect(vi.mocked(f.client.command).mock.calls.some(([name]) => name === 'files.write')).toBe(false);
});
it('opens files through Cmd+P and applies custom workspace bindings', async () => {
  const f = fixture(); await act(async () => {});
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'p', metaKey: true });
  const input = screen.getByRole('combobox', { name: 'Search file names' });
  await screen.findByRole('option', { name: 'other.txt' }); fireEvent.change(input, { target: { value: 'file' } }); fireEvent.keyDown(input, { key: 'Enter' });
  await screen.findByRole('textbox', { name: 'Code' }); expect(tabs()[1].textContent).toBe('file.ts');
  f.view.rerender(<MemoryRouter><f.Wrapper bindings={{ ...DEFAULT_KEYS, splitHorizontal: 'Ctrl+L' }}/></MemoryRouter>);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 'l', ctrlKey: true }); expect(panes()).toHaveLength(2);
});
it('renders terminal output and exit, reopens and closes terminal sessions', async () => {
  const f = fixture(); fireEvent.click(screen.getByRole('button', { name: 'Open tab' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await vi.waitFor(() => expect(f.client.command).toHaveBeenCalledWith('terminal.open', expect.objectContaining({ projectId: 'p', cols: 80, rows: 24 })));
  act(() => f.emit({ type: 'terminal', event: 'output', terminalId: 'terminal-1', data: 'hello terminal' })); expect(screen.getByText('hello terminal')).toBeTruthy();
  act(() => f.emit({ type: 'terminal', event: 'exit', terminalId: 'terminal-1', exitCode: 0 }));
  fireEvent.click(screen.getByRole('button', { name: 'Open again' }));
  await vi.waitFor(() => expect(vi.mocked(f.client.command).mock.calls.filter(([name]) => name === 'terminal.open')).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));
  expect(f.client.command).toHaveBeenCalledWith('terminal.close', { terminalId: 'terminal-2' });
});
it('reorders tabs and moves the last tab into its neighbour through pointer drag and drop', async () => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  const f = fixture(); await openCode();
  const stored = JSON.parse(localStorage.getItem(workspaceKey('p', 'session'))!);
  const sourcePane = { kind: 'pane', id: 'other-pane', tabs: [{ kind: 'conversation', id: 'other-tab', conversationId: 'other', name: 'Other conversation' }], active: 'other-tab' };
  f.view.unmount(); localStorage.setItem(workspaceKey('p', 'session'), JSON.stringify({ kind: 'split', id: 'split', direction: 'horizontal', ratio: .5, first: stored, second: sourcePane }));
  render(<MemoryRouter><f.Wrapper/></MemoryRouter>);
  const source = panes()[1].querySelector('.workbench-tab')!;
  const destination = panes()[0].querySelector('.workbench-tab')!;
  vi.spyOn(destination, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40));
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => destination) });
  fireEvent.pointerDown(source.querySelector('[role="tab"]')!, { button: 0, pointerId: 1, clientX: 50, clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 20 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 20 });
  expect(panes()).toHaveLength(1); expect(tabs().map(tab => tab.textContent)).toEqual(['Other conversation', 'Conversation', 'file.ts']);
});
it('resizes a divider with pointer movement and remembers the size', async () => {
  fixture(); fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'd', metaKey: true });
  const divider = screen.getByRole('separator', { name: 'Pane size' });
  vi.spyOn(divider.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1006, 500));
  fireEvent.pointerDown(divider, { pointerId: 1, clientX: 500 }); fireEvent.pointerMove(window, { clientX: 750 }); fireEvent.pointerUp(window);
  expect(divider.getAttribute('aria-valuenow')).toBe('75');
  expect(JSON.parse(localStorage.getItem(workspaceKey('p', 'session'))!).ratio).toBe(0.75);
});
it('isolates layouts by session and restores Japanese tab labels', async () => {
  const f = fixture(true, 'ja');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'd', metaKey: true }); expect(panes()).toHaveLength(2);
  f.view.rerender(<MemoryRouter><f.Wrapper session="other"/></MemoryRouter>); expect(panes()).toHaveLength(1); expect(tabs()[0].textContent).toBe('会話');
  f.view.rerender(<MemoryRouter><f.Wrapper/></MemoryRouter>); expect(panes()).toHaveLength(2);
});
it('reloads on focus and polls disk hashes while preserving unsaved edits', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const f = fixture(); await openCode(); f.changeDisk('external');
  await act(async () => fireEvent.focus(window)); expect(screen.getByRole('textbox', { name: 'Code' }).textContent).toBe('external');
  edit('mine'); f.changeDisk('external again');
  const poll = intervals.mock.calls.find(([, delay]) => delay === 5000)![0] as () => void;
  await act(async () => poll());
  expect(screen.getByText('This file changed on disk.')).toBeTruthy(); expect(screen.getByRole('textbox', { name: 'Code' }).textContent).toBe('mine');
});
it('keeps terminal output and its process while moving the tab across panes', async () => {
  const f = fixture(); fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'd', metaKey: true });
  fireEvent.click(within(panes()[1]).getByRole('button', { name: 'Open tab' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await vi.waitFor(() => expect(f.client.command).toHaveBeenCalledWith('terminal.open', expect.anything()));
  act(() => f.emit({ type: 'terminal', event: 'output', terminalId: 'terminal-1', data: 'kept output' }));
  const transfer = { setData: vi.fn(), getData: () => '' };
  const source = within(panes()[1]).getByRole('tab', { name: 'Terminal' }).parentElement!;
  fireEvent.dragStart(source, { dataTransfer: transfer }); fireEvent.drop(panes()[0].querySelector('.workbench-tabs')!, { dataTransfer: transfer });
  expect(screen.getByText('kept output')).toBeTruthy();
  expect(vi.mocked(f.client.command).mock.calls.filter(([name]) => name === 'terminal.open')).toHaveLength(1);
  expect(vi.mocked(f.client.command).mock.calls.filter(([name]) => name === 'terminal.close')).toHaveLength(0);
});
it('fits and resizes the terminal when its host changes size and sends keyboard input', async () => {
  const { createTerminalSession } = await import('../pages/workspace/TerminalTab.tsx');
  const f = fixture();
  const host = document.createElement('div'); document.body.append(host);
  const session = createTerminalSession(f.client, 'p', '/worktree');
  await session.mount(host); await act(async () => {});
  const surface = host.querySelector('.terminal-surface')!;
  Object.defineProperty(surface, 'clientWidth', { value: 500 }); Object.defineProperty(surface, 'clientHeight', { value: 300 });
  session.resize();
  terminalInput.send?.('pwd\r');
  expect(f.client.command).toHaveBeenCalledWith('terminal.input', { terminalId: 'terminal-1', data: 'pwd\r' });
  expect(f.client.command).toHaveBeenCalledWith('terminal.resize', { terminalId: 'terminal-1', cols: 80, rows: 24 });
  expect(f.client.command).toHaveBeenCalledWith('terminal.open', { projectId: 'p', worktree: '/worktree', cols: 80, rows: 24 });
  session.dispose(); host.remove();
});

it('opens all three empty pane actions and keeps the add menu usable', async () => {
  const f = fixture();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'd', metaKey: true });
  const empty = panes()[1];
  for (const name of ['Open conversation', 'Open terminal', 'Open file']) expect(within(empty).getByRole('button', { name })).toBeTruthy();
  fireEvent.click(within(empty).getByRole('button', { name: 'Open tab' }));
  expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  fireEvent.click(within(empty).getByRole('button', { name: 'Open tab' }));
  fireEvent.click(within(empty).getByRole('button', { name: 'Open terminal' }));
  await vi.waitFor(() => expect(f.client.command).toHaveBeenCalledWith('terminal.open', expect.anything()));
  fireEvent.click(within(empty).getByRole('button', { name: 'Close Terminal' }));
  expect(panes()).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'd', metaKey: true });
  fireEvent.click(within(panes()[1]).getByRole('button', { name: 'Open conversation' }));
  expect(panes()[0].dataset.focused).toBe('true');
  expect(tabs(panes()[0])).toHaveLength(1);
  expect(within(panes()[1]).getByRole('heading', { name: 'Empty pane' })).toBeTruthy();
  fireEvent.keyDown(panes()[1], { key: 'd', metaKey: true });
  fireEvent.click(within(panes()[2]).getByRole('button', { name: 'Open file' }));
  fireEvent.click(within(await screen.findByRole('option', { name: 'other.txt' })).getByRole('button'));
  await screen.findByRole('textbox', { name: 'Code' });
  expect(within(panes()[2]).getByRole('tab', { name: 'other.txt' })).toBeTruthy();
});
it('opens a double clicked file in the focused empty pane even when the file is already open', async () => {
  fixture(); await openCode();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Code' }), { key: 'd', metaKey: true });
  await openCode();
  expect(panes()).toHaveLength(2);
  expect(tabs(panes()[0]).map(tab => tab.textContent)).toEqual(['Conversation', 'file.ts']);
  expect(tabs(panes()[1]).map(tab => tab.textContent)).toEqual(['file.ts']);
  expect(panes()[1].dataset.focused).toBe('true');
});
it('closes the last empty pane and restores the closed workspace', async () => {
  const f = fixture();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'd', metaKey: true });
  fireEvent.click(within(panes()[0]).getByRole('button', { name: 'Close Conversation' }));
  expect(panes()).toHaveLength(1);
  expect(within(panes()[0]).queryAllByRole('tab')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Close pane' }));
  expect(panes()).toHaveLength(0);
  expect(localStorage.getItem(workspaceKey('p', 'session'))).toBe('null');
  f.view.unmount(); render(<MemoryRouter><f.Wrapper/></MemoryRouter>);
  expect(panes()).toHaveLength(0);
});

it('refreshes hidden tab metadata when only the refresh callback changes', () => {
  const metadata: ConversationTabMetadata = { name: 'Original', state: 'running', title: 'Original title', model: 'old-model' };
  function Conversation() {
    const header = useContext(WorkspaceConversationHeader)!;
    useLayoutEffect(() => { header.report(header.tabId, metadata); }, [header.tabId, header.report]);
    return <textarea aria-label="Message"/>;
  }
  localStorage.setItem(workspaceKey('p', 'refresh'), JSON.stringify({ kind: 'pane', id: 'pane', active: 'first', tabs: [
    { kind: 'conversation', id: 'first', conversationId: 'c1' },
    { kind: 'conversation', id: 'second', conversationId: 'c2' },
  ] }));
  const client = { command: vi.fn() };
  const renderConversation = () => <Conversation/>;
  const renderWorkbench = (refreshTab: (id: string, previous: ConversationTabMetadata) => ConversationTabMetadata) => <MemoryRouter>
    <Workbench project="p" session="refresh" conversationId="c1" client={client} language="en" renderConversation={renderConversation} refreshTab={refreshTab}/>
  </MemoryRouter>;
  const view = render(renderWorkbench((_id, previous) => previous));
  fireEvent.click(screen.getAllByRole('tab')[1]);
  const refreshTab = vi.fn((id: string, previous: ConversationTabMetadata) => ({ ...previous, name: 'Updated ' + id, state: 'idle', title: 'Latest title', model: 'new-model' }));
  view.rerender(renderWorkbench(refreshTab));
  const hiddenTab = screen.getByRole('tab', { name: 'Updated c1' });
  expect(hiddenTab.getAttribute('aria-selected')).toBe('false');
  expect(hiddenTab.title).toContain('Latest title');
  expect(refreshTab).toHaveBeenCalledWith('c1', metadata);
  expect(refreshTab.mock.calls.every(([id]) => id === 'c1')).toBe(true);
});
