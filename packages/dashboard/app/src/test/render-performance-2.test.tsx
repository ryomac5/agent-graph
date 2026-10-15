import { Profiler, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore as createScreenStore } from '../lib/store.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore, useScreenStore, type Row, type ScreenState } from "./current-fixture.ts";
import { readBody, readMessageBody } from '../lib/message-body.ts';
import { memoizeProjection } from '../lib/projection-cache.ts';
import { selectRoots } from '../lib/roots.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { ConversationPage, ConversationTabHeader } from '../pages/conversation/ConversationPage.tsx';
import { WorkspaceConversationHeader } from '../lib/workspace-context.ts';
import { WorkspaceTabButton } from '../components/conversation/WorkingClock.tsx';
import { Notifications } from '../components/notifications/Notifications.tsx';
import { workspaceKey } from '../lib/panes.ts';
import * as graph from '../pages/graph/rows.ts';
import * as timeline from '../components/conversation/timeline.ts';
import type { ConversationPageData } from '../lib/projection-client.ts';
import { App } from '../App.tsx';
import type { Ack } from '../lib/client.ts';
import { RootList } from '../components/RootViews.tsx';

vi.mock('../components/conversation/Markdown.tsx', () => ({ Markdown: ({ text }: { text: string }) => <span>{text}</span> }));
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function createFixture() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'p', display_name: 'Project', root_path: '/project', state: 'registered' }],
    roots: [{ id: 'root', name: 'Work', state: 'running', project: 'p', conversation_ids: ['c'] }],
    conversations: [{ id: 'c', provider: 'codex', origin: 'managed', project: 'p' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'running', turn_started_ts: '2026-10-13T00:00:00Z' }],
    messages: [{ id: 'm', role: 'assistant', body: 'Latest message', source_ts: '2026-10-13T00:00:01Z' }],
    message_memberships: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: 1 }],
  } });
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })),
    fetchConversation: vi.fn(async (_path: string) => ({ generation: 1, projection: {}, next: null })) };
  return { target, client };
}

it('decodes each message body once across classification, display and repeated windows', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, body: JSON.stringify({ text: `Message ${i}` }) }));
  const parse = vi.spyOn(JSON, 'parse');
  for (let repeat = 0; repeat < 30; repeat++) for (const row of rows) readBody(row.body);
  const before = parse.mock.calls.length;
  parse.mockClear();
  for (let repeat = 0; repeat < 30; repeat++) for (const row of rows) expect(readMessageBody(row)).toBe(`Message ${row.id.slice(1)}`);
  expect(parse).toHaveBeenCalledTimes(200);
  expect(readMessageBody({ ...rows[0], body: JSON.stringify({ text: 'Corrected' }) })).toBe('Corrected');
  expect(parse).toHaveBeenCalledTimes(201);
  let reads = 0;
  const structured = { body: [{ type: 'text', get text() { reads++; return 'Block'; } }] };
  for (let i = 0; i < 30; i++) { readBody(structured.body); readMessageBody(structured); }
  expect(reads).toBe(1);
  expect(readMessageBody({ body: '' })).toBe('');
  expect(readMessageBody({ body: '{not JSON' })).toBe('{not JSON');
  expect(readMessageBody({ body: '{"verdict":"approve","comment":"Good"}' })).toBe('Approved · Good');
  console.info(`200 messages x 30 reads: JSON parses ${before} -> 200; corrected message adds 1; structured block reads 60 -> ${reads}`);
});

