import { trackReloadInputs } from '../lib/reload-inputs.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { ChangedFiles } from '../pages/conversation/ChangedFiles.tsx';
import { createStore, type Row } from '../lib/store.ts';
import { collectConversationChanges } from '../lib/conversation-changes.ts';
import { groupToolRuns } from '../components/conversation/timeline.ts';
import { selectTimeline, type TimelineEntry } from '../components/conversation/model.ts';
import { resolveParticipants } from '../components/conversation/participants.ts';
import { effortLabel, toolsLabel } from '../components/conversation/text.ts';
import { Message } from '../components/conversation/Message.tsx';
import { installPreloadRecovery, RELOAD_IDLE_MS } from '../lib/preload-recovery.ts';
import { isDashboardReloadBlocked } from '../lib/reload-safety.ts';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const client = { command: vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: name === 'settings.read' ? { config: { agents: { claude: { model: 'opus' }, codex: { model: 'opus' } } } } : [{ model: 'default', displayName: 'Default (recommended)' }, { model: 'opus', displayName: 'Opus 5.5' }] })) };
function setup(messages: Row[] = [], extra: Record<string, Row[]> = {}) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'Demo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Root', project: 'p', conversation_ids: ['c'], state: 'idle' }],
    conversations: [{ id: 'c', name: 'Root', project: 'p', provider: 'claude', origin: 'managed' }, { id: 'child', provider: 'claude', type: 'subagent', project: 'p' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle', generation: 1, launch: { cwd: '/repo' } }, { id: 'cr', conversation_id: 'child', generation: 1, state: 'idle' }],
    messages, message_memberships: messages.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })), ...extra,
  } });
  target.setConnection('connected');
  return target;
}
function Location() { return <output data-testid="url">{useLocation().search}</output>; }
function entry(id: string, kind: TimelineEntry['kind'], row: Row = {}): TimelineEntry { return { kind, key: id, time: '', row: { id, ...row } }; }

it.each(['running', 'idle'])('shows observed queued inputs in their bubbles while %s', async state => {
  const target = setup([], { conversations: [{ id: 'c', provider: 'claude', origin: 'managed', pending_inputs: [
    { id: 'queue', body: 'Next step', source_ts: '2026-10-13T00:00:00Z', state: 'queued' },
  ] }], runs: [{ id: 'r', conversation_id: 'c', state, generation: 1 }] });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language="en"/></MemoryRouter>);
  await act(async () => {});
  expect(screen.queryByText('Next step') !== null).toBe(state === 'running');
  expect(screen.queryByText('Queued — Claude will read this after the current step') !== null).toBe(state === 'running');
  await act(async () => { target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    conversations: { upsert: [{ id: 'c', provider: 'claude', origin: 'managed', pending_inputs: [] }], remove: [] },
    messages: { upsert: [{ id: 'read', role: 'user', body: 'Next step' }], remove: [] },
    message_memberships: { upsert: [{ id: 'read', message_id: 'read', conversation_id: 'c', active: 1 }], remove: [] },
  } }); });
  expect(screen.getAllByText('Next step')).toHaveLength(1);
});

it('ends Sending at ack before enqueue or the recorded message arrives', async () => {
  const target = setup();
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language="en"/></MemoryRouter>);
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Next step' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
  await act(async () => {});
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.getAllByText('Next step')).toHaveLength(1);
  await act(async () => { target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    runs: { upsert: [{ id: 'r', conversation_id: 'c', state: 'running', generation: 1 }], remove: [] },
    conversations: { upsert: [{ id: 'c', provider: 'claude', origin: 'managed', pending_inputs: [
      { id: 'queue', body: 'Next step', state: 'queued' },
    ] }], remove: [] },
  } }); });
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.getAllByText('Next step')).toHaveLength(1);
  expect(screen.getByText('Queued — Claude will read this after the current step')).toBeTruthy();
});

