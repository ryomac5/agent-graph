import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage, type ConversationClient } from '../src/pages/conversation/ConversationPage.tsx';
import { createStore, type Row } from '../src/lib/store.ts';
import type { Ack } from '../src/lib/client.ts';

afterEach(cleanup);
function setup({ provider = 'codex', origin = 'managed', status = 'idle', projection = {}, client: supplied }: {
  provider?: string; origin?: string; status?: string; projection?: Record<string, Row[]>; client?: ConversationClient;
} = {}) {
  const store = createStore();
  store.setSnapshot({ seq: 1, generation: 0, projection: {
    conversations: [{ id: 'c', name: 'Build console', provider, origin, history_format: provider === 'codex' ? 'legacy' : 'jsonl' }],
    runs: [{ id: 'r', conversation_id: 'c', generation: 1, state: status, started_ts: '2026-10-07T00:00:00Z',
      launch: { cwd: '/workspace/demo', model: { model: 'model-a', effort: 'medium' } } }],
    messages: [], message_memberships: [], ...projection,
  } });
  store.setConnection('connected');
  const command = vi.fn(async (command: string): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: true,
    result: command === 'list_models' ? [{ model: 'model-a', displayName: 'Model A', effort: 'medium' }, { model: 'model-b', displayName: 'Model B', effort: 'low' }] : {} }));
  const client = supplied ?? { command };
  render(<MemoryRouter initialEntries={['/c/c']}><ConversationPage conversationId="c" target={store} client={client}/></MemoryRouter>);
  return { store, command };
}
async function waitModels() { await screen.findByRole('option', { name: 'Model B' }); }

it('bundles delta chunks per message, scopes them, and replaces streaming text with a completed fact', async () => {
  const { store } = setup();
  await waitModels();
  act(() => {
    store.appendDelta({ runId: 'r', conversationId: 'c', messageId: 'm', text: 'Hello ' });
    store.appendDelta({ runId: 'r', conversationId: 'c', messageId: 'm', text: '**world**' });
    store.appendDelta({ runId: 'other', conversationId: 'other', text: 'Wrong conversation' });
  });
  expect(screen.getByText('world').tagName).toBe('STRONG');
  expect(screen.getAllByText('Streaming')).toHaveLength(1);
  expect(screen.queryByText('Wrong conversation')).toBeNull();
  act(() => store.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    messages: { upsert: [{ id: 'm', role: 'assistant', body: 'Completed reply', body_state: 'stored' }], remove: [] },
    message_memberships: { upsert: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: 1 }], remove: [] },
  } }));
  expect(screen.queryByText('Streaming')).toBeNull();
  expect(screen.getAllByText('Completed reply')).toHaveLength(1);
});