it('reuses projection calculations across interleaved windows and unrelated patches', () => {
  const target = createScreenStore();
  target.setSnapshot(createFixture().target.getSnapshot());
  let names = 0;
  const state = target.getSnapshot();
  const roots = [{ ...state.projection.roots[0], get name() { names++; return 'Work'; } }];
  target.setSnapshot({ ...state, projection: { ...state.projection, roots } });
  const windowMessages: Row[] = [{ id: 'older', source_ts: '2026-10-12T00:00:00Z' }];
  const calculate = vi.fn((state: ScreenState) => state.projection.messages);
  const select = memoizeProjection(['messages', 'roots'], calculate);
  let initial: ReturnType<typeof selectRoots> | undefined;
  for (let seq = 2; seq <= 31; seq++) {
    target.applyPatch({ type: 'patch', from_seq: seq - 1, seq, generation: 1, changes: { findings: { remove: [], upsert: [{ id: 'f', revision: seq }] } } });
    const current = target.getSnapshot();
    const history = { ...current, projection: { ...current.projection, messages: windowMessages } };
    initial ??= selectRoots(current);
    expect(selectRoots(current)).toBe(initial);
    selectRoots(history);
    select(current); select(history);
  }
  expect(calculate).toHaveBeenCalledTimes(2);
  expect(names).toBe(2);
  target.applyPatch({ type: 'patch', from_seq: 31, seq: 32, generation: 1, changes: {
    runs: { remove: [], upsert: [{ id: 'r', conversation_id: 'c', state: 'failed' }] },
    roots: { remove: [], upsert: [{ ...roots[0], state: 'failed' }] },
  } });
  expect(selectRoots(target.getSnapshot())[0].state).toBe('failed');
  select(target.getSnapshot());
  expect(calculate).toHaveBeenCalledTimes(3);
  console.info('30 unrelated patches with 2 interleaved windows: projection builds 60 -> 2; root builds 60 -> 2; relevant run patch adds 1');
});

it('does not build a hidden graph on patches or ticks and shows the latest state on reveal', async () => {
  vi.useFakeTimers();
  const { target, client } = createFixture();
  const build = vi.spyOn(graph, 'buildRows');
  const page = (visible: boolean) => <MemoryRouter><WorkspacePage project="p" target={target} client={client}
    showRootList={false} panelVisible={visible} renderConversation={() => <div>Conversation</div>}/></MemoryRouter>;
  const view = render(page(true));
  await act(async () => {});
  expect(build.mock.calls.length).toBeGreaterThan(0);
  view.rerender(page(false));
  await act(async () => {});
  build.mockClear();
  for (let seq = 2; seq <= 11; seq++) await act(async () => {
    target.applyPatch({ type: 'patch', from_seq: seq - 1, seq, generation: 1, changes: {
      runs: { remove: [], upsert: [{ id: 'r', conversation_id: 'c', state: 'failed', last_evidence_ts: String(seq) }] },
    } });
    vi.advanceTimersByTime(1000);
  });
  expect(build).not.toHaveBeenCalled();
  view.rerender(page(true));
  await act(async () => {});
  expect(build.mock.calls.at(-1)?.[0].nodes[0].state).toBe('failed');
  console.info('hidden graph: 10 changing patches + 10 seconds -> 0 row builds; reveal uses the latest failed state');
});