it('reconciles two midturn inputs with enqueue and keeps the recorded input after a new generation and remount', async () => {
  const first = 'First line\nSecond line';
  const second = 'Another request';
  const target = setup([], { runs: [{ id: 'r', conversation_id: 'c', state: 'running', generation: 1 }] });
  const view = render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language="en"/></MemoryRouter>);
  await act(async () => {});
  for (const text of [first, second]) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: text } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
    await act(async () => {});
  }
  expect(screen.queryByText('Sending…')).toBeNull();
  const conversation = { id: 'c', provider: 'claude', origin: 'managed', pending_inputs: [
    { id: 'q1', body: first, state: 'queued' }, { id: 'q2', body: second, state: 'queued' },
  ] };
  await act(async () => { target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    conversations: { upsert: [conversation], remove: [] },
  } }); });
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.getAllByText('Queued — Claude will read this after the current step')).toHaveLength(2);
  const snapshot = target.getSnapshot();
  const recorded = [{ id: 'a1', role: 'user', body: first }, { id: 'a2', role: 'user', body: second }];
  await act(async () => { target.setSnapshot({ seq: 3, generation: 1, projection: { ...snapshot.projection,
    conversations: [{ ...conversation, pending_inputs: [] }], messages: recorded,
    message_memberships: recorded.map(row => ({ id: row.id, message_id: row.id, conversation_id: 'c', active: 1 })),
  } }); });
  view.unmount();
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language="en"/></MemoryRouter>);
  await act(async () => {});
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.queryByText('Queued — Claude will read this after the current step')).toBeNull();
  expect(screen.getAllByText('Another request')).toHaveLength(1);
  expect(screen.getAllByText(/First line\s+Second line/)).toHaveLength(1);
});

it.each(['Agent', 'Task', 'mcp__agent-graph__delegate', 'runner.delegate', 'planner.delegate'])('keeps %s requests outside tool folds and navigates to the same child as the tree', async name => {
  const target = setup([{ id: 'm', role: 'assistant', body: [
    { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_use', id: 'call', name, input: { description: 'Build parser' } },
    { type: 'tool_use', id: 'unmatched', name, input: { description: 'Unlinked request', provider: 'codex' } },
  ] }], { relations: [{ id: 'edge', type: 'delegated', from_id: 'c', to_id: 'child', active: 1, evidence: { toolUseId: 'call', description: 'Build parser', agentType: 'implement' } }] });
  render(<MemoryRouter initialEntries={['/p/p?root=root']}><WorkspacePage project="p" target={target} client={client} language="ja"/><Location/></MemoryRouter>);
  const card = await screen.findByRole('button', { name: /Build parser.*完了/ });
  expect(card.closest('.tool-run')).toBeNull();
  expect(card.closest('.message-bubble')).toBeNull();
  expect(card.querySelector('[title="Claude"]')).toBeTruthy();
  const unmatched = screen.getByRole('button', { name: 'Unlinked request' }) as HTMLButtonElement;
  expect(unmatched.disabled).toBe(true);
  expect(unmatched.querySelector('.status')).toBeNull();
  expect(unmatched.querySelector('[title="Codex"]')).toBeTruthy();
  fireEvent.click(card);
  expect(screen.getByTestId('url').textContent).toContain('child=child');
  await act(async () => {});
});

it('keeps tool and delegation cards separate from the surrounding reply bubbles', () => {
  const { container } = render(<Message sender={{ key: 'start', name: 'Claude', side: 'start' }} row={{ id: 'reply', role: 'assistant', body: [
    { type: 'text', text: 'Before the calls' },
    { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'pwd' } },
    { type: 'tool_use', id: 'delegate', name: 'Agent', input: { description: 'Build parser' } },
    { type: 'text', text: 'After the calls' },
  ] }}/>);
  const main = container.querySelector('.message-main')!;
  expect([...main.children].map(child => child.className)).toEqual(['message-bubble', 'tool-call', 'delegation-card', 'message-bubble']);
  expect(main.querySelector('.message-bubble .tool-call, .message-bubble .delegation-card')).toBeNull();
});

