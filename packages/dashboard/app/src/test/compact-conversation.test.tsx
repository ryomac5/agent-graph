import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { ConversationPage, type ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { createStore, type Row } from '../lib/store.ts';

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  open() {} loadAddon() {} write() {} dispose() {}
  onData() { return { dispose() {} }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(messages: Row[] = [], state = 'running') {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Custom session', user_name: 'Custom session', project: 'p', state, conversation_ids: ['c'] }],
    conversations: [{ id: 'c', name: 'Automatic name', project: 'p', provider: 'claude', origin: 'observed' }],
    runs: [{ id: 'r', conversation_id: 'c', generation: 1, state, launch: { cwd: '/repo', model: { model: 'model-a' } } }],
    messages, message_memberships: messages.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })),
  } });
  target.setConnection('connected');
  const client: ConversationClient = { subscribeTerminal: () => () => {}, command: vi.fn(async name => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true,
    result: name === 'session.hosts' ? { hosts: [{ conversationId: 'c', terminalId: 'terminal', provider: 'claude', cwd: '/repo' }] }
      : name === 'list_models' ? [{ model: 'model-a', displayName: 'Model A' }] : {} })) };
  return { target, client };
}
function mount(f: ReturnType<typeof setup>, breadcrumb?: React.ReactNode) {
  return render(<MemoryRouter><Workbench project="p" session="root" conversationId="c" client={f.client} language="en" resolveRenameRoot={() => 'root'}
    renderConversation={(id, onConversation) => <ConversationPage conversationId={id} target={f.target} client={f.client} language="en" embedded onConversation={onConversation} breadcrumb={breadcrumb}/>}/></MemoryRouter>);
}
it.each([['running', 'running'], ['waiting_approval', 'waiting'], ['waiting_input', 'input'], ['failed', 'failed']])('names the tab with the user name and shows the %s dot with status and model in its title', async (state, tone) => {
  const f = setup([], state); mount(f);
  const tab = screen.getByRole('tab', { name: 'Custom session' });
  expect(tab.querySelector(`.status-${tone} .status-dot`)).toBeTruthy();
  expect(tab.firstElementChild?.classList.contains('status')).toBe(true);
  expect(tab.title).toContain('model-a');
  expect(tab.title).toContain({ running: 'Running', waiting_approval: 'Needs approval', waiting_input: 'Waiting', failed: 'Failed' }[state]!);
  expect(document.querySelector('.workbench-body .conv-header')).toBeNull();
  fireEvent.doubleClick(tab);
  fireEvent.change(screen.getByRole('textbox', { name: 'Tab name' }), { target: { value: 'My tab' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tab name' }), { key: 'Enter' });
  await vi.waitFor(() => expect(f.client.command).toHaveBeenCalledWith('session.rename', { rootId: 'root', name: 'My tab' }));
  act(() => f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: { roots: { upsert: [{ ...f.target.getSnapshot().projection.roots![0], name: 'My tab', user_name: 'My tab' }], remove: [] } } }));
  expect(await screen.findByRole('tab', { name: 'My tab' })).toBeTruthy();
});
it('places the three icon actions in order, opens details and changed files above the timeline, and opens the hosted terminal', async () => {
  const f = setup([{ id: 'edit', role: 'assistant', body: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'before', new_string: 'after' } }] }]);
  mount(f);
  await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Terminal' }).hasAttribute('disabled')).toBe(false));
  const header = document.querySelector('.workbench-tabs')!;
  const actions = header.querySelector('.conv-action-menu')!;
  expect([...actions.children].map(node => node.getAttribute('aria-label'))).toEqual(['Terminal', 'Files changed 1', 'Details']);
  for (const button of actions.children) { expect(button.querySelector('svg')).toBeTruthy(); expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label')); }
  expect(actions.querySelector('.conv-file-count')?.textContent).toBe('1');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Details' }));
  const details = screen.getByRole('region', { name: 'Details' });
  expect(details.closest('.workbench-body')).toBeTruthy();
  expect(details.compareDocumentPosition(document.querySelector('.conv-timeline')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(details).getByText('Model A')).toBeTruthy();
  expect(within(details).queryByText('model-a')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Files changed 1' }));
  const files = screen.getByRole('region', { name: 'Files changed' });
  expect(files.nextElementSibling?.classList.contains('conv-timeline')).toBe(true);
  expect(within(files).getByText('a.ts')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.queryByRole('region', { name: 'Details' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Files changed 1' }));
  expect(screen.queryByRole('region', { name: 'Files changed' })).toBeNull();
  const menu = within(header as HTMLElement).getByRole('button', { name: 'Conversation menu' });
  fireEvent.click(menu); expect(menu.getAttribute('aria-expanded')).toBe('true');
  fireEvent.keyDown(actions, { key: 'Escape' }); expect(menu.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
  expect(await screen.findByRole('tab', { name: 'Terminal' })).toBeTruthy();
});
it('keeps the back action at the left edge of the tab row and calls its navigation', async () => {
  const back = vi.fn(); mount(setup(), <button onClick={back} aria-label="Back to Root">← Root</button>);
  const header = document.querySelector('.workbench-tabs')!;
  expect(header.firstElementChild?.classList.contains('workbench-back')).toBe(true);
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Back to Root' }));
  expect(back).toHaveBeenCalledOnce();
  await act(async () => {});
});
function messages() { return Array.from({ length: 450 }, (_, index) => ({ id: `m${String(index).padStart(3, '0')}`, role: 'user', body: `Message ${index}`, source_ts: new Date(index * 1000).toISOString() })); }
function measureTimeline() {
  const timeline = document.querySelector<HTMLDivElement>('.conv-timeline')!;
  Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => timeline.querySelectorAll('article').length * 10 });
  Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 });
  return timeline;
}
it('loads older history near the top once, shows a thin loading indicator and preserves the viewed position', async () => {
  const rows = messages(); const f = setup([], 'idle');
  let release: (() => void) | undefined;
  let delay = false;
  const fetchConversation = vi.fn(async (path: string) => {
    if (new URL(path, 'http://localhost').searchParams.has('edits')) return { generation: 0, projection: { messages: [], message_memberships: [] }, next: null };
    if (delay) { delay = false; await new Promise<void>(resolve => { release = resolve; }); }
    const before = new URL(path, 'http://localhost').searchParams.get('before');
    const end = before ? rows.findIndex(row => row.id === JSON.parse(before).id) : rows.length;
    const page = rows.slice(Math.max(0, end - 200), end);
    return { generation: 0, projection: { messages: page, message_memberships: page.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })) }, hasOlder: end > 200, next: null };
  });
  f.client.fetchConversation = fetchConversation;
  mount(f); await screen.findByText('Message 449');
  const timeline = measureTimeline(); const before = fetchConversation.mock.calls.length;
  fireEvent.scroll(timeline, { target: { scrollTop: 200 } }); expect(fetchConversation).toHaveBeenCalledTimes(before);
  delay = true;
  fireEvent.scroll(timeline, { target: { scrollTop: 40 } });
  expect(screen.getByRole('status', { name: 'Loading messages…' }).className).toBe('history-loading');
  fireEvent.scroll(timeline); expect(fetchConversation).toHaveBeenCalledTimes(before + 1);
  await act(async () => release!());
  expect(screen.getByText('Message 50')).toBeTruthy();
  expect(timeline.scrollTop).toBe(2040);
  expect(timeline.scrollHeight).toBe(4000);
  expect(screen.queryByRole('status', { name: 'Loading messages…' })).toBeNull();
  fireEvent.scroll(timeline, { target: { scrollTop: 20 } }); await screen.findByText('Message 0');
  expect(timeline.scrollTop).toBe(520);
  const last = fetchConversation.mock.calls.length;
  fireEvent.scroll(timeline, { target: { scrollTop: 0 } }); expect(fetchConversation).toHaveBeenCalledTimes(last);
  expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
});
it('preserves the scroll position when revealing older messages already in the projection and uses token spacing', async () => {
  mount(setup(messages(), 'idle')); await act(async () => {});
  const timeline = measureTimeline();
  expect(screen.queryByText('Message 249')).toBeNull();
  fireEvent.scroll(timeline, { target: { scrollTop: 60 } });
  expect(screen.getByText('Message 50')).toBeTruthy(); expect(timeline.scrollTop).toBe(2060);
  const css = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  expect(css.match(/\.conv-timeline-inner \{([^}]+)\}/)![1]).toContain('padding: var(--space-6)');
  expect(css).toContain('.conv-timeline-inner > .message-first:first-child { margin-top: 0; }');
});

