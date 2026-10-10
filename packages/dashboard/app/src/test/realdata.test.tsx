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
import { compareMessages, loadConversationWindow } from '../lib/projection-client.ts';

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
  target.setSnapshot({ seq: 1, generation: 0, projection: { conversations, tasks, runs, roots: conversations.map((row, index) => ({ id: row.id, name: row.name, project: index % 3 === 0 ? 'registered-hash' : 'other', state: 'ended', last_activity_ts: OLD, conversation_ids: [String(row.id)], running_children: 0, total_children: 0 })),
    projects: [{ id: 'registered-hash', display_name: 'Real project', root_path: '/projects/main', state: 'registered' },
      { id: 'hidden-hash', display_name: 'Old project', root_path: '/missing/repo', state: 'unregistered' }],
  } });
  return target;
}
it('uses only registered display names in the sidebar for ten thousand conversations', () => {
  render(<MemoryRouter><App target={createLargeStore()}/></MemoryRouter>);
  const sidebar = screen.getByRole('complementary');
  // プロジェクトの行の名前だけを見る。選んだプロジェクトの下には、その会話の一覧も並ぶ。
  expect([...within(sidebar).getByRole('navigation', { name: 'Projects' }).querySelectorAll('.sidebar-project-row')].map(row => row.querySelector('a')?.textContent)).toEqual(['Real project', 'Other']);
  expect(within(sidebar).getByRole('link', { name: 'Other' })).toBeTruthy();
  expect(sidebar.textContent).not.toMatch(/hash|Old project/);
  expect(document.querySelectorAll('.activity-row').length).toBeLessThanOrEqual(200);
});
it('shows at most five roots per project with running roots first', () => {
 const target = createLargeStore(); const snapshot = target.getSnapshot();
 target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, roots: snapshot.projection.roots.map((row, index) => ({ ...row, state: index === 9999 ? 'running' : index === 9998 ? 'waiting_input' : 'ended', last_activity_ts: index === 9998 ? NOW : OLD })) } });
 render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
 // 登録外のプロジェクトの根は Other の 1 つの区画にまとめ、既定で畳んで件数だけを出す。
 const real = screen.getByRole('region', { name: 'Real project' }); const other = screen.getByRole('group', { name: 'Other' }) as HTMLDetailsElement;
 expect(document.querySelectorAll('[aria-label="Other"]')).toHaveLength(1); expect(other.open).toBe(false); expect(Number(other.querySelector('.column-count')!.textContent)).toBeGreaterThan(5);
 expect(other.querySelectorAll('.root-row')).toHaveLength(0); fireEvent.click(other.querySelector('summary')!);
 expect(real.querySelectorAll('.root-row')).toHaveLength(5); expect(other.querySelectorAll('.root-row')).toHaveLength(5);
 expect(real.querySelector('.root-row')!.textContent).toContain('Task 9999'); expect(other.querySelector('.root-row')!.textContent).toContain('Task 9998');
 expect(within(real).getByRole('link', { name: 'View all conversations' })).toBeTruthy();
});it('limits ten thousand projected roots to five per project on the overview', () => {
 render(<MemoryRouter><HomePage target={createLargeStore()}/></MemoryRouter>);
 expect(document.querySelectorAll('.root-row')).toHaveLength(5); expect(screen.getAllByRole('link', { name: 'View all conversations' })).toHaveLength(1);
});it.each(['/tmp/test', '/private/tmp/test', '/var/folders/xx/test', '/private/var/folders/xx/test', '/Users/test/.cache/agent-graph/worktrees/test'])('does not invent roots from conversations under %s', root => {
 const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'temporary', root_path: root, state: 'unregistered' }], conversations: [{ id: 'c', project: 'temporary', name: 'Temporary fixture', provider: 'codex', origin: 'observed' }], roots: [] } });
 render(<MemoryRouter><HomePage target={target}/></MemoryRouter>); expect(screen.queryByText('Temporary fixture')).toBeNull(); expect(screen.getByText('No conversations yet')).toBeTruthy(); expect(isTemporaryPath('/tmp-project/main')).toBe(false);
});it('keeps projected roots attached to their registered main project visible', () => {
 const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: {
 projects: [{ id: 'main', display_name: 'Main', root_path: '/projects/main', state: 'registered' }],
 roots: [{ id: 'c', name: 'Feature worktree', project: 'main', state: 'unknown', last_activity_ts: null, conversation_ids: ['c'], running_children: 0, total_children: 0 }],
 conversations: [{ id: 'c', project: 'main', origin: 'observed' }], runs: [{ id: 'r', conversation_id: 'c', cwd: '/tmp/feature-worktree', state: 'unknown' }] } });
 render(<MemoryRouter><HomePage target={target}/></MemoryRouter>); const row = within(screen.getByRole('region', { name: 'Main' })).getByRole('link', { name: /Feature worktree/ });
 expect(row.querySelector('.root-state')?.getAttribute('data-state')).toBe('unknown'); expect(row.textContent).not.toContain('Activity unknown');
});function createConversationStore() {
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
  fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
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
it('loads roots after the snapshot page without overwriting a newer live root', async () => {
 const target = createStore(); const root = { id: 'c1', name: 'Old title', project: 'p', state: 'idle', last_activity_ts: null, conversation_ids: ['c1'], running_children: 0, total_children: 0 };
 target.setSnapshot({ seq: 1, generation: 0, projection: { projects: [{ id: 'p', display_name: 'Product', state: 'registered' }], roots: [] }, pages: { roots: { total: 2, next: 'c0' } } });
 vi.stubGlobal('fetch', vi.fn(async (url: URL) => { expect(url.pathname).toBe('/projection'); expect(url.searchParams.get('table')).toBe('roots');
 target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: { roots: { remove: [], upsert: [{ ...root, name: 'Live title' }] } } });
 return { ok: true, json: async () => ({ generation: 0, rows: [root, { ...root, id: 'c2', name: 'Second page', conversation_ids: ['c2'] }], next: null }) }; }));
 render(<MemoryRouter><App target={target}/></MemoryRouter>);
 await within(screen.getByRole('main')).findByRole('link', { name: /Second page/ }); expect(within(screen.getByRole('main')).getByRole('link', { name: /Live title/ })).toBeTruthy(); expect(screen.queryByRole('link', { name: /Old title/ })).toBeNull();
});it('uses the root projection name without fetching conversation bodies', () => {
 const target = createConversationStore(); const snapshot = target.getSnapshot();
 target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, roots: [{ id: 'c', name: 'agent-graph-001', project: 'p', state: 'unknown', last_activity_ts: null, conversation_ids: ['c'], running_children: 0, total_children: 0 }] } });
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); render(<MemoryRouter><HomePage target={target}/></MemoryRouter>);
 expect(screen.getByRole('link', { name: /agent-graph-001/ })).toBeTruthy(); expect(fetcher).not.toHaveBeenCalled();
});it('loads the exact old search message with at most two hundred surrounding messages', async () => {
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
  expect(within(card).getByRole('link', { name: 'View changes' }).getAttribute('href')).toBe('/p/p/changes?artifact=a');
});
it('uses readable search context, highlights a bounded excerpt, and links to Changes or the exact message', async () => {
  const result: SearchResult = { id: 'result', fact_id: 'f', subject: 'message:internal-hash', kind: 'message',
    body: 'Before\n'.repeat(100) + 'needle matches here\n' + 'after\n'.repeat(100), reason: null,
    conversation_id: 'c', run_id: 'r', message_id: 'm', project: 'p', provider: 'codex', source_ts: OLD, confidence: 'confirmed' };
  render(<MemoryRouter><SearchPage target={createConversationStore()} client={{ search: async () => ({ mode: 'fts5', total: 2,
    results: [result, { ...result, id: 'diff', kind: 'diff', subject: 'artifact:a', message_id: null }], unsupported: [] }) }}/></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'needle' } });
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
it('orders same-time legacy Codex messages by their numeric line position, whatever the digit count', () => {
  const rows = [9999, 104048, 20].map(offset => ({ id: `["codex","rollout.jsonl:${offset}:h"]`, source_ts: OLD,
    source_event_id: `message:rollout.jsonl:${offset}:h:1` }));
  expect(rows.toSorted(compareMessages).map(row => row.source_event_id)).toEqual([20, 9999, 104048].map(offset => `message:rollout.jsonl:${offset}:h:1`));
});
it('窓から外れた古い発言でも、ファイルを変えた発言は残して返す', async () => {
  const rows = Array.from({ length: 600 }, (_, index) => ({ id: `m${String(index).padStart(3, '0')}`, role: 'assistant',
    body: index === 3 ? JSON.stringify([{ type: 'tool_use', id: 't', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } }]) : `Body ${index}`,
    source_ts: new Date(Date.parse(OLD) + index * 1000).toISOString() }));
  const page = await loadConversationWindow('c', new AbortController().signal, undefined, undefined, async path => {
    const after = new URL(path, 'http://localhost').searchParams.get('after') ?? '';
    const messages = rows.filter(row => row.id > after).slice(0, 200);
    return { generation: 0, projection: { messages,
      message_memberships: messages.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })) },
    next: messages.length === 200 ? messages.at(-1)!.id : null };
  });
  expect(page.projection.messages.some(row => row.id === 'm003')).toBe(false);
  expect(page.projection.edit_messages.map(row => row.id)).toEqual(['m003']);
});