it('shows exactly ten initial lines and expands and collapses the complete message', async () => {
  setup({ projection: { messages: [{ id: 'm', role: 'assistant', body: Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n') }],
    message_memberships: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: true }] } });
  await waitModels();
  expect(screen.getByText('Line 10')).toBeTruthy();
  expect(screen.queryByText('Line 11')).toBeNull();
  const expand = screen.getByRole('button', { name: 'Show full message' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(expand);
  expect(screen.getByText('Line 12')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show first 10 lines' }));
  expect(screen.queryByText('Line 12')).toBeNull();
});

it('renders chronological messages, tool calls, provenance, approval requests, boundaries and gaps', async () => {
  setup({ projection: {
    messages: [{ id: 'second', role: 'assistant', source_ts: '2026-10-07T00:00:04Z', body: 'Second' },
      { id: 'first', role: 'assistant', source_ts: '2026-10-07T00:00:01Z', source: 'host-claude', confidence: 'confirmed',
        body: [{ type: 'text', text: '# Plan\n**Read** `file.ts`\n```ts\nconst value = 1;\n```\n<script>unsafe()</script>\n[unsafe](javascript:alert(1))' },
          { type: 'tool_use', id: 'tool1', name: 'Bash', input: { command: 'pwd' } }] }],
    message_memberships: ['first', 'second'].map(id => ({ id, message_id: id, conversation_id: 'c', active: 1 })),
    approvals: [{ id: 'a', run_id: 'r', state: 'pending', available_decisions: ['accept'], source_ts: '2026-10-07T00:00:03Z', request: { command: 'touch file' } }],
    relations: ['continued', 'forked', 'compacted'].map((type, index) => ({ id: type, type, from_id: 'parent', to_id: 'c', active: 1, confidence: 'inferred', evidence: { timestamp: `2026-10-07T00:00:0${index + 5}Z` } })),
    observation_gaps: [{ id: 'g', conversation_id: 'c', from_ts: '00:00', to_ts: '00:01', reason: 'History unavailable' }],
  } });
  await waitModels();
  const articles = screen.getAllByRole('article');
  expect(articles[0]!.textContent).toContain('Plan');
  expect(articles[1]!.textContent).toContain('Approval request');
  expect(articles[2]!.textContent).toContain('Second');
  expect(within(articles[0]!).getByText('Claude host')).toBeTruthy();
  expect(within(articles[0]!).getByText('confirmed')).toBeTruthy();
  expect(within(articles[0]!).getByTitle('Source: host-claude · Confidence: confirmed')).toBeTruthy();
  expect(screen.getByText('const value = 1;').tagName).toBe('CODE');
  const tool = screen.getByText('Bash').closest('details')!;
  expect(tool.open).toBe(false);
  expect(within(tool).getByText('pwd', { selector: '.tool-summary' })).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(screen.getAllByRole('separator')).toHaveLength(4);
  expect(screen.getByText(/Continuation ·/).className).toContain('inferred');
  expect(screen.getByText(/Missing messages:/).textContent).toContain('00:00 – 00:01');
});

it('answers with the exact approval ID and offered decision; expired requests have no answer buttons', async () => {
  const { command } = setup({ status: 'waiting_approval', provider: 'claude', projection: { approvals: [
    { id: 'approval-id', run_id: 'r', state: 'pending', available_decisions: ['allow', 'deny'], request: { name: 'Write' } },
    { id: 'expired', run_id: 'r', state: 'expired', available_decisions: ['old-decision'] },
  ] } });
  await waitModels();
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('answer', { approvalId: 'approval-id', decision: 'deny' }));
  expect(screen.queryByRole('button', { name: 'Old decision' })).toBeNull();
});

it('interrupts the current run and never chooses an older generation', async () => {
  const { command } = setup({ provider: 'claude', status: 'running', projection: { runs: [
    { id: 'old', conversation_id: 'c', generation: 1, state: 'running' },
    { id: 'new', conversation_id: 'c', generation: 2, state: 'running' },
  ] } });
  await waitModels();
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('interrupt', { runId: 'new' }));
});

it('loads models from runner and sends model and effort using set_model', async () => {
  const { command } = setup();
  await waitModels();
  expect(command).toHaveBeenCalledWith('list_models', { provider: 'codex' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'model-b' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply model and effort' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('set_model', { runId: 'r', model: { model: 'model-b', effort: 'high' } }));
  expect(screen.getByText('Codex model and effort changes apply from the next turn.')).toBeTruthy();
});

it('hides Codex model and effort changes and blocks sending during an active turn', async () => {
  const { command } = setup({ status: 'running' });
  await waitFor(() => expect(command).toHaveBeenCalledWith('list_models', { provider: 'codex' }));
  expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply model and effort' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Codex controls are available after the active turn ends.')).toBeTruthy();
});

it('sends only on Cmd+Enter, preserves newlines on Enter and rejects composing input', async () => {
  const { command } = setup({ provider: 'claude', status: 'running' });
  await waitModels();
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'Read this\nthen respond' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true, isComposing: true });
  expect(command.mock.calls.some(call => call[0] === 'send')).toBe(false);
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  await waitFor(() => expect(command).toHaveBeenCalledWith('send', { runId: 'r', input: { text: 'Read this\nthen respond' } }));
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
});

