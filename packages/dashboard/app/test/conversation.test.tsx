import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage, type ConversationClient } from '../src/pages/conversation/ConversationPage.tsx';
import { createStore, type Row } from '../src/lib/store.ts';
import type { Ack } from '../src/lib/client.ts';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
  // 1 つの改行は改行として見せるので、10 行は 1 つの段落の中で br で区切られる。
  const shownLines = () => [...document.querySelector('.markdown-body p')!.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()).map(node => node.textContent);
  expect(shownLines()).toEqual(Array.from({ length: 10 }, (_, index) => `Line ${index + 1}`));
  expect(document.querySelectorAll('.markdown-body p br')).toHaveLength(9);
  const expand = screen.getByRole('button', { name: 'Show full message' });
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(expand);
  expect(shownLines().at(-1)).toBe('Line 12');
  fireEvent.click(screen.getByRole('button', { name: 'Show first 10 lines' }));
  expect(shownLines()).toHaveLength(10);
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
  expect(within(articles[0]!).getByRole('heading', { name: 'Plan' }).tagName).toBe('H3');
  expect(document.querySelector('.md-code code')!.textContent).toBe('const value = 1;');
  expect(document.querySelector('.md-code-language')!.textContent).toBe('TypeScript');
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
  expect(screen.queryByText('External conversation · Read-only')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(within(screen.getByRole('region', { name: 'Details' })).getByText('External conversation · Read-only')).toBeTruthy();
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
  expect((await screen.findByRole('link', { name: 'Open the new conversation' })).getAttribute('href')).toBe('/c/adopted');
});