it('keeps effort values in English and names the recommended Claude model', async () => {
  render(<MemoryRouter><ConversationPage conversationId="c" target={setup([], { conversations: [{ id: 'c', provider: 'codex', origin: 'managed' }] })} client={client} language="ja"/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /^思考量 · / }));
  const menu = screen.getByRole('menu', { name: /^思考量 · / });
  expect(within(menu).getAllByRole('menuitemradio').map(option => [option.textContent, option.getAttribute('data-value')])).toEqual([
    ['自動', ''], ['none', 'none'], ['minimal', 'minimal'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'],
  ]);
  expect(effortLabel('high', 'ja')).toBe('high');
  expect(effortLabel('high', 'en')).toBe('high');
  expect(toolsLabel(2, 'ja')).toBe('ツール 2 件');
  expect(toolsLabel(1, 'en')).toBe('1 tool');
  fireEvent.keyDown(menu, { key: 'Escape' });
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: /^モデル · / }));
  expect(screen.getByRole('menuitemradio', { name: 'おすすめ · モデルを取得できない' }).getAttribute('data-value')).toBe('default');
  expect(document.querySelector('.composer')!.textContent).not.toContain('デフォルト');
});

it('styles model and effort menus as ghost controls with matching noninteractive chevrons', async () => {
  render(<MemoryRouter><ConversationPage conversationId="c" target={setup([], { conversations: [{ id: 'c', provider: 'codex', origin: 'managed' }] })} client={client} language="ja"/></MemoryRouter>);
  await act(async () => {});
  for (const name of ['モデル', '思考量']) {
    const button = screen.getByRole('button', { name: new RegExp('^' + name + ' · ') });
    expect(button.getAttribute('title')).toMatch(new RegExp('^' + name + ' · '));
    expect(button.className).toContain('btn-ghost');
    expect(button.querySelector(':scope > svg')?.getAttribute('width')).toBe('12');
    expect(button.querySelector(':scope > svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
  }
  const css = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  expect(css).toContain('.choice-trigger > .icon { pointer-events: none; }');
  expect(css).toContain('background: var(--bg-0); border: var(--border); border-radius: var(--radius-2); box-shadow: var(--shadow)');
  expect(document.querySelector('.composer select')).toBeNull();
});

it('grows the composer for wrapped input, caps it at eight lines, and shrinks after clearing or resizing', async () => {
  let contentHeight = 46;
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  const computed = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => element instanceof HTMLTextAreaElement
    ? { minHeight: '48px', maxHeight: '200px' } as CSSStyleDeclaration : computed(element, pseudo));
  render(<MemoryRouter><ConversationPage conversationId="c" target={setup()} client={client}/></MemoryRouter>);
  await act(async () => {});
  const input = document.querySelector('.composer-box textarea') as HTMLTextAreaElement;
  expect(input.style.height).toBe('48px');
  contentHeight = 112;
  fireEvent.change(input, { target: { value: 'A long line that wraps without newline characters' } });
  expect(input.style.height).toBe('112px');
  contentHeight = 244;
  fireEvent.change(input, { target: { value: Array(10).fill('line').join('\n') } });
  expect(input.style.height).toBe(`${8 * 22 + 2 * 12}px`);
  contentHeight = 90;
  fireEvent(window, new Event('resize'));
  expect(input.style.height).toBe('90px');
  contentHeight = 46;
  fireEvent.change(input, { target: { value: '' } });
  expect(input.style.height).toBe('48px');
  const css = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  const rule = css.match(/\.composer-box textarea \{([^}]+)\}/)![1];
  expect(rule).toContain('resize: none');
  expect(rule).toContain('max-height: 200px');
  expect(rule).toContain('overflow-y: auto');
});

it('drops leading boundaries and merges boundaries across invisible messages while preserving compaction', () => {
  const grouped = groupToolRuns([entry('lead', 'boundary', { type: 'continued' }), entry('blank', 'message', { role: 'assistant', body: '' }),
    entry('lead2', 'boundary', { type: 'continued' }), entry('visible', 'message', { role: 'user', body: 'Hello' }),
    entry('continue', 'boundary', { type: 'continued' }), entry('thinking', 'message', { body: [{ type: 'thinking', thinking: 'hidden' }] }),
    entry('compact', 'boundary', { type: 'compacted' }), entry('reply', 'message', { role: 'assistant', body: 'Reply' })]);
  expect(grouped.map(item => item.key)).toEqual(['visible', 'compact', 'reply']);
});