it('branches with an explicit model, cwd and input', async () => {
  const { command } = setup();
  await waitModels();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Try another approach' } });
  fireEvent.click(screen.getByRole('button', { name: 'Branch conversation' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('fork', { conversationId: 'c', cwd: '/workspace/demo',
    model: { model: 'model-a', effort: 'medium' }, input: { text: 'Try another approach' } }));
});

it.each([true, false])('keeps external conversations read-only and confirms terminal stopped=%s only when requested', async confirmStopped => {
  const command = vi.fn(async (name: string, payload?: unknown): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: true,
    result: name === 'list_models' ? [{ model: 'model-a', displayName: 'Model A' }, { model: 'model-b', displayName: 'Model B' }]
      : name === 'adopt' && !Object.hasOwn(payload as object, 'confirmStopped') ? { confirmation_required: true, fallback: 'fork' }
      : { conversationId: 'adopted', operation: confirmStopped ? 'resume' : 'fork' } }));
  setup({ origin: 'observed', status: 'unknown', client: { command } });
  await waitModels();
  expect(screen.getByText('External conversation · Read-only')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).readOnly).toBe(true);
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Interrupt' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Apply model and effort' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
  expect(command.mock.calls.some(call => call[0] === 'send')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Take over conversation' }));
  const dialog = await screen.findByRole('dialog', { name: 'Have you stopped the external terminal?' });
  fireEvent.click(within(dialog).getByRole('button', { name: confirmStopped ? 'Yes, resume here' : 'No, continue in a branch' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('adopt', { conversationId: 'c', cwd: '/workspace/demo',
    model: { model: 'model-a', effort: 'medium' }, input: { text: '' }, confirmStopped }));
  expect((await screen.findByRole('link', { name: 'Conversation: adopted' })).getAttribute('href')).toBe('/c/adopted');
});

it('shows unknown reason, last evidence, timestamp and a dashed state with evidence access', async () => {
  setup({ projection: { runs: [{ id: 'r', conversation_id: 'c', generation: 1, state: 'unknown', reason: 'Process check denied',
    last_evidence: { kind: 'disconnect' }, last_evidence_ts: '2026-10-07T01:23:00Z' }] } });
  await waitModels();
  const status = screen.getByRole('link', { name: 'Unknown · Evidence' });
  expect(status.className).toContain('status-unknown');
  expect(status.textContent).toContain('Process check denied');
  expect(status.textContent).toContain('disconnect');
  expect(status.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-07T01:23:00Z');
  expect(status.getAttribute('href')).toBe('#conversation-evidence');
});

it('preserves input on failed acknowledgements and disables commands while disconnected', async () => {
  const command = vi.fn(async (name: string): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: name === 'list_models',
    result: [{ model: 'model-b', displayName: 'Model B' }], error: 'Runner unavailable' }));
  const { store } = setup({ client: { command } });
  await waitModels();
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'Keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Runner unavailable');
  expect((input as HTMLTextAreaElement).value).toBe('Keep me');
  act(() => store.setConnection('reconnecting'));
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});

it('blocks handoff for unsupported formats and marks absent message bodies as unavailable', async () => {
  setup({ origin: 'observed', projection: {
    conversations: [{ id: 'c', provider: 'codex', origin: 'observed', history_format: 'future-format' }],
    messages: [{ id: 'missing', role: 'assistant', body_state: 'unavailable' }],
    message_memberships: [{ id: 'link', message_id: 'missing', conversation_id: 'c', active: true }],
  } });
  await waitModels();
  expect(screen.getByText('Unsupported history format; handoff unavailable')).toBeTruthy();
  expect(screen.getByText('Message unavailable')).toBeTruthy();
  expect(screen.getByRole('separator').textContent).toContain('missing – missing');
  expect((screen.getByRole('button', { name: 'Take over conversation' }) as HTMLButtonElement).disabled).toBe(true);
});