it('keeps inactive conversation drafts while deferring store updates until selection', async () => {
  const { target, client } = createFixture();
  localStorage.setItem(workspaceKey('p', 'root'), JSON.stringify({ kind: 'pane', id: 'pane', active: 'a', tabs: [
    { id: 'a', kind: 'conversation', conversationId: 'c' }, { id: 'b', kind: 'conversation', conversationId: 'other' },
  ] }));
  const renders = vi.fn();
  function Conversation({ id }: { id: string }) {
    const state = useScreenStore(target);
    const [draft, setDraft] = useState('');
    renders(id, state.seq);
    return <input aria-label={`Draft ${id}`} value={draft} onChange={event => setDraft(event.target.value)}/>;
  }
  render(<MemoryRouter><Workbench project="p" session="root" conversationId="c" client={client} language="en"
    renderConversation={id => <Conversation id={id}/>}/></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Draft c'), { target: { value: 'Keep my draft' } });
  fireEvent.click(screen.getAllByRole('tab')[1]);
  await act(async () => {});
  renders.mockClear();
  for (let seq = 2; seq <= 11; seq++) await act(async () => {
    target.applyPatch({ type: 'patch', from_seq: seq - 1, seq, generation: 1, changes: { roots: { remove: [], upsert: [{ id: 'root', revision: seq }] } } });
  });
  expect(renders.mock.calls.filter(([id]) => id === 'c')).toHaveLength(0);
  fireEvent.click(screen.getAllByRole('tab')[0]);
  expect((screen.getByLabelText('Draft c') as HTMLInputElement).value).toBe('Keep my draft');
  expect(renders.mock.calls.filter(([id]) => id === 'c').at(-1)).toEqual(['c', 11]);
  console.info('inactive conversation: 10 patches -> 0 renders; reveal reads seq 11 and retains draft');
});

it('does not commit Notifications or ConversationTabHeader on 30 clock ticks', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-13T00:00:10Z'));
  const { target, client } = createFixture();
  const notifications = vi.fn(), header = vi.fn(), clock = vi.fn();
  const metadata = { name: 'Work', state: 'running', title: 'Work', elapsedStarted: Date.parse('2026-10-13T00:00:00Z'), elapsedLabel: 'Elapsed' };
  render(<MemoryRouter>
    <div id="workspace-back-test"/><div id="workspace-actions-test"/>
    <WorkspaceConversationHeader.Provider value={{ tabId: 'test', report: () => {} }}>
      <Profiler id="header" onRender={header}><ConversationTabHeader metadata={metadata} actions={<button>Action</button>}/></Profiler>
    </WorkspaceConversationHeader.Provider>
    <Profiler id="notices" onRender={notifications}><Notifications target={target} client={client}/></Profiler>
    <Profiler id="clock" onRender={clock}><WorkspaceTabButton metadata={metadata}>Work</WorkspaceTabButton></Profiler>
  </MemoryRouter>);
  await act(async () => {});
  notifications.mockClear(); header.mockClear(); clock.mockClear();
  for (let i = 0; i < 30; i++) await act(async () => { vi.advanceTimersByTime(1000); });
  expect(notifications).not.toHaveBeenCalled();
  expect(header).not.toHaveBeenCalled();
  expect(clock).toHaveBeenCalledTimes(30);
  expect(screen.getByRole('button', { name: 'Work' }).title).toContain('40s');
  console.info('30 ticks: Notifications commits 0; ConversationTabHeader commits 0; live tab tooltip commits 30');
});

it('updates root activity labels at midnight instead of every second', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 13, 23, 58));
  const { target } = createFixture();
  const before = target.getSnapshot();
  target.setSnapshot({ ...before, projection: { ...before.projection, runs: [{ id: 'r', conversation_id: 'c', state: 'idle' }],
    roots: before.projection.roots.map(root => ({ ...root, last_activity_ts: new Date(2026, 9, 13, 9).toISOString() })),
    messages: [{ ...before.projection.messages[0], source_ts: new Date(2026, 9, 13, 9).toISOString() }],
  } });
  const state = target.getSnapshot();
  const commits = vi.fn();
  render(<MemoryRouter><Profiler id="root-start" onRender={commits}><RootList state={state} roots={selectRoots(state)}/></Profiler></MemoryRouter>);
  await act(async () => {});
  commits.mockClear();
  for (let i = 0; i < 30; i++) await act(async () => { vi.advanceTimersByTime(1000); });
  expect(commits).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(90_000); });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.root-time')?.getAttribute('title')).toContain('Yesterday');
  expect(document.querySelector('.root-time')?.textContent).toBe('10/13');
  console.info('idle root start: 30 second ticks -> 0 commits; midnight label/title update -> 1 commit');
});

