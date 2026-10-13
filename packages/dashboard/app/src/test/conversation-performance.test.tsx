import { Profiler } from 'react';
import * as rootModel from '../lib/roots.ts';
import * as noticeModel from '../components/notifications/model.ts';
import { RootList } from '../components/RootViews.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { Notifications } from '../components/notifications/Notifications.tsx';
import { useDelegationNodes } from '../components/conversation/DelegationCard.tsx';
import { useToolResults } from '../components/conversation/ToolCall.tsx';
import type { Row } from '../lib/store.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { createStore, useScreenStore } from '../lib/store.ts';
import { OpenWorkspaceConversation } from '../lib/workspace-context.ts';
import { compareMessages } from '../lib/projection-client.ts';
import { selectTimeline } from '../components/conversation/model.ts';
import { Message } from '../components/conversation/Message.tsx';
import type { TreeNode } from '../pages/tree/model.ts';

const { renderMarkdown } = vi.hoisted(() => ({ renderMarkdown: vi.fn() }));
vi.mock('../components/conversation/Markdown.tsx', () => ({ Markdown: ({ text }: { text: string }) => {
  renderMarkdown(text);
  return <span>{text}</span>;
} }));
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('does not render unchanged messages on clock ticks or unrelated websocket patches', async () => {
  vi.useFakeTimers(); renderMarkdown.mockClear();
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, identities: { conversations: {}, runs: {} }, projection: {
    conversations: [{ id: 'c', provider: 'codex', origin: 'managed' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle' }],
    messages: [{ id: 'm', role: 'assistant', body: 'Unchanged', source_ts: '2026-10-13T00:00:00Z' }],
    message_memberships: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: 1 }],
  } });
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })),
    fetchConversation: vi.fn(async () => ({ generation: 0, projection: {}, next: null })) };
  function Workspace() {
    useScreenStore(target);
    return <OpenWorkspaceConversation.Provider value={() => false}>
      <ConversationPage conversationId="c" target={target} client={client}/>
    </OpenWorkspaceConversation.Provider>;
  }
  render(<MemoryRouter><Workspace/></MemoryRouter>);
  await act(async () => {});
  const initial = renderMarkdown.mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  for (let seq = 2; seq < 6; seq++) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
      target.applyPatch({ type: 'patch', from_seq: seq - 1, seq, generation: 0,
        changes: { runs: { remove: [], upsert: [
          { id: 'r', conversation_id: 'c', state: 'idle', last_evidence_ts: String(seq) },
          { id: 'other', conversation_id: 'elsewhere', state: 'running', last_evidence_ts: String(seq) },
        ] } } });
    });
  }
  expect(renderMarkdown.mock.calls).toHaveLength(initial);
  await act(async () => {
    target.applyPatch({ type: 'patch', from_seq: 5, seq: 6, generation: 0,
      changes: { messages: { remove: [], upsert: [{ id: 'm', role: 'assistant', body: 'Changed' }] } } });
  });
  expect(screen.getByText('Changed')).toBeTruthy();
  expect(renderMarkdown.mock.calls.length).toBeGreaterThan(initial);
});