it('decodes SQLite JSON columns from real snapshot rows for tool content and approval decisions', async () => {
  const { command } = setup({ provider: 'claude', status: 'waiting_approval', projection: {
    messages: [{ id: 'm', role: 'assistant', body: JSON.stringify([{ type: 'text', text: 'Decoded message' },
      { type: 'tool_use', id: 'tool', name: 'Write', input: { file_path: 'demo.ts' } }]), tool_output: null }],
    message_memberships: [{ id: 'link', message_id: 'm', conversation_id: 'c', active: 1 }],
    approvals: [{ id: 'a', run_id: 'r', state: 'pending', available_decisions: JSON.stringify(['allow', 'deny']), request: JSON.stringify({ name: 'Write', input: { file_path: 'demo.ts' } }) }],
    relations: [{ id: 'boundary', from_id: 'other', to_id: 'c', type: 'compacted', active: 1, confidence: 'confirmed', evidence: JSON.stringify({ timestamp: '2026-10-07T00:00:01Z' }) }],
  } });
  await waitModels();
  expect(screen.getByText('Decoded message')).toBeTruthy();
  expect(within(screen.getByText('Write', { selector: '.tool-call .tool-name' }).closest('details')!).getByText('demo.ts', { selector: '.tool-summary' })).toBeTruthy();
  expect(screen.getByRole('separator').querySelector('time')?.getAttribute('datetime')).toBe('2026-10-07T00:00:01Z');
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('answer', { approvalId: 'a', decision: 'allow' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement).disabled).toBe(true));
});

it('takes over an external conversation without a confirmation dialog when runner has stop evidence', async () => {
  const command = vi.fn(async (name: string): Promise<Ack> => ({ type: 'ack', cmd_id: 'cmd', ok: true,
    result: name === 'list_models' ? [{ model: 'model-b', displayName: 'Model B' }] : { conversationId: 'c', operation: 'resume' } }));
  setup({ origin: 'observed', status: 'ended', client: { command } });
  await waitModels();
  fireEvent.click(screen.getByRole('button', { name: 'Take over conversation' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith('adopt', { conversationId: 'c', cwd: '/workspace/demo', model: { model: 'model-a', effort: 'medium' }, input: { text: '' } }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('allows launch configuration for an external running Codex conversation without offering live mutation', async () => {
  setup({ origin: 'observed', status: 'running' });
  await waitModels();
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Apply model and effort' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Take over conversation' }) as HTMLButtonElement).disabled).toBe(false);
});

it('does not apply an old command response to a different conversation', async () => {
  const store = createStore();
  store.setSnapshot({ seq: 1, generation: 0, projection: {
    conversations: ['c', 'd'].map(id => ({ id, name: id, provider: 'claude', origin: 'managed', history_format: 'jsonl' })),
    runs: ['c', 'd'].map(id => ({ id: `run-${id}`, conversation_id: id, generation: 1, state: 'idle' })),
  } });
  store.setConnection('connected');
  let resolve!: (ack: Ack) => void;
  const client: ConversationClient = { command: async name => name === 'list_models'
    ? { type: 'ack', cmd_id: 'models', ok: true, result: [{ model: 'model-b', displayName: 'Model B' }] }
    : new Promise(done => { resolve = done; }) };
  const view = render(<MemoryRouter><ConversationPage client={client} target={store} conversationId="c"/></MemoryRouter>);
  await waitModels();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Old message' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  view.rerender(<MemoryRouter><ConversationPage client={client} target={store} conversationId="d"/></MemoryRouter>);
  await waitModels();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'New message' } });
  await act(async () => resolve({ type: 'ack', cmd_id: 'old', ok: false, error: 'Old error' }));
  expect(screen.queryByText('Old error')).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('New message');
});