it('keeps timeline groups when a different conversation gains a message', async () => {
  const { target, client } = createFixture();
  const group = vi.spyOn(timeline, 'groupToolRuns');
  render(<MemoryRouter><ConversationPage target={target} client={client} conversationId="c"/></MemoryRouter>);
  await act(async () => {});
  group.mockClear();
  for (let seq = 2; seq <= 11; seq++) await act(async () => {
    target.applyPatch({ type: 'patch', from_seq: seq - 1, seq, generation: 1, changes: {
      messages: { remove: [], upsert: [{ id: 'other', role: 'assistant', body: `Elsewhere ${seq}` }] },
      message_memberships: { remove: [], upsert: [{ id: 'elsewhere', message_id: 'other', conversation_id: 'other', active: 1 }] },
    } });
  });
  expect(group).not.toHaveBeenCalled();
  expect(screen.getByText('Latest message')).toBeTruthy();
  console.info('10 other-conversation message patches: timeline group builds 10 -> 0');
});

it('overlaps the initial window with snapshot transfer and displays it after generation validation', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const target = createStore();
  const { client } = createFixture();
  const fetchConversation = vi.fn(async (path: string): Promise<ConversationPageData> => {
    if (path.includes('edits=')) return { generation: 5, projection: {}, next: null };
    await new Promise(resolve => setTimeout(resolve, 100));
    return { generation: 5, projection: {
      messages: [{ id: 'm', role: 'assistant', body: 'Prefetched last message' }],
      message_memberships: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: 1 }],
    }, next: null };
  });
  setTimeout(() => target.setSnapshot({ seq: 1, generation: 5, projection: { conversations: [{ id: 'c', provider: 'codex' }] } }), 250);
  render(<MemoryRouter><ConversationPage target={target} client={{ ...client, fetchConversation }} conversationId="c"/></MemoryRouter>);
  expect(fetchConversation).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(screen.queryByText('Prefetched last message')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText('Prefetched last message')).toBeTruthy();
  expect(fetchConversation.mock.calls.filter(([path]) => !path.includes('edits='))).toHaveLength(1);
  expect(Date.now()).toBe(250);
  console.info('simulated snapshot 250 ms + window 100 ms: serial 350 ms -> parallel 250 ms; 1 window request');
});

it('refetches a prefetched window after a generation mismatch and aborts a switched conversation', async () => {
  const target = createStore();
  const { client } = createFixture();
  let generation = 4;
  const fetchConversation = vi.fn(async (path: string, signal: AbortSignal) => ({ generation, projection: {
    messages: [{ id: 'm', role: 'assistant', body: `Generation ${generation}` }],
    message_memberships: [{ id: 'link', message_id: 'm', conversation_id: new URL(path, 'http://localhost').searchParams.get('id'), active: 1 }],
  }, next: null }));
  const view = render(<MemoryRouter><ConversationPage target={target} client={{ ...client, fetchConversation }} conversationId="old"/></MemoryRouter>);
  await act(async () => {});
  const signal = fetchConversation.mock.calls[0][1];
  view.rerender(<MemoryRouter><ConversationPage target={target} client={{ ...client, fetchConversation }} conversationId="c"/></MemoryRouter>);
  await act(async () => {});
  expect(signal.aborted).toBe(true);
  generation = 5;
  await act(async () => target.setSnapshot({ seq: 1, generation, projection: { conversations: [{ id: 'c', provider: 'codex' }] } }));
  expect(screen.queryByText('Generation 4')).toBeNull();
  expect(screen.getByText('Generation 5')).toBeTruthy();
  expect(fetchConversation.mock.calls.filter(([path]) => path.includes('id=c') && !path.includes('edits='))).toHaveLength(2);
});

it('coalesces scroll geometry reads into one animation frame', async () => {
  vi.useFakeTimers();
  const { target, client } = createFixture();
  render(<MemoryRouter><ConversationPage target={target} client={client} conversationId="c"/></MemoryRouter>);
  await act(async () => {});
  const element = document.querySelector<HTMLElement>('.conv-timeline')!;
  const height = vi.fn(() => 1000), viewport = vi.fn(() => 300);
  Object.defineProperties(element, { scrollHeight: { configurable: true, get: height }, clientHeight: { configurable: true, get: viewport } });
  for (let i = 0; i < 20; i++) { fireEvent.scroll(element, { target: { scrollTop: 500 } }); fireEvent.wheel(element); }
  await act(async () => { vi.advanceTimersByTime(20); });
  expect(height).toHaveBeenCalledTimes(1);
  expect(viewport).toHaveBeenCalledTimes(1);
  console.info('20 scroll + wheel events in one frame: near-bottom geometry checks 40 -> 1');
});

