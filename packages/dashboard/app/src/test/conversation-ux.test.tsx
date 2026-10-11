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

beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) }))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [{ model: 'default', displayName: 'Default (recommended)' }] })) };
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

it('translates effort labels without changing option values and translates the default Claude model', async () => {
  render(<MemoryRouter><ConversationPage conversationId="c" target={setup()} client={client} language="ja"/></MemoryRouter>);
  expect(await screen.findByRole('option', { name: '既定' })).toHaveProperty('value', 'default');
  const select = screen.getByRole('combobox', { name: '思考の深さ' });
  expect(within(select).getAllByRole('option').map(option => [option.textContent, (option as HTMLOptionElement).value])).toEqual([
    ['既定の深さ', ''], ['なし', 'none'], ['最小', 'minimal'], ['低', 'low'], ['中', 'medium'], ['高', 'high'], ['最高', 'xhigh'],
  ]);
  expect(effortLabel('high', 'en')).toBe('high');
  expect(toolsLabel(2, 'ja')).toBe('ツール 2 件');
  expect(toolsLabel(1, 'en')).toBe('1 tool');
});

it('styles model and effort selectors as ghost controls with matching noninteractive chevrons', async () => {
  render(<MemoryRouter><ConversationPage conversationId="c" target={setup()} client={client} language="ja"/></MemoryRouter>);
  await screen.findByRole('option', { name: '既定' });
  for (const name of ['モデル', '思考の深さ']) {
    const select = screen.getByRole('combobox', { name });
    const wrapper = select.closest('.composer-select')!;
    expect(wrapper.querySelector('svg')?.getAttribute('width')).toBe('16');
    expect(wrapper.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  }
  const css = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  const rule = css.match(/\.composer-controls select \{([^}]+)\}/)![1];
  for (const declaration of ['appearance: none', 'height: var(--control)', 'border: 0', 'border-radius: var(--radius-1)', 'font: var(--type-ui)', 'color: var(--fg-2)', 'background: transparent']) expect(rule).toContain(declaration);
  expect(css.match(/\.composer-select > \.icon \{([^}]+)\}/)![1]).toContain('pointer-events: none');
});

it('grows the composer for wrapped input, caps it at eight lines, and shrinks after clearing or resizing', async () => {
  let contentHeight = 46;
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  const computed = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => element instanceof HTMLTextAreaElement
    ? { minHeight: '48px', maxHeight: '200px' } as CSSStyleDeclaration : computed(element, pseudo));
  render(<MemoryRouter><ConversationPage conversationId="c" target={setup()} client={client}/></MemoryRouter>);
  await screen.findByRole('option', { name: 'Default (recommended)' });
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

it('omits the back row in roots and places Codex hints in the composer title with the badge beside the heading', async () => {
  const target = setup([], { conversations: [{ id: 'c', name: 'Root', project: 'p', provider: 'codex', origin: 'managed' }] });
  render(<MemoryRouter><WorkspacePage project="p" target={target} client={client} language="ja"/></MemoryRouter>);
  expect(document.querySelector('.root-back-placeholder')).toBeNull();
  expect(document.querySelector('.composer-hint')).toBeNull();
  expect(document.querySelector('.composer-box')!.getAttribute('title')).toContain('次の返答');
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
  expect(within(panes[1]).getByRole('tab', { name: 'Claude' })).toBeTruthy();
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
