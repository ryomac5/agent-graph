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
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  const view = render(<Message row={row} sender={sender} delegationNode={() => node('running')} onSelectChild={select}/>);
  const calls = renderMarkdown.mock.calls.length;
  view.rerender(<Message row={row} sender={sender} delegationNode={() => node('running')} onSelectChild={select}/>);
  expect(renderMarkdown).toHaveBeenCalledTimes(calls);
  view.rerender(<Message row={row} sender={sender} delegationNode={() => node('ended')} onSelectChild={select}/>);
  expect(renderMarkdown.mock.calls.length).toBeGreaterThan(calls);
  fireEvent.click(screen.getByRole('button', { name: /Child task/ }));
  expect(select).toHaveBeenCalledWith('child');
});