it('reuses the early window when snapshot resolves the direct conversation workspace', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const target = createStore();
  const fixture = createFixture();
  const fetchConversation = vi.fn(async (path: string): Promise<ConversationPageData> => ({ generation: 1, next: null,
    projection: path.includes('edits=') ? {} : {
      messages: [{ id: 'early', role: 'assistant', body: 'Early window in resolved workspace' }],
      message_memberships: [{ id: 'early-link', message_id: 'early', conversation_id: 'c', active: 1 }],
    } }));
  const client = { ...fixture.client, fetchConversation };
  render(<MemoryRouter initialEntries={['/c/c']}><App target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  await act(async () => target.setSnapshot(fixture.target.getSnapshot()));
  expect(screen.getByText('Early window in resolved workspace')).toBeTruthy();
  expect(fetchConversation.mock.calls.filter(([path]) => !path.includes('edits='))).toHaveLength(1);
});

it('preserves Sending, Queued and the next draft while a conversation is hidden', async () => {
  const { target, client: base } = createFixture();
  const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
    conversations: [...snapshot.projection.conversations, { id: 'other', provider: 'codex', origin: 'managed', name: 'Other' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle' }],
  } });
  target.setConnection('connected');
  localStorage.setItem(workspaceKey('p', 'root'), JSON.stringify({ kind: 'pane', id: 'pane', active: 'a', tabs: [
    { id: 'a', kind: 'conversation', conversationId: 'c' }, { id: 'b', kind: 'conversation', conversationId: 'other' },
  ] }));
  let acknowledge!: (ack: Ack) => void;
  const client = { ...base, command: vi.fn((name: string, _payload?: unknown, _cmdId?: string): Promise<Ack> => name === 'send'
    ? new Promise(resolve => { acknowledge = resolve; }) : Promise.resolve({ type: 'ack', cmd_id: 'cmd', ok: true, result: [] })) };
  render(<MemoryRouter><WorkspacePage project="p" target={target} client={client} showRootList={false} panelVisible={false}/></MemoryRouter>);
  await act(async () => {});
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'Send this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(document.querySelector('.message [role="status"]')?.textContent?.trim()).toBe('Sending');
  fireEvent.change(input, { target: { value: 'Keep the next draft' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Other' }));
  await act(async () => acknowledge({ type: 'ack', cmd_id: 'send', ok: true }));
  const group = vi.spyOn(timeline, 'groupToolRuns');
  await act(async () => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 1, changes: {
    roots: { remove: [], upsert: [{ ...snapshot.projection.roots[0], user_name: 'Renamed work' }] },
    conversations: { remove: [], upsert: [{ ...snapshot.projection.conversations[0], pending_inputs: [{ id: 'queued', body: 'Send this' }] }] },
    runs: { remove: [], upsert: [{ id: 'r', conversation_id: 'c', state: 'running', turn_started_ts: '2026-10-13T00:00:00Z' }] },
  } }));
  act(() => target.setSendWatches([{ id: client.command.mock.calls.find(([name]) => name === 'send')![2], conversation_id: 'c', body: 'Send this', queue_id: 'queued', decision: { display: 'Likely queued' } }]));
  const tab = screen.getByRole('tab', { name: 'Renamed work' });
  expect(tab.querySelector('[data-state="running"]')).toBeTruthy();
  expect(group).not.toHaveBeenCalled();
  fireEvent.click(tab);
  await act(async () => {});
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.getByText('Likely queued')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', 'Keep the next draft');
  expect(screen.getByRole('status', { name: 'Working' })).toBeTruthy();
  console.info('hidden send: acknowledgement, queued input, next draft and tab name/state are preserved without timeline grouping');
});