it('folds configuration and project instructions and combines unavailable history without Unknown messages', async () => {
  const messages = [
    { id: 'gap1', role: 'unknown', body_state: 'omitted', native_id: 'history-unavailable:first' },
    { id: 'gap2', role: 'unknown', body_state: 'unavailable', native_id: 'history-unavailable:second' },
    { id: 'sys', role: 'system', body: '<multi_agent_role>Internal system</multi_agent_role>' },
    { id: 'dev', role: 'developer', body: '<skills_instructions>Internal developer</skills_instructions>' },
    { id: 'agents', role: 'user', body: '# AGENTS.md\nProject setup' },
    { id: 'instructions', role: 'user', body: '<INSTRUCTIONS>Project rules</INSTRUCTIONS>' },
  ];
  // 時刻で、実際の履歴と同じ並びを固定する。
  const target = setup(messages.map((row, index) => ({ ...row, source_ts: `2026-10-08T00:00:0${index}Z` })));
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language="ja"/></MemoryRouter>);
  const history = screen.getByText('古い記録は読めません').closest('[role="separator"]')!;
  expect(history.getAttribute('title')).toContain('history-unavailable:first');
  expect(history.getAttribute('title')).toContain('history-unavailable:second');
  expect(screen.getAllByText('古い記録は読めません')).toHaveLength(1);
  expect(screen.queryByText('Unknown')).toBeNull();
  const configuration = screen.getByText('設定の指示 2 件').closest('details')!;
  expect(configuration.open).toBe(false);
  fireEvent.click(configuration.querySelector('summary')!);
  expect(configuration.open).toBe(true);
  expect(configuration.textContent).toContain('Internal developer');
  expect(screen.getByText('プロジェクトの指示').closest('details')!.open).toBe(false);
  expect(selectTimeline(target.getSnapshot(), 'c').filter(item => item.kind === 'message')).toHaveLength(4);
  await act(async () => {});
});

it('deduplicates role, body and timestamp and names the actual nested requesting agent', () => {
  const row = { role: 'user', body: 'Task S1', source_ts: '2026-10-08T00:00:00Z' };
  expect(groupToolRuns([entry('a', 'message', row), entry('b', 'message', row), entry('later', 'message', { ...row, source_ts: 'later' })].map(item => ({ ...item, time: String('row' in item ? item.row.source_ts : '') })))).toHaveLength(2);
  const target = setup([], { conversations: [{ id: 'root', provider: 'claude' }, { id: 'parent', provider: 'codex' }, { id: 'child', provider: 'claude' }],
    relations: [{ id: 'p', type: 'delegated', from_id: 'root', to_id: 'parent', active: 1, evidence: { role: 'implement' } },
      { id: 'c', type: 'delegated', from_id: 'parent', to_id: 'child', active: 1, evidence: { role: 'review' } }] });
  expect(resolveParticipants(target.getSnapshot(), 'child', { user: 'User', parent: 'Requesting agent', assistant: 'Assistant' })).toMatchObject({ child: true, parent: 'Codex · implement', self: 'Claude · review' });
});

it('excludes internal records, sorts paths and omits zero change counts', () => {
  const paths = ['/tmp/z', '/repo/z.ts', '/repo/.agents/run.json', '.agents/a', '/repo/a.ts', '/tmp/a'];
  const files = collectConversationChanges(paths.map((file_path, index) => ({ id: String(index), body: [{ type: 'tool_use', name: 'Write', input: { file_path, content: 'new' } }] })), { cwd: '/repo' });
  expect(files.map(file => file.path)).toEqual(['a.ts', 'z.ts', '/tmp/a', '/tmp/z']);
  render(<ChangedFiles language="ja" files={[...files, { path: 'deleted', additions: 0, deletions: 2, changes: [] }]}/>);
  expect(document.querySelector('.conv-changed-files')!.textContent).not.toMatch(/[+−]0/);
  expect(screen.getByText('deleted').closest('summary')!.textContent).toContain('−2');
});