it('shows unknown reason, last evidence, timestamp and a dashed state with evidence access', async () => {
  setup({ projection: { runs: [{ id: 'r', conversation_id: 'c', generation: 1, state: 'unknown', reason: 'Process check denied',
    last_evidence: { kind: 'disconnect' }, last_evidence_ts: '2026-10-07T01:23:00Z' }] } });
  await waitModels();
  const status = screen.getByRole('link', { name: 'Unknown · Evidence' });
  expect(status.className).toContain('status-unknown');
  // 見出しの印には理由を出さず、title と Details に置く。
  expect(status.textContent).not.toContain('Process check denied');
  expect(status.title).toContain('Process check denied');
  expect(status.getAttribute('href')).toBe('#conversation-details');
  expect(screen.queryByRole('region', { name: 'Details' })).toBeNull();
  // 状態の印を押すと Details が開き、根拠と時刻を見せる。
  fireEvent.click(status);
  const details = screen.getByRole('region', { name: 'Details' });
  expect(details.textContent).toContain('disconnect');
  expect(details.textContent).toContain('Process check denied');
  expect(details.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-07T01:23:00Z');
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

it('blocks handoff for unsupported formats only when asked and marks absent message bodies as unavailable', async () => {
  const { command } = setup({ origin: 'observed', projection: {
    conversations: [{ id: 'c', provider: 'codex', origin: 'observed', history_format: 'future-format' }],
    messages: [{ id: 'missing', role: 'assistant', body_state: 'unavailable' }],
    message_memberships: [{ id: 'link', message_id: 'missing', conversation_id: 'c', active: true }],
  } });
  await waitModels();
  // 読むだけのときは黄色の帯を出さない。形式は Details で分かる。
  expect(screen.queryByText('Unsupported history format; handoff unavailable')).toBeNull();
  expect(screen.getByText('Message unavailable')).toBeTruthy();
  expect(screen.getByRole('separator').textContent).toContain('missing – missing');
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(within(screen.getByRole('region', { name: 'Details' })).getByText('Handoff not supported')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Take over conversation' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Unsupported history format; handoff unavailable');
  expect(command.mock.calls.some(call => call[0] === 'adopt')).toBe(false);
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

const memberships = (ids: string[]) => ids.map(id => ({ id: `link-${id}`, message_id: id, conversation_id: 'c', active: 1 }));
const at = (second: number) => `2026-10-07T00:00:${String(second).padStart(2, '0')}Z`;

it('puts the user on the right and the agent on the left, naming each run of the same sender once', async () => {
  setup({ projection: {
    messages: [
      { id: 'u1', role: 'user', source_ts: at(1), body: 'Please list the files' },
      { id: 'a1', role: 'assistant', source_ts: at(2), body: 'Listing now' },
      { id: 'a2', role: 'assistant', source_ts: at(3), body: [{ type: 'text', text: 'Done' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
      { id: 'u2', role: 'user', source_ts: at(4), body: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'stray output' }] },
      { id: 'u3', role: 'user', source_ts: at(5), body: 'Thanks' },
    ],
    message_memberships: memberships(['u1', 'a1', 'a2', 'u2', 'u3']),
  } });
  await waitModels();
  const articles = screen.getAllByRole('article', { name: /message$/ });
  expect(articles.map(article => [article.getAttribute('aria-label'), article.dataset.side])).toEqual([
    ['User message', 'end'], ['Codex message', 'start'], ['Codex message', 'start'], ['Codex message', 'start'], ['User message', 'end']]);
  expect(articles.map(article => article.querySelector('.message-sender')?.textContent ?? null)).toEqual(['User', 'Codex', null, null, 'User']);
  // 名前を省いた発言にも時刻は出す。
  expect(articles.map(article => article.querySelector('time')?.getAttribute('datetime'))).toEqual([1, 2, 3, 4, 5].map(at));
  expect(articles[0]!.className).toContain('message-user');
  expect(articles[1]!.className).toContain('message-agent');
  // 道具の呼び出しは左の列の中に、1 行に畳んだ枠で出す。
  const tool = within(articles[2]!).getByText('ls', { selector: '.tool-summary' }).closest('details')!;
  expect(tool.open).toBe(false);
  expect(tool.closest('.message-main')).toBeTruthy();
});

it('shows the parent agent on the right in a child conversation', async () => {
  setup({ provider: 'codex', projection: {
    conversations: [
      { id: 'p', provider: 'claude', origin: 'managed', type: 'interactive', history_format: 'jsonl' },
      { id: 'c', provider: 'codex', origin: 'managed', type: 'subagent', history_format: 'paginated' },
    ],
    runs: [
      { id: 'p-run', conversation_id: 'p', generation: 1, state: 'running' },
      { id: 'r', conversation_id: 'c', generation: 1, state: 'idle', launch: { cwd: '/workspace/demo', model: { model: 'model-a' } } },
    ],
    relations: [{ id: 'edge', type: 'delegated', from_id: 'p-run', to_id: 'c', active: 1, confidence: 'confirmed', evidence: { request_id: 'req' } }],
    delegations: [{ id: 'd', request_id: 'req', role: 'implement', title: 'Build it' }],
    messages: [
      { id: 'u1', role: 'user', source_ts: at(1), body: 'Implement the parser' },
      { id: 'a1', role: 'assistant', source_ts: at(2), body: 'Working on it' },
    ],
    message_memberships: memberships(['u1', 'a1']),
  } });
  await waitModels();
  const parent = screen.getByRole('article', { name: 'Claude · root message' });
  expect(parent.dataset.side).toBe('end');
  expect(parent.querySelector('.message-sender')!.textContent).toBe('Claude · root');
  const child = screen.getByRole('article', { name: 'Codex · implement message' });
  expect(child.dataset.side).toBe('start');
  expect(screen.queryByRole('article', { name: 'User message' })).toBeNull();
});

it('names the parent of a review and of a subagent without a recorded relation', async () => {
  setup({ provider: 'claude', projection: {
    conversations: [
      { id: 'impl', provider: 'codex', origin: 'managed', history_format: 'paginated' },
      { id: 'c', provider: 'claude', origin: 'managed', type: 'subagent', history_format: 'jsonl' },
    ],
    relations: [{ id: 'edge', type: 'review_of', from_id: 'c', to_id: 'impl', active: 1, confidence: 'confirmed' }],
    messages: [{ id: 'u1', role: 'user', source_ts: at(1), body: 'Review this change' }],
    message_memberships: memberships(['u1']),
  } });
  await waitModels();
  expect(screen.getByRole('article', { name: 'Codex · root message' }).dataset.side).toBe('end');
  cleanup();
  setup({ provider: 'claude', projection: {
    conversations: [{ id: 'c', provider: 'claude', origin: 'managed', type: 'subagent', history_format: 'jsonl' }],
    messages: [{ id: 'u1', role: 'user', source_ts: at(1), body: 'Explore the repo' }, { id: 'a1', role: 'assistant', source_ts: at(2), body: 'Exploring' }],
    message_memberships: memberships(['u1', 'a1']),
  } });
  await waitModels();
  expect(screen.getByRole('article', { name: 'Parent agent message' }).dataset.side).toBe('end');
  expect(screen.getByRole('article', { name: 'Claude · subagent message' }).dataset.side).toBe('start');
});

it('keeps the header to the name, state, provider with model and elapsed time, and folds the rest into Details', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T00:01:05Z'));
  try {
    setup({ origin: 'observed', status: 'running', projection: {
      conversations: [{ id: 'c', name: 'Build console', provider: 'codex', origin: 'observed', history_format: 'future-format' }],
    } });
    await waitModels();
    const header = document.querySelector<HTMLElement>('.conv-header')!;
    const row = header.querySelector<HTMLElement>('.conv-title-row')!;
    expect(within(row).getByRole('heading', { name: 'Build console' })).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Running · Evidence' }).textContent).toContain('Elapsed 1m 5s');
    expect(within(row).getByText('Codex')).toBeTruthy();
    expect(within(row).getByText('model-a')).toBeTruthy();
    for (const noise of ['Effort', 'Worktree', 'Observation', 'Read-only', 'Unsupported', 'Handoff']) expect(header.textContent).not.toContain(noise);
    expect(screen.queryByText('Unsupported history format; handoff unavailable')).toBeNull();
    const toggle = within(row).getByRole('button', { name: 'Details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = screen.getByRole('region', { name: 'Details' });
    for (const label of ['Effort', 'Worktree', 'Observation coverage', 'Access', 'History format', 'Evidence']) expect(within(details).getByText(label)).toBeTruthy();
    expect(within(details).getByText('External conversation · Read-only')).toBeTruthy();
    expect(within(details).getByText('future-format')).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it('shows the model listing error only once the composer is used', async () => {
  const command = vi.fn(async (name: string): Promise<Ack> => name === 'list_models'
    ? { type: 'ack', cmd_id: 'models', ok: false, error: 'An open Claude query is required to list models' }
    : { type: 'ack', cmd_id: 'cmd', ok: true, result: {} });
  setup({ provider: 'claude', client: { command } });
  await waitFor(() => expect(command).toHaveBeenCalledWith('list_models', { provider: 'claude' }));
  await act(async () => {});
  expect(screen.queryByText('An open Claude query is required to list models')).toBeNull();
  fireEvent.focus(screen.getByRole('textbox', { name: 'Message' }));
  expect(screen.getByRole('alert').textContent).toBe('An open Claude query is required to list models');
});

it('titles the conversation with the projected name and never derives it from message bodies', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, next: null, projection: {
    conversations: [{ id: 'c', name: null, name_is_provisional: false, first_request_excerpt: 'Fix the product.', provider: 'codex' }],
    messages: [{ id: 'm', role: 'user', body: '<multi_agent_role>You are `/root`.</multi_agent_role>\n# タスク D1: 画面への配信を作る', source_ts: '2026-10-07T00:00:00Z' }],
    message_memberships: [{ id: 'l', message_id: 'm', conversation_id: 'c', active: 1 }] } }) })));
  const { store } = setup({ projection: { conversations: [{ id: 'c', name: null, name_is_provisional: false, provider: 'codex', origin: 'managed', history_format: 'legacy' }],
    runs: [{ id: 'r', conversation_id: 'c', generation: 1, state: 'idle', started_ts: new Date(2026, 0, 5, 10, 46).toISOString() }] } });
  expect(await screen.findByRole('heading', { name: 'Codex · Jan 5 10:46' })).toBeTruthy();
  await waitFor(() => expect(screen.getByText(/画面への配信を作る/)).toBeTruthy());
  // 本文の Markdown の見出しは本文の中に出る。会話の見出しは本文から導かない。
  expect(document.querySelector('.conv-title')?.textContent).toBe('Codex · Jan 5 10:46');
  expect(screen.queryByRole('heading', { name: /multi_agent_role/ })).toBeNull();
  expect(store.getSnapshot().projection.conversations.map(row => row.name)).toEqual([null]);
});