it.each(['detached', 'moved'])('pages to the oldest message and stops when the cursor message is %s', async mode => {
  renderMarkdown.mockClear();
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    conversations: [{ id: 'c', provider: 'codex', origin: 'managed' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle' }],
  } });
  let rows = Array.from({ length: 450 }, (_, index) => ({ id: `m${index}`, role: 'assistant', body: `Body ${index}`,
    source_ts: '2026-10-13T00:00:00Z', source_event_id: `line:${index}` }));
  const membership = (id: string, active = 1) => ({ id: `link:${id}`, message_id: id, conversation_id: 'c', active });
  const fetchConversation = vi.fn(async (path: string) => {
    const params = new URL(path, 'http://localhost').searchParams;
    if (params.has('edits')) return { generation: 0, projection: { messages: [], message_memberships: [] }, next: null };
    const before = params.get('before');
    const cursor = before ? JSON.parse(before) : undefined;
    const preceding = rows.toSorted(compareMessages).filter(row => !cursor || compareMessages(row, cursor) < 0);
    const messages = preceding.slice(-200);
    const first = messages[0];
    return { generation: 0, projection: { messages, message_memberships: messages.map(row => membership(row.id)) },
      next: null, hasOlder: preceding.length > 200,
      olderCursor: first ? { source_ts: first.source_ts, source_event_id: first.source_event_id, id: first.id } : null };
  });
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })), fetchConversation };
  function Workspace() {
    useScreenStore(target);
    return <ConversationPage conversationId="c" target={target} client={client}/>;
  }
  render(<MemoryRouter><Workspace/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByText('Body 250')).toBeTruthy();
  await act(async () => {
    if (mode === 'detached') {
      rows = rows.filter(row => row.id !== 'm250');
      target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0,
        changes: { message_memberships: { remove: [], upsert: [membership('m250', 0)] } } });
    } else {
      rows = rows.map(row => row.id === 'm250' ? { ...row, source_ts: '2026-10-12T00:00:00Z' } : row);
      target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0,
        changes: { messages: { remove: [], upsert: [rows.find(row => row.id === 'm250')!] } } });
    }
  });
  const timeline = document.querySelector('.conv-timeline')!;
  for (let index = 0; index < 4; index++) await act(async () => { fireEvent.scroll(timeline, { target: { scrollTop: 0 } }); });
  const windows = fetchConversation.mock.calls.map(([path]) => new URL(path, 'http://localhost').searchParams)
    .filter(params => !params.has('edits'));
  expect(windows).toHaveLength(3);
  expect(JSON.parse(windows[1].get('before')!)).toEqual({ id: 'm250', source_ts: '2026-10-13T00:00:00Z', source_event_id: 'line:250' });
  expect(JSON.parse(windows[2].get('before')!).id).toBe('m50');
  expect(screen.getByText('Body 0')).toBeTruthy();
  const bodies = [...timeline.querySelectorAll('.message-bubble')].map(element => element.textContent).sort();
  expect(bodies).toEqual(Array.from({ length: 450 }, (_, index) => `Body ${index}`)
    .filter(body => mode !== 'detached' || body !== 'Body 250').sort());
  for (let index = 252; index < 450; index++) expect(renderMarkdown.mock.calls.filter(([text]) => text === `Body ${index}`)).toHaveLength(1);
  console.info(`history ${mode}: 198 unchanged messages each render once across 3 windows`);
  const calls = fetchConversation.mock.calls.length;
  await act(async () => { fireEvent.scroll(timeline, { target: { scrollTop: 0 } }); });
  expect(fetchConversation).toHaveBeenCalledTimes(calls);
});

it('reuses decoded rows and compares a 200-message window without serializing unchanged rows', () => {
  renderMarkdown.mockClear();
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    messages: Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, role: 'assistant', body: JSON.stringify(`Body ${index}`) })),
    message_memberships: Array.from({ length: 200 }, (_, index) => ({ id: `link${index}`, message_id: `m${index}`, conversation_id: 'c', active: 1 })),
  } });
  const initial = selectTimeline(target.getSnapshot(), 'c');
  function Messages() {
    return selectTimeline(target.getSnapshot(), 'c').map(entry => <Message key={entry.key} row={entry.row}
      sender={{ key: 'assistant', name: 'Codex', side: 'start' }}/>);
  }
  const view = render(<Messages/>);
  expect(renderMarkdown).toHaveBeenCalledTimes(200);
  target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0,
    changes: { messages: { remove: [], upsert: [{ id: 'm199', role: 'assistant', body: '"Changed"' }] } } });
  const updated = selectTimeline(target.getSnapshot(), 'c');
  for (let index = 0; index < 199; index++) expect(updated[index].row).toBe(initial[index].row);
  expect(updated[199].row).not.toBe(initial[199].row);
  const stringify = vi.spyOn(JSON, 'stringify');
  view.rerender(<Messages/>);
  expect(stringify).not.toHaveBeenCalled();
  expect(renderMarkdown).toHaveBeenCalledTimes(201);
  expect(screen.getByText('Changed')).toBeTruthy();
});