it('omits the back row in roots and retains the Codex composer title with the badge beside the heading', async () => {
  const target = setup([], { conversations: [{ id: 'c', name: 'Root', project: 'p', provider: 'codex', origin: 'managed' }] });
  render(<MemoryRouter><WorkspacePage project="p" target={target} client={client} language="ja"/></MemoryRouter>);
  expect(document.querySelector('.root-back-placeholder')).toBeNull();
  expect(document.querySelector('.composer-hint')).toBeNull();
  expect(document.querySelector('.composer-box')!.getAttribute('title')).toBe('Codex のモデルの変更は次の返答から効きます。');
  expect(screen.getByRole('tab', { name: 'Root' }).querySelector('.status-idle')).toBeTruthy();
  expect(document.querySelector('.workbench-body .conv-header')).toBeNull();
  const css = readFileSync(resolve(process.cwd(), 'app/src/pages/conversation/conversation.css'), 'utf8');
  expect(css).toMatch(/\.conversation-page \.conv-title-row \.conv-title \{ flex: 0 1 auto;/);
  expect(css).not.toContain('.root-back-placeholder');
  await act(async () => {});
});

it('matches planner attempts to the current conversation and state rather than an earlier run', async () => {
  const target = setup([{ id: 'm', role: 'assistant', body: [{ type: 'tool_use', id: 'call', name: 'mcp__agent-graph__delegate', input: { requestId: 'request', description: 'Planner task' } }] }], {
    conversations: [{ id: 'c', provider: 'claude', origin: 'managed', project: 'p' }, { id: 'child', provider: 'codex', project: 'p' }, { id: 'old', provider: 'codex' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle', generation: 1 }, { id: 'old-run', conversation_id: 'old', state: 'failed', generation: 1 }, { id: 'cr', conversation_id: 'child', state: 'running', generation: 2 }],
    delegations: [{ id: 'task', request_id: 'request', root_id: 'root', parent_run_id: 'r', graph_name: 'Plan', role: 'implement', title: 'Planner task', state: 'failed', attempts: [{ run_id: 'old-run' }, { run_id: 'cr' }] }],
  });
  render(<MemoryRouter initialEntries={['/p/p?root=root']}><WorkspacePage project="p" target={target} client={client} language="ja"/><Location/></MemoryRouter>);
  const card = screen.getByRole('button', { name: /Planner task.*実行中/ });
  expect(card.querySelector('[title="Codex"]')).toBeTruthy();
  fireEvent.click(card);
  expect(screen.getByTestId('url').textContent).toContain('child=child');
  expect(screen.getByRole('tab', { name: 'Planner task' })).toBeTruthy();
  await act(async () => {});
});

it('keeps requests with ambiguous descriptions disabled', async () => {
  const target = setup([{ id: 'm', role: 'assistant', body: [{ type: 'tool_use', id: 'unmatched', name: 'Agent', input: { description: 'Same title' } }] }], {
    relations: ['child', 'other'].map(id => ({ id, type: 'delegated', from_id: 'c', to_id: id, active: 1, evidence: { description: 'Same title' } })),
  });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  const card = screen.getByRole('button', { name: 'Same title' }) as HTMLButtonElement;
  expect(card.disabled).toBe(true);
  expect(card.querySelector('.status')).toBeNull();
  await act(async () => {});
});

it.each(['ja', 'en'] as const)('renders translated tool counts, history loading, reports, commands and continuation in %s', async language => {
  const messages = [
    ...Array.from({ length: 201 }, (_, index) => ({ id: `old-${index}`, role: 'user', body: `Older ${index}`, source_ts: '2026-10-07T00:00:00Z' })),
    { id: 'first', role: 'assistant', body: 'Visible', source_ts: '2026-10-08T00:00:00Z' },
    { id: 'tools', role: 'assistant', body: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'pwd' } }], source_ts: '2026-10-08T00:00:01Z' },
    { id: 'report', role: 'user', body: 'Another Claude session sent a message: The report follows: Finished', source_ts: '2026-10-08T00:00:03Z' },
  ];
  const target = setup(messages, {
    relations: [{ id: 'continued', type: 'continued', from_id: 'other', to_id: 'c', active: 1, source_ts: '2026-10-08T00:00:02Z' }],
    approvals: [{ id: 'approval', conversation_id: 'c', state: 'pending', request: { command: 'pwd' } }],
  });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language={language}/></MemoryRouter>);
  expect(screen.queryByRole('button', { name: language === 'ja' ? '古い発言を読み込む' : 'Load older' })).toBeNull();
  await act(async () => {});
  fireEvent.scroll(document.querySelector('.conv-timeline')!, { target: { scrollTop: 0 } });
  expect(screen.getByText('Older 0')).toBeTruthy();
  expect(screen.getByText(language === 'ja' ? 'ツール 1 件' : '1 tool').closest('details')!.open).toBe(false);
  expect(screen.getByLabelText(language === 'ja' ? 'エージェントの報告' : 'Agent report').tagName).toBe('DETAILS');
  expect(screen.getByText(language === 'ja' ? 'コマンド' : 'Command', { selector: '.tool-name' })).toBeTruthy();
  expect(screen.getByText(new RegExp(language === 'ja' ? '^続きの会話' : '^Conversation continued')).closest('[role="separator"]')).toBeTruthy();
  await act(async () => {});
});