it('shows all three actions for a conversation without changes and hides them when a terminal tab is selected', async () => {
  mount(setup([], 'idle')); await act(async () => {});
  const files = screen.getByRole('button', { name: 'Files changed 0' });
  expect(files.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open tab' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Files changed 0' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Custom session' }));
  expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy();
});

it('keeps the viewed message fixed when live input arrives during an older window request', async () => {
  const rows = messages(); const f = setup([], 'idle');
  let release: (() => void) | undefined;
  f.client.fetchConversation = vi.fn(async path => {
    const params = new URL(path, 'http://localhost').searchParams;
    if (params.has('edits')) return { generation: 0, projection: { messages: [], message_memberships: [] }, next: null };
    const before = params.get('before');
    if (before) await new Promise<void>(resolve => { release = resolve; });
    const end = before ? rows.findIndex(row => row.id === JSON.parse(before).id) : rows.length;
    const page = rows.slice(Math.max(0, end - 200), end);
    return { generation: 0, projection: { messages: page,
      message_memberships: page.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })) },
      hasOlder: end > 200, next: null };
  });
  mount(f); await screen.findByText('Message 449');
  const timeline = document.querySelector<HTMLDivElement>('.conv-timeline')!;
  Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => timeline.querySelectorAll('article.message').length * 10 });
  Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 100 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const index = [...timeline.querySelectorAll('article.message')].indexOf(this);
    const top = index >= 0 ? index * 10 - timeline.scrollTop : 0;
    return { top, bottom: top + 10, height: 10, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} };
  });
  fireEvent.scroll(timeline, { target: { scrollTop: 60 } });
  const viewed = document.getElementById('message-m256')!;
  const top = viewed.getBoundingClientRect().top;
  await act(async () => {
    f.target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
      messages: { remove: [], upsert: [{ id: 'live', role: 'user', body: 'New message', source_ts: '2030-01-01T00:00:00Z' }] },
      message_memberships: { remove: [], upsert: [{ id: 'live', message_id: 'live', conversation_id: 'c', active: 1 }] },
    } });
  });
  expect(document.getElementById('message-m250')).toBeTruthy();
  expect(viewed.getBoundingClientRect().top).toBe(top);
  await act(async () => release!());
  expect(viewed.getBoundingClientRect().top).toBe(top);
});