it('updates sending and queued indicators when only delivery_state changes', () => {
  const row = { id: 'pending', role: 'user', body: 'Request', delivery_state: 'sending' };
  const sender = { key: 'user', name: 'You', side: 'end' as const };
  const view = render(<Message row={row} sender={sender}/>);
  expect(screen.getByText('Sending…')).toBeTruthy();
  view.rerender(<Message row={{ ...row, delivery_state: 'queued' }} sender={sender}/>);
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.getByText('Queued — Claude will read this after the current step')).toBeTruthy();
  view.rerender(<Message row={{ ...row, delivery_state: 'delivered' }} sender={sender}/>);
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps delegation messages unchanged when rebuilt nodes have the same displayed fields', () => {
  renderMarkdown.mockClear();
  const row = { id: 'delegation', role: 'assistant', body: [
    { type: 'text', text: 'Delegating' }, { type: 'tool_use', id: 'tool', name: 'Agent', input: { description: 'Child task' } },
  ] };
  const sender = { key: 'assistant', name: 'Codex', side: 'start' as const };
  const select = vi.fn();
  const node = (state: string): TreeNode => ({ id: 'child', kind: 'conversation', label: 'Child', conversationId: 'child',
    provider: 'claude', state, role: 'child', model: '', attempts: [], children: [] });
  const view = render(<Message row={row} sender={sender} delegationNodes={new Map([[0, node('running')]])} onSelectChild={select}/>);
  const calls = renderMarkdown.mock.calls.length;
  view.rerender(<Message row={row} sender={sender} delegationNodes={new Map([[0, node('running')]])} onSelectChild={select}/>);
  expect(renderMarkdown).toHaveBeenCalledTimes(calls);
  view.rerender(<Message row={row} sender={sender} delegationNodes={new Map([[0, node('ended')]])} onSelectChild={select}/>);
  expect(renderMarkdown.mock.calls.length).toBeGreaterThan(calls);
  fireEvent.click(screen.getByRole('button', { name: /Child task/ }));
  expect(select).toHaveBeenCalledWith('child');
});

it('renders only the clock leaves over 30 seconds, including the workspace tab title', async () => {
  vi.useFakeTimers();
  const now = Date.parse('2026-10-13T00:00:10Z');
  vi.setSystemTime(now);
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    roots: [{ id: 'root', name: 'Clock test', state: 'running', conversation_ids: ['c'], project: 'p' }],
    conversations: [{ id: 'c', name: 'Clock test', provider: 'codex', origin: 'managed' }],
    runs: [{ id: 'run', conversation_id: 'c', state: 'running', turn_started_ts: '2026-10-13T00:00:00Z' }],
    messages: [{ id: 'message', role: 'assistant', body: 'Keep this message', source_ts: '2026-10-13T00:00:01Z' }],
    message_memberships: [{ id: 'link', message_id: 'message', conversation_id: 'c', active: 1 }],
  } });
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })),
    fetchConversation: vi.fn(async () => ({ generation: 1, projection: {}, next: null })) };
  const roots = rootModel.selectRoots(target.getSnapshot());
  const selectRoots = vi.spyOn(rootModel, 'selectRoots');
  const startedAt = vi.spyOn(rootModel, 'startedAt');
  const commits = vi.fn();
  render(<MemoryRouter><Profiler id="clocks" onRender={commits}>
    <RootList roots={roots} state={target.getSnapshot()}/>
    <Workbench project="clock" session="perf" conversationId="c" client={client} language="en"
      renderConversation={id => <ConversationPage conversationId={id} target={target} client={client}/>}/>
  </Profiler></MemoryRouter>);
  await act(async () => {});
  selectRoots.mockClear(); startedAt.mockClear(); renderMarkdown.mockClear(); commits.mockClear();
  for (let i = 0; i < 30; i++) await act(async () => { vi.advanceTimersByTime(1000); });
  expect(commits).toHaveBeenCalledTimes(30);
  expect(selectRoots).not.toHaveBeenCalled();
  expect(startedAt).not.toHaveBeenCalled();
  expect(renderMarkdown).not.toHaveBeenCalled();
  expect(screen.getByRole('timer').textContent).toContain('40s');
  expect(screen.getByLabelText('Elapsed time').textContent).toBe('40s');
  expect(screen.getByRole('tab', { name: 'Clock test' }).title).toContain('40s');
  console.info('30 ticks: conversation calculations 30 -> 0, sidebar calculations 30 -> 0; clock commits 30');
});