it('deduplicates text stored as blocks and strings before pagination and file counts', async () => {
  const target = setup([
    { id: 'one', role: 'user', body: 'Task S1', source_ts: '2026-10-08T00:00:00Z' },
    { id: 'two', role: 'user', body: [{ type: 'text', text: 'Task S1' }], source_ts: '2026-10-08T00:00:00Z' },
  ]);
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  expect(screen.getAllByText('Task S1')).toHaveLength(1);
  await act(async () => {});
});

it('keeps a request between the surrounding text blocks and folds neither the request nor its result into tools', async () => {
  const target = setup([
    { id: 'a', role: 'assistant', source_ts: '2026-10-08T00:00:00Z', body: [
      { type: 'text', text: 'Before request' }, { type: 'tool_use', id: 'request', name: 'Agent', input: { description: 'Middle request' } }, { type: 'text', text: 'After request' },
    ] },
    { id: 'result', role: 'user', source_ts: '2026-10-08T00:00:01Z', body: [{ type: 'tool_result', tool_use_id: 'request', content: 'Done' }] },
  ]);
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  const main = screen.getByText('Before request').closest('.message-main')!;
  expect([...main.children].map(node => node.textContent)).toEqual(['Before request', 'Middle request', 'After request']);
  expect(document.querySelector('.tool-run')).toBeNull();
  await act(async () => {});
});

it('opens a conversation card in the focused empty pane and keeps the original conversation', async () => {
  const target = setup([{ id: 'm', role: 'assistant', body: [
    { type: 'tool_use', id: 'call', name: 'Agent', input: { description: 'Build parser' } },
  ] }], { relations: [{ id: 'edge', type: 'delegated', from_id: 'c', to_id: 'child', active: 1, evidence: { toolUseId: 'call', description: 'Build parser' } }] });
  render(<MemoryRouter initialEntries={['/p/p?root=root']}><WorkspacePage project="p" target={target} client={client} language="ja"/><Location/></MemoryRouter>);
  const card = await screen.findByRole('button', { name: /Build parser/ });
  fireEvent.keyDown(card, { key: 'd', metaKey: true });
  const panes = [...document.querySelectorAll<HTMLElement>('[data-pane-id]')];
  await vi.waitFor(() => expect(document.activeElement).toBe(panes[1]));
  const currentCard = within(panes[0]).getByRole('button', { name: /Build parser/ });
  fireEvent.pointerDown(currentCard);
  fireEvent.focus(currentCard);
  fireEvent.click(currentCard);
  expect(panes[1].dataset.focused).toBe('true');
  expect(within(panes[0]).getByRole('button', { name: /Build parser/ })).toBeTruthy();
  expect(within(panes[1]).getByRole('tab', { name: 'Build parser' })).toBeTruthy();
  expect(screen.getByTestId('url').textContent).toBe('?root=root');
  const saved = JSON.parse(localStorage.getItem('agent-graph-workspace:["p","root"]')!);
  expect(saved.first.tabs[0].conversationId).toBe('c');
  expect(saved.second.tabs[0].conversationId).toBe('child');
});

