import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore, type Row } from '../lib/store.ts';
import { HomePage } from '../pages/home/HomePage.tsx';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { SearchPage } from '../pages/search/SearchPage.tsx';
import { isTemporaryPath } from '../lib/projects.ts';
import { extractSnippet, type SearchResult } from '../pages/search/model.ts';
import { loadConversationWindow } from '../lib/projection-client.ts';

const CONVERSATION_COUNT = 10_000;
const NOW = new Date().toISOString();
const OLD = '2020-01-01T00:00:00.000Z';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function createLargeStore() {
  const target = createStore();
  const conversations: Row[] = [];
  const tasks: Row[] = [];
  const runs: Row[] = [];
  for (let index = 0; index < CONVERSATION_COUNT; index++) {
    const project = index % 3 === 0 ? 'registered-hash' : `unregistered-hash-${index}`;
    tasks.push({ id: `task-${index}`, name: `Task ${index}`, project });
    conversations.push({ id: `conversation-${index}`, task_id: `task-${index}`, name: `Task ${index}`, name_is_provisional: false, origin: 'observed', provider: 'codex',
      history_format: 'legacy', project, message_count: 10, last_message_excerpt: 'Saved message excerpt', last_message_ts: OLD });
    runs.push({ id: `run-${index}`, conversation_id: `conversation-${index}`, state: 'ended', generation: 1, ended_ts: OLD });
  }
  target.setSnapshot({ seq: 1, generation: 0, projection: { conversations, tasks, runs,
    projects: [{ id: 'registered-hash', display_name: 'Real project', root_path: '/projects/main', state: 'registered' },
      { id: 'hidden-hash', display_name: 'Old project', root_path: '/missing/repo', state: 'unregistered' }],
  } });
  return target;
}
it('uses only registered display names in the sidebar for ten thousand conversations', () => {
  render(<MemoryRouter><App target={createLargeStore()}/></MemoryRouter>);
  const sidebar = screen.getByRole('complementary');
  expect(within(sidebar).getByRole('navigation', { name: 'Projects' }).textContent).toBe('Real project');
  expect(within(sidebar).getByRole('link', { name: 'Other' })).toBeTruthy();
  expect(sidebar.textContent).not.toMatch(/hash|Old project/);
  expect(document.querySelectorAll('.activity-row').length).toBeLessThanOrEqual(200);
});
it('prioritizes running, waiting and recent activity, and loads older history fifty rows at a time', () => {
  const target = createLargeStore();
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    runs: { remove: [], upsert: [{ id: 'run-9999', conversation_id: 'conversation-9999', state: 'running' },
      { id: 'run-9998', conversation_id: 'conversation-9998', state: 'waiting_input' }] },
    conversations: { remove: [], upsert: [{ ...target.getSnapshot().projection.conversations[9997], last_message_ts: NOW }] },
  } }));
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  const history = screen.getByRole('region', { name: 'History' });
  expect(within(history).getAllByRole('article')).toHaveLength(50);
  for (const name of ['Task 9999', 'Task 9998', 'Task 9997']) expect(within(history).queryByRole('article', { name })).toBeNull();
  expect([...document.querySelectorAll('.activity-row')].slice(0, 2).map(row => row.getAttribute('aria-label')).sort()).toEqual(['Task 9998', 'Task 9999']);
  fireEvent.click(screen.getByRole('button', { name: 'Load more history' }));
  expect(within(history).getAllByRole('article')).toHaveLength(100);
});
it('limits even ten thousand recent conversations to two hundred rows on first render', () => {
  const target = createLargeStore();
  const state = target.getSnapshot();
  target.setSnapshot({ ...state, projection: { ...state.projection,
    conversations: state.projection.conversations.map(row => ({ ...row, last_message_ts: NOW })),
  } });
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  expect(document.querySelectorAll('.activity-row').length).toBeLessThanOrEqual(200);
  expect(screen.getByRole('button', { name: 'Show more recent activity' })).toBeTruthy();
});
it.each(['/tmp/test', '/private/tmp/test', '/var/folders/xx/test', '/private/var/folders/xx/test', '/Users/test/.cache/agent-graph/worktrees/test'])('hides temporary conversations under %s until requested', root => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'temporary', root_path: root, state: 'unregistered' }],
    conversations: [{ id: 'c', project: 'temporary', name: 'Temporary fixture', provider: 'codex', origin: 'observed' }],
  } });
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  expect(screen.queryByRole('article', { name: 'Temporary fixture' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show temporary' }));
  expect(screen.getByRole('article', { name: 'Temporary fixture' })).toBeTruthy();
  expect(isTemporaryPath('/tmp-project/main')).toBe(false);
});
it('keeps a worktree attached to its registered main project visible', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'main', display_name: 'Main', root_path: '/projects/main', state: 'registered' }],
    conversations: [{ id: 'c', project: 'main', name: 'Feature worktree', origin: 'observed' }],
    runs: [{ id: 'r', conversation_id: 'c', cwd: '/tmp/feature-worktree', state: 'unknown' }],
  } });
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  const row = screen.getByRole('article', { name: 'Feature worktree' });
  expect(row.textContent?.match(/Unknown/g)).toHaveLength(1);
  const badge = within(row).getByRole('link', { name: 'Unknown · Evidence' });
  expect([...badge.querySelectorAll('.state-detail')].map(detail => detail.textContent)).toEqual(['No evidence']);
  expect(badge.title).toBe('Unknown · No evidence confirming execution state');
});
function createConversationStore() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Product', root_path: '/projects/product', state: 'registered' }],
    tasks: [{ id: 't', name: 'Repair product', project: 'p' }],
    conversations: [{ id: 'c', task_id: 't', project: 'p', name: 'Product discussion', origin: 'observed', provider: 'codex', history_format: 'legacy' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'unknown', last_evidence: 'Run Unknown' }],
  } });
  return target;
}
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };
it('fetches conversation bodies, shows loading and displays the newest two hundred messages', async () => {
  const target = createConversationStore();
  const messages = Array.from({ length: 450 }, (_, index) => ({ id: `m${String(index).padStart(3, '0')}`,
    role: 'user', body: `Message ${index}`, body_state: 'stored', source_ts: new Date(Date.parse(OLD) + index * 1000).toISOString() }));
  const fetcher = vi.fn(async (url: URL) => {
    const after = url.searchParams.get('after') ?? '';
    const rows = messages.filter(row => row.id > after).slice(0, 200);
    return { ok: true, json: async () => ({ generation: 0, projection: { messages: rows,
      message_memberships: rows.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })) },
    next: rows.length === 200 ? rows.at(-1)!.id : null }) };
  });
  vi.stubGlobal('fetch', fetcher);
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  expect(screen.getByText('Loading messages…')).toBeTruthy();
  await screen.findByText('Message 449');
  expect(fetcher.mock.calls[0][0].pathname).toBe('/conversation');
  expect(fetcher.mock.calls[0][0].searchParams.get('id')).toBe('c');
  expect(screen.queryByText('Message 249')).toBeNull();
  expect(screen.getAllByRole('article', { name: 'User message' })).toHaveLength(200);
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
  await screen.findByText('Message 50');
  expect(screen.getAllByRole('article', { name: 'User message' })).toHaveLength(400);
});
it('shows a conversation fetch failure and retries successfully', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce({ ok: true,
    json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) }));
  render(<MemoryRouter><ConversationPage conversationId="c" target={createConversationStore()} client={client}/></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('503'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('loads metadata after the snapshot page without overwriting a newer live row', async () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Product', state: 'registered' }], conversations: [],
  }, pages: { conversations: { total: 2, next: 'c0' } } });
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    expect(url.pathname).toBe('/projection');
    expect(url.searchParams.get('table')).toBe('conversations');
    target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
      conversations: { remove: [], upsert: [{ id: 'c1', name: 'Live title', project: 'p' }] },
    } });
    return { ok: true, json: async () => ({ generation: 0, rows: [{ id: 'c1', name: 'Old title', project: 'p' },
      { id: 'c2', name: 'Second page', project: 'p' }], next: null }) };
  }));
  render(<MemoryRouter><App target={target}/></MemoryRouter>);
  await screen.findByRole('article', { name: 'Second page' });
  expect(screen.getByRole('article', { name: 'Live title' })).toBeTruthy();
  expect(screen.queryByRole('article', { name: 'Old title' })).toBeNull();
});
it('shows an unnamed conversation by provider and start time without fetching bodies to derive a name', async () => {
  const target = createConversationStore();
  const projection = target.getSnapshot().projection;
  const started = new Date(2026, 0, 5, 10, 46).toISOString();
  target.setSnapshot({ ...target.getSnapshot(), projection: { ...projection,
    tasks: [{ ...projection.tasks[0], name: 'Untitled task' }],
    conversations: [{ ...projection.conversations[0], name: null, name_is_provisional: false,
      first_request_excerpt: 'Fix the product.', last_message_excerpt: 'Latest assistant reply' }],
    runs: [{ ...projection.runs[0], started_ts: started }],
  } });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
  const row = screen.getByRole('article', { name: 'Codex · Jan 5 10:46' });
  expect(within(row).getByRole('link', { name: 'Codex · Jan 5 10:46' }).title).toBe('Fix the product.');
  expect(screen.queryByRole('article', { name: /Untitled task|Latest assistant reply|New conversation/ })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('loads the exact old search message with at most two hundred surrounding messages', async () => {
  const rows = Array.from({ length: 600 }, (_, index) => ({ id: `m${String(index).padStart(3, '0')}`,
    body: `Body ${index}`, role: 'user', source_ts: new Date(Date.parse(OLD) + index * 1000).toISOString() }));
  const page = await loadConversationWindow('c', new AbortController().signal, undefined, 'm250', async path => {
    const after = new URL(path, 'http://localhost').searchParams.get('after') ?? '';
    const messages = rows.filter(row => row.id > after).slice(0, 200);
    return { generation: 0, projection: { messages,
      message_memberships: messages.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })) },
    next: messages.length === 200 ? messages.at(-1)!.id : null };
  });
  expect(page.projection.messages).toHaveLength(200);
  expect(page.projection.messages.at(-1)?.id).toBe('m250');
  expect(page.projection.messages[0].id).toBe('m051');
  expect(page.hasOlder).toBe(true);
});
it('shows readable stale review approval text and a Changes link', () => {
  const target = createConversationStore();
  target.setSnapshot({ ...target.getSnapshot(), projection: { ...target.getSnapshot().projection,
    artifacts: [{ id: 'a', run_id: 'r', version: 2 }],
    approvals: [{ id: 'approval', artifact_id: 'a', run_id: 'r', state: 'stale', reason: 'artifact patch_hash changed' }],
  } });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  const card = screen.getByRole('article', { name: 'Approval request' });
  expect(card.textContent).toContain('The patch changed, so this approval no longer applies.');
  expect(card.textContent).not.toMatch(/patch_hash|artifact|Request content unavailable/);
  expect(within(card).getByRole('link', { name: 'Open Changes' }).getAttribute('href')).toBe('/p/p/changes?artifact=a');
});
it('uses readable search context, highlights a bounded excerpt, and links to Changes or the exact message', async () => {
  const result: SearchResult = { id: 'result', fact_id: 'f', subject: 'message:internal-hash', kind: 'message',
    body: 'Before\n'.repeat(100) + 'needle matches here\n' + 'after\n'.repeat(100), reason: null,
    conversation_id: 'c', run_id: 'r', message_id: 'm', project: 'p', provider: 'codex', source_ts: OLD, confidence: 'confirmed' };
  render(<MemoryRouter><SearchPage target={createConversationStore()} client={{ search: async () => ({ mode: 'fts5', total: 2,
    results: [result, { ...result, id: 'diff', kind: 'diff', subject: 'artifact:a', message_id: null }], unsupported: [] }) }}/></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Search all conversations'), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('2 results');
  const message = screen.getByRole('region', { name: 'Messages' });
  expect(message.textContent).toContain('Repair product');
  expect(message.textContent).toContain('Product discussion');
  expect(message.textContent).toContain('Product');
  expect(message.textContent).not.toContain('internal-hash');
  expect(message.querySelector('mark')?.textContent).toBe('needle');
  expect(within(message).getByRole('link').getAttribute('href')).toBe('/c/c#message-m');
  expect(within(screen.getByRole('region', { name: 'Diffs' })).getByRole('link').getAttribute('href')).toBe('/p/p/changes?artifact=a');
  expect(extractSnippet(result.body!, 'needle').map(part => part.text).join('').split('\n').length).toBeLessThanOrEqual(3);
});