it('skips unrelated and identical patches but refreshes changed messages and delegation cards', async () => {
  renderMarkdown.mockClear();
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, identities: { conversations: {}, runs: {} }, projection: {
    conversations: [{ id: 'c', provider: 'codex', origin: 'managed' }, { id: 'child', provider: 'claude' }],
    runs: [{ id: 'run', conversation_id: 'c', state: 'idle' }, { id: 'child-run', conversation_id: 'child', state: 'running' }],
    relations: [{ id: 'rel', type: 'delegated', from_id: 'c', to_id: 'child', active: 1, evidence: { tool_use_id: 'tool' } }],
    messages: [{ id: 'm', role: 'assistant', body: [{ type: 'text', text: 'Delegating once' },
      { type: 'tool_use', id: 'tool', name: 'Agent', input: { description: 'Review work' } }] }],
    message_memberships: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: 1 }],
  } });
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })),
    fetchConversation: vi.fn(async () => ({ generation: 1, projection: {}, next: null })) };
  const conversationCommits = vi.fn();
  const noticeCommits = vi.fn();
  render(<MemoryRouter><Profiler id="conversation" onRender={conversationCommits}><ConversationPage target={target} client={client} conversationId="c"/></Profiler>
    <Profiler id="notices" onRender={noticeCommits}><Notifications target={target} client={client}/></Profiler></MemoryRouter>);
  await act(async () => {});
  const collect = vi.spyOn(noticeModel, 'collectNotifications');
  const buildTree = vi.spyOn(rootModel, 'buildRootTree');
  conversationCommits.mockClear(); noticeCommits.mockClear(); renderMarkdown.mockClear();
  const before = target.getSnapshot();
  for (let seq = 2; seq <= 10; seq++) await act(async () => {
    target.applyPatch({ type: 'patch', generation: 1, seq, from_seq: seq - 1, identities: { conversations: {}, runs: {} }, changes: {
      findings: { upsert: [{ id: 'unrelated', revision: seq }], remove: [] },
      messages: { upsert: JSON.parse(JSON.stringify(before.projection.messages)), remove: [] },
      runs: { upsert: JSON.parse(JSON.stringify(before.projection.runs)), remove: [] },
    } });
  });
  expect(target.getSnapshot().projection.messages).toBe(before.projection.messages);
  expect(target.getSnapshot().projection.runs).toBe(before.projection.runs);
  expect(target.getSnapshot().identities).toBe(before.identities);
  expect(conversationCommits).not.toHaveBeenCalled(); expect(noticeCommits).not.toHaveBeenCalled();
  expect(collect).not.toHaveBeenCalled(); expect(buildTree).not.toHaveBeenCalled(); expect(renderMarkdown).not.toHaveBeenCalled();
  await act(async () => { target.applyPatch({ type: 'patch', generation: 1, from_seq: 10, seq: 11, changes: {
    runs: { upsert: [{ id: 'child-run', conversation_id: 'child', state: 'ended' }], remove: [] },
  } }); });
  expect(screen.getByRole('button', { name: /Review work/ }).querySelector('[data-state="ended"]')).toBeTruthy();
  expect(renderMarkdown).toHaveBeenCalledTimes(1);
  expect(buildTree).toHaveBeenCalledTimes(1);
  await act(async () => { target.applyPatch({ type: 'patch', generation: 1, from_seq: 11, seq: 12, changes: {
    messages: { upsert: [{ id: 'm', role: 'assistant', body: 'Updated content' }], remove: [] },
  } }); });
  expect(screen.getByText('Updated content')).toBeTruthy();
  console.info('9 unrelated/no-op patches: conversation commits 9 -> 0, notification effects 9 -> 0, tree builds 0');
});

it.each([0, 3])('waits for snapshot generation %s and fetches each history window once', async generation => {
  const target = createStore();
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })),
    fetchConversation: vi.fn(async (_path: string) => ({ generation, projection: {}, next: null })) };
  render(<MemoryRouter><ConversationPage target={target} client={client} conversationId="c"/></MemoryRouter>);
  await act(async () => {});
  expect(client.fetchConversation).not.toHaveBeenCalled();
  await act(async () => { target.setSnapshot({ seq: 1, generation, projection: { conversations: [{ id: 'c', provider: 'codex' }] } }); });
  const windows = () => client.fetchConversation.mock.calls.filter(args => !String(args[0]).includes('edits='));
  expect(windows()).toHaveLength(1);
  await act(async () => { target.setConnection('connected'); });
  expect(windows()).toHaveLength(1);
  generation++;
  await act(async () => { target.setSnapshot({ seq: 2, generation, projection: { conversations: [{ id: 'c', provider: 'codex' }] } }); });
  expect(windows()).toHaveLength(2);
  console.info('initial history windows: 2 -> 1; fetches before snapshot: 0; resync adds exactly 1');
});