it.each(['en', 'ja'] as const)('shows each sender above the bubble once per consecutive group in %s', async language => {
  const target = setup([
    { id: 'u1', role: 'user', body: 'First request' },
    { id: 'u2', role: 'user', body: 'Second request' },
    { id: 'a1', role: 'assistant', body: 'First reply' },
    { id: 'a2', role: 'assistant', body: 'Second reply' },
    { id: 'u3', role: 'user', body: 'Follow up' },
  ].map((row, index) => ({ ...row, source_ts: `2026-10-08T00:00:0${index}Z` })));
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language={language}/></MemoryRouter>);
  const articles = screen.getAllByRole('article', { name: /message$/ });
  expect(articles.map(article => article.getAttribute('data-side'))).toEqual(['end', 'end', 'start', 'start', 'end']);
  const labels = articles.map(article => article.querySelector('.message-header strong'));
  expect(labels.map(label => Boolean(label))).toEqual([true, false, true, false, true]);
  expect(labels[0]!.textContent).toBe(labels[4]!.textContent);
  expect(labels[2]!.textContent).toBe('Claude');
  for (const article of articles) {
    const header = article.querySelector('.message-header')!;
    const bubble = article.querySelector('.message-bubble')!;
    expect(header.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bubble.querySelector('strong.message-sender, strong.message-requester')).toBeNull();
    expect(header.querySelector('time')).toBeTruthy();
  }
  await act(async () => {});
});

it.each(['managed', 'terminal'])('shows Sending only until the %s send acknowledgement', async origin => {
  const id = origin === 'terminal' ? '["claude","native"]' : 'c';
  const target = setup([], { conversations: [{ id, provider: 'claude', origin: origin === 'terminal' ? 'observed' : 'managed' }],
    runs: [{ id: 'r', conversation_id: id, state: 'running', generation: 1, launch: { cwd: '/repo' } }] });
  let acknowledge!: (ack: { type: 'ack'; cmd_id: string; ok: boolean }) => void;
  const controlled = { command: vi.fn((name: string) => name === 'send' || name === 'session.send'
    ? new Promise<{ type: 'ack'; cmd_id: string; ok: boolean }>(resolve => { acknowledge = resolve; })
    : name === 'session.hosts' ? Promise.resolve({ type: 'ack' as const, cmd_id: 'hosts', ok: true, result: { hosts: [{ conversationId: id, terminalId: 't' }] } }) : client.command(name)) };
  render(<MemoryRouter><ConversationPage conversationId={id} target={target} client={controlled}/></MemoryRouter>);
  await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Midturn request' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
  await screen.findAllByText('Sending…');
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
  await act(async () => { acknowledge({ type: 'ack', cmd_id: 'sent', ok: true }); });
  expect(screen.queryByText('Sending…')).toBeNull();
  expect(screen.getAllByText('Midturn request')).toHaveLength(1);
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
  expect(sessionStorage.getItem(`agent-graph-conversation-draft:${id}`)).toBeNull();
});

it('restores per-conversation drafts after switching conversations and reloading, then clears a successful send', async () => {
  const target = setup();
  const page = (id: string) => <MemoryRouter><ConversationPage conversationId={id} target={target} client={client}/></MemoryRouter>;
  let view = render(page('c'));
  await act(async () => {});
  const value = () => (screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value;
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First draft\ncontinued' } });
  view.rerender(page('child')); await act(async () => {});
  expect(value()).toBe('');
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Child draft' } });
  view.rerender(page('c')); await act(async () => {});
  expect(value()).toBe('First draft\ncontinued');
  view.unmount(); view = render(page('c')); await act(async () => {});
  expect(value()).toBe('First draft\ncontinued');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
  await act(async () => {});
  expect(value()).toBe('');
  view.unmount(); view = render(page('c')); await act(async () => {});
  expect(value()).toBe('');
  view.rerender(page('child')); await act(async () => {});
  expect(value()).toBe('Child draft');
});

it('restores a multiline draft after an automatic version reload when focus is lost', async () => {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const target = setup();
  const page = <MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>;
  let view = render(page); await act(async () => {});
  vi.useFakeTimers();
  document.head.innerHTML = '<script type="module" src="/assets/old.js"></script>';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<script type="module" src="/assets/new.js"></script>' })));
  const reload = vi.fn(() => { view.unmount(); view = render(page); });
  const inputs = trackReloadInputs(document);
  const dispose = installPreloadRecovery(reload, { isBlocked: () => isDashboardReloadBlocked() || inputs.isBlocked() });
  try {
    fireEvent.input(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '書きかけ\nKeep this draft' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(RELOAD_IDLE_MS); });
    expect(reload).not.toHaveBeenCalled();
    focus.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveProperty('value', '書きかけ\nKeep this draft');
  } finally { inputs.dispose(); dispose(); document.head.innerHTML = ''; vi.useRealTimers(); }
});

it('retains a draft after a failed send', async () => {
  const target = setup();
  const failing = { command: (name: string) => name === 'send' ? Promise.resolve({ type: 'ack' as const, cmd_id: 'send', ok: false, error: 'Unavailable' }) : client.command(name) };
  const page = <MemoryRouter><ConversationPage conversationId="c" target={target} client={failing}/></MemoryRouter>;
  const view = render(page); await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep this' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
  await screen.findByText('Unavailable');
  view.unmount(); render(page); await act(async () => {});
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Keep this');
});

it('clears the acknowledged source draft after navigating away without clearing the other conversation', async () => {
  const target = setup();
  let acknowledge!: (ack: { type: 'ack'; cmd_id: string; ok: boolean }) => void;
  const controlled = { command: (name: string) => name === 'send'
    ? new Promise<{ type: 'ack'; cmd_id: string; ok: boolean }>(resolve => { acknowledge = resolve; }) : client.command(name) };
  const page = (id: string) => <MemoryRouter><ConversationPage conversationId={id} target={target} client={controlled}/></MemoryRouter>;
  const view = render(page('c')); await act(async () => {});
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Sent from main' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Enter', metaKey: true });
  await screen.findAllByText('Sending…');
  view.rerender(page('child')); await act(async () => {});
  expect(isDashboardReloadBlocked()).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Keep child draft' } });
  await act(async () => { acknowledge({ type: 'ack', cmd_id: 'send', ok: true }); });
  expect(isDashboardReloadBlocked()).toBe(false);
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Keep child draft');
  expect(sessionStorage.getItem('agent-graph-conversation-draft:c')).toBeNull();
  view.rerender(page('c')); await act(async () => {});
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('');
  expect(screen.queryByText('Sending…')).toBeNull();
});

it.each(['model', 'effort'])('holds reload for an unapplied %s and releases on revert and unmount', async field => {
  const target = setup([], { conversations: [{ id: 'c', provider: 'codex', origin: 'managed' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'idle', generation: 1, launch: { cwd: '/repo', model: { model: 'opus', effort: 'high' } } }] });
  const modelsClient = { command: (name: string) => name === 'settings.models' ? Promise.resolve({ type: 'ack' as const, cmd_id: 'models', ok: true, result: { models: [{ model: 'opus', displayName: 'Opus 5.5', effort: 'high' }, { model: 'other', displayName: 'Other', effort: 'high' }] } }) : client.command(name) };
  const view = render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={modelsClient} language="en"/></MemoryRouter>);
  await act(async () => {});
  await act(async () => {});
  expect(isDashboardReloadBlocked()).toBe(false);
  const open = () => { const button = screen.getByRole('button', { name: field === 'model' ? /^Model · / : /^Effort · / }); if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button); };
  open();
  fireEvent.click(screen.getByRole('menuitemradio', { name: field === 'model' ? 'Other' : 'low' }));
  await act(async () => {});
  expect(isDashboardReloadBlocked()).toBe(true);
  open();
  fireEvent.click(screen.getByRole('menuitemradio', { name: field === 'model' ? /Opus 5.5/ : 'high' }));
  await act(async () => {});
  expect(isDashboardReloadBlocked()).toBe(false);
  open();
  fireEvent.click(screen.getByRole('menuitemradio', { name: field === 'model' ? 'Other' : 'low' }));
  await act(async () => {});
  expect(isDashboardReloadBlocked()).toBe(true);
  view.unmount(); expect(isDashboardReloadBlocked()).toBe(false);
});