it('builds one delegation tree for 200 messages and none when those messages are compared again', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    conversations: [{ id: 'c' }, { id: 'child', provider: 'claude' }],
    relations: [{ id: 'rel', type: 'delegated', from_id: 'c', to_id: 'child', active: 1, evidence: { tool_use_id: 'tool' } }],
  } });
  const state = target.getSnapshot();
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: 'assistant', body: [
    { type: 'text', text: `Delegation ${i}` }, { type: 'tool_use', name: 'Agent', id: 'tool', input: { description: 'Child task' } },
  ] }));
  let resources: ReturnType<typeof useDelegationNodes>;
  function Messages() {
    const index = rootModel.useRootIndex(state);
    resources = useDelegationNodes('c', state, index);
    return rows.map(row => <Message key={row.id} row={row} sender={{ key: 'start', name: 'Claude', side: 'start' }} delegationNodes={resources(row)}/>);
  }
  const buildTree = vi.spyOn(rootModel, 'buildRootTree');
  renderMarkdown.mockClear();
  const view = render(<Messages/>);
  const first = resources!(rows[0]);
  expect(buildTree).toHaveBeenCalledTimes(1);
  expect(renderMarkdown).toHaveBeenCalledTimes(200);
  view.rerender(<Messages/>);
  expect(resources!(rows[0])).toBe(first);
  expect(buildTree).toHaveBeenCalledTimes(1);
  expect(renderMarkdown).toHaveBeenCalledTimes(200);
  console.info('200 delegation messages: tree builds 200 -> 1; unchanged comparison builds 400 -> 0; extra Markdown renders 0');
});

it('keeps tool result props stable when history gains only text and updates only the result owner', () => {
  const tool = { id: 'tool-message', role: 'assistant', body: [{ type: 'text', text: 'Tool owner' }, { type: 'tool_use', name: 'Bash', id: 'tool', input: {} }] };
  const result = { id: 'result', role: 'user', body: [{ type: 'tool_result', tool_use_id: 'tool', content: 'First result' }] };
  const unchanged = { id: 'text', role: 'assistant', body: 'Unchanged text' };
  let results: Map<string, unknown>;
  function Messages({ rows }: { rows: Row[] }) {
    results = useToolResults(rows);
    return rows.map(row => <Message key={String(row.id)} row={row} sender={{ key: 'start', name: 'Agent', side: 'start' }} toolResults={results}/>);
  }
  renderMarkdown.mockClear();
  const view = render(<Messages rows={[tool, result, unchanged]}/>);
  const original = results!;
  const earlier = { id: 'earlier', role: 'assistant', body: 'Earlier text' };
  renderMarkdown.mockClear();
  view.rerender(<Messages rows={[earlier, tool, result, unchanged]}/>);
  expect(results!).toBe(original);
  expect(renderMarkdown.mock.calls.map(([text]) => text)).toEqual(['Earlier text']);
  renderMarkdown.mockClear();
  view.rerender(<Messages rows={[earlier, tool, { ...result, body: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Second result' }] }, unchanged]}/>);
  expect(screen.getByText('Second result')).toBeTruthy();
  expect(renderMarkdown.mock.calls.map(([text]) => text)).toEqual(['Tool owner']);
  console.info('history prepend: unchanged Markdown renders 2 -> 0; result update: only its owner renders (1)');
});

it('keeps multiple delegation tools without ids distinct and refreshes their selected child', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    conversations: [{ id: 'c' }, { id: 'a', provider: 'claude' }, { id: 'b', provider: 'claude' }],
    relations: [{ id: 'ra', type: 'delegated', from_id: 'c', to_id: 'a', active: 1, evidence: { description: 'First child' } },
      { id: 'rb', type: 'delegated', from_id: 'c', to_id: 'b', active: 1, evidence: { description: 'Second child' } }],
  } });
  const row = { id: 'm', role: 'assistant', body: [
    { type: 'tool_use', name: 'Agent', input: { description: 'First child' } },
    { type: 'tool_use', name: 'Agent', input: { description: 'Second child' } },
  ] };
  const select = vi.fn();
  function Delegations() {
    const state = useScreenStore(target);
    const nodes = useDelegationNodes('c', state, rootModel.useRootIndex(state));
    return <Message row={row} sender={{ key: 'start', name: 'Agent', side: 'start' }} delegationNodes={nodes(row)} onSelectChild={select}/>;
  }
  render(<MemoryRouter><Delegations/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /First child/ }));
  fireEvent.click(screen.getByRole('button', { name: /Second child/ }));
  expect(select.mock.calls).toEqual([['a'], ['b']]);
  act(() => { target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 1, changes: {
    relations: { remove: ['ra'], upsert: [] },
  } }); });
  expect((screen.getByRole('button', { name: /First child/ }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: /Second child/ }) as HTMLButtonElement).disabled).toBe(false);
});
