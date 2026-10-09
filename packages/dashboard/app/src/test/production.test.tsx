import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { createStore } from '../lib/store.ts';
import { orderSeries, selectRoots } from '../lib/roots.ts';
import { visibleText } from '../lib/message-body.ts';
import { formatWhen } from '../lib/format.ts';
import { Message } from '../components/conversation/Message.tsx';
import { senderOf } from '../components/conversation/participants.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';

// 本番の画面で見つかった崩れの試験。
beforeEach(() => { localStorage.clear(); vi.stubGlobal('innerWidth', 1440); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true, result: [] })) };
function store() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [
      { id: 'old', name: 'agent-graph-001', project: 'repo', state: 'running', last_activity_ts: '2026-10-08T01:00:00Z', conversation_ids: ['old', 'new', 'mid'], running_children: 0, total_children: 0 },
      { id: 'review', name: 'review', project: null, state: 'running', last_activity_ts: '2026-10-08T01:00:00Z', conversation_ids: ['review'], running_children: 0, total_children: 0 },
    ],
    conversations: [
      { id: 'old', provider: 'claude', type: 'interactive', origin: 'observed', last_message_ts: '2026-09-25T00:00:00Z' },
      { id: 'new', provider: 'claude', type: 'interactive', origin: 'observed', last_message_ts: '2026-09-26T00:00:00Z' },
      { id: 'mid', provider: 'claude', type: 'interactive', origin: 'observed', last_message_ts: '2026-09-27T00:00:00Z' },
      { id: 'review', provider: 'claude', type: 'interactive', origin: 'observed' },
    ],
    runs: [
      { id: 'old:1', conversation_id: 'old', generation: 1, state: 'idle', last_evidence_ts: '2026-09-25T00:00:00Z' },
      { id: 'new:1', conversation_id: 'new', generation: 1, state: 'running', last_evidence_ts: '2026-10-08T01:00:00Z' },
      { id: 'mid:1', conversation_id: 'mid', generation: 1, state: 'idle', last_evidence_ts: '2026-09-27T00:00:00Z' },
    ],
    relations: [{ id: 'review-of', type: 'review_of', active: 1, from_id: 'review', to_id: 'old', confidence: 'confirmed' }],
    messages: [
      { id: 'm-old', role: 'user', body: 'September request', source_ts: '2026-09-25T00:00:00Z' },
      { id: 'm-new', role: 'assistant', body: 'Latest answer', source_ts: '2026-10-08T01:00:00Z' },
      { id: 'm-mid', role: 'assistant', body: 'Middle answer', source_ts: '2026-09-27T00:00:00Z' },
    ],
    message_memberships: [['m-old', 'old'], ['m-new', 'new'], ['m-mid', 'mid']].map(([message, conversation]) => ({ id: message, message_id: message, conversation_id: conversation, active: 1 })),
  } });
  return target;
}

it('orders a series by its last activity and shows the latest message last with the series state', () => {
  const target = store();
  expect(orderSeries(target.getSnapshot(), ['old', 'new', 'mid'])).toEqual(['old', 'mid', 'new']);
  render(<MemoryRouter><WorkspacePage project="repo" target={target} client={client}/></MemoryRouter>);
  const texts = [...document.querySelectorAll('.conv-timeline article')].map(article => article.textContent ?? '');
  expect(texts.at(-1)).toContain('Latest answer');
  expect(texts[0]).toContain('September request');
  const header = document.querySelector<HTMLElement>('.conv-header')!;
  expect(within(header).getByRole('link', { name: 'Running · Details' })).toBeTruthy();
});
it('keeps reviewer conversations out of the root list', () => {
  expect(selectRoots(store().getSnapshot()).map(root => root.id)).toEqual(['old']);
});
it('opens the request flow by default unless the user collapsed it', () => {
  render(<MemoryRouter><WorkspacePage project="repo" target={store()} client={client}/></MemoryRouter>);
  const toggle = screen.getByRole('button', { name: 'Collapse panel' });
  fireEvent.click(toggle);
  expect(localStorage.getItem('agent-graph-panel-collapsed')).toBe('1');
  cleanup();
  render(<MemoryRouter><WorkspacePage project="repo" target={store()} client={client}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }));
  expect(localStorage.getItem('agent-graph-panel-collapsed')).toBe('0');
});
it('does not draw a bubble for user rows that only carry injected text or tool results', () => {
  expect(visibleText('<system-reminder>Plan mode</system-reminder>\n')).toBe('');
  expect(visibleText('<command-name>/model</command-name>')).toBe('/model');
  const sender = { key: 'user', name: 'User', side: 'end' as const };
  const injected = render(<Message row={{ id: 'a', role: 'user', body: '<system-reminder>hook text</system-reminder>' }} sender={sender}/>);
  expect(injected.container.querySelector('article')).toBeNull();
  const result = render(<Message row={{ id: 'b', role: 'user', body: [{ type: 'tool_result', tool_use_id: 'elsewhere', content: 'ok' }] }} sender={sender}/>);
  expect(result.container.querySelector('article')).toBeNull();
  const written = render(<Message row={{ id: 'c', role: 'user', body: 'Please fix it' }} sender={sender}/>);
  expect(written.container.querySelector('.message-bubble')?.textContent).toContain('Please fix it');
});

function flowStore(childCount: number) {
  const target = store();
  const p = target.getSnapshot().projection;
  // 子は 1 時間ずつずらす。24 時間を超えて離れた子は Earlier に畳まれるので、ここでは全てを 24 時間の中に置く。
  const day = (n: number) => new Date(Date.now() - (24 - n) * 30 * 60 * 1000).toISOString();
  for (let index = 0; index < childCount; index++) {
    const id = `child-${index}`;
    p.conversations!.push({ id, provider: 'claude', type: 'subagent', origin: 'observed' });
    p.runs!.push({ id: `${id}:1`, conversation_id: id, generation: 1, state: index === 0 ? 'running' : 'ended', started_ts: day(index), last_evidence_ts: day(index) });
    p.relations!.push({ id: `rel-${id}`, type: 'delegated', active: 1, from_id: 'new', to_id: id, confidence: 'confirmed', evidence: { agentType: 'general-purpose', description: `Task ${index}` } });
  }
  target.setSnapshot({ ...target.getSnapshot() });
  return target;
}
function Location() { return <output data-testid="location">{useLocation().search}</output>; }
it('puts running children first, then the newest, and folds older children past twenty', () => {
  render(<MemoryRouter><WorkspacePage project="repo" target={flowStore(25)} client={client}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Panel' });
  const titles = () => [...flow.querySelectorAll('.graph-card:not(.graph-root):not(.graph-earlier) .graph-card-title')].map(element => element.textContent);
  expect(titles().slice(0, 3)).toEqual(['Task 0', 'Task 24', 'Task 23']);
  expect(titles()).toHaveLength(21);
  fireEvent.click(within(flow).getByRole('button', { name: /other completed requests|earlier/ }));
  expect(titles()).toHaveLength(25);
  expect(titles().at(-1)).toBe('Task 1');
});
it('opens a child conversation from anywhere on its row, writes it to the URL and offers a way back', () => {
  render(<MemoryRouter><WorkspacePage project="repo" target={flowStore(2)} client={client}/><Location/></MemoryRouter>);
  const header = () => document.querySelector<HTMLElement>('.conv-title-row')!;
  // 根の系列の見出しには経過の時間を出さない。
  expect(header().textContent).not.toMatch(/Elapsed/);
  const flow = screen.getByRole('complementary', { name: 'Panel' });
  fireEvent.click(within(flow).getByText('Task 1').closest('.graph-card')!);
  expect(screen.getByTestId('location').textContent).toContain('child=child-1');
  expect(screen.getByRole('button', { name: 'Back to Repo-20260925' }).textContent).toBe('←Repo-20260925');
  fireEvent.click(within(flow).getByText('Task 0'));
  expect(screen.getByTestId('location').textContent).toContain('child=child-0');
  // 子の会話は動いている間だけ経過を出す。
  expect(header().textContent).toMatch(/Elapsed/);
  fireEvent.click(screen.getByRole('button', { name: 'Back to Repo-20260925' }));
  expect(screen.getByTestId('location').textContent).not.toContain('child=');
});

it('子のエージェントの報告と裏の作業の通知を、利用者の発言として出さない', () => {
  const participants = { child: false, parent: 'User', self: 'Claude' };
  const report = { id: 'r', role: 'user', body: 'Another Claude session sent a message:\n<agent-message from="a1">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Done and committed.\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.' };
  const notice = { id: 'n', role: 'user', body: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>done</task-notification>' };
  expect(senderOf(report, participants)).toMatchObject({ key: 'agent_report', side: 'start' });
  expect(senderOf(notice, participants)).toMatchObject({ key: 'notification', side: 'start' });
  expect(senderOf({ id: 'u', role: 'user', body: '早くして' }, participants)).toMatchObject({ side: 'end' });
  const shown = render(<Message row={report} sender={senderOf(report, participants)}/>);
  expect(shown.container.textContent).toContain('Done and committed.');
  expect(shown.container.textContent).not.toContain('other Claude session');
  const hidden = render(<Message row={notice} sender={senderOf(notice, participants)}/>);
  expect(hidden.container.textContent).toBe('');
});

it('現在から 24 時間より前に止まった子は、Earlier に畳む', () => {
  const store = flowStore(3);
  const runs = store.getSnapshot().projection.runs!;
  for (const run of runs) if (run.id === 'child-1:1') { run.last_evidence_ts = '2026-08-01T00:00:00Z'; run.started_ts = '2026-08-01T00:00:00Z'; }
  render(<MemoryRouter><WorkspacePage project="repo" target={store} client={client}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Panel' });
  const titles = () => [...flow.querySelectorAll('.graph-card:not(.graph-root):not(.graph-earlier) .graph-card-title')].map(element => element.textContent);
  expect(titles()).not.toContain('Task 1');
  fireEvent.click(within(flow).getByRole('button', { name: /other completed requests|earlier/ }));
  expect(titles()).toContain('Task 1');
});

it('承認待ちの子の行で、何を許すかを見せてその場で Allow できる', async () => {
  const store = flowStore(2);
  const projection = store.getSnapshot().projection;
  projection.runs!.find(run => run.id === 'child-0:1')!.state = 'waiting_approval';
  projection.approvals = [{ id: 'ap', run_id: 'child-0:1', conversation_id: 'child-0', state: 'pending', available_decisions: ['accept', 'cancel'],
    request: { command: "/bin/zsh -lc 'git status'", kind: 'command' } }];
  const answer = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'x', ok: true })) };
  store.setConnection('connected');
  render(<MemoryRouter><WorkspacePage project="repo" target={store} client={answer}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Panel' });
  expect(within(flow).getByText(/git status/)).toBeTruthy();
  fireEvent.click(within(flow).getByRole('button', { name: 'Allow' }));
  await vi.waitFor(() => expect(answer.command).toHaveBeenCalledWith('answer', { approvalId: 'ap', decision: 'accept' }));
});

it('キットの番号の名前を、プロジェクト名と会話を始めた日で呼び、同じ日の 2 つ目に -2 を付ける', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'p', display_name: 'agent-graph' }],
    conversations: [{ id: 'a', created_ts: new Date(2026, 9, 8, 9, 0).toISOString() }, { id: 'b', created_ts: new Date(2026, 9, 8, 13, 0).toISOString() },
      { id: 'c', created_ts: new Date(2026, 9, 6, 9, 0).toISOString() }],
    roots: [{ id: 'r1', name: 'agent-graph-014', project: 'p', state: 'idle', conversation_ids: ['b'] }, { id: 'r2', name: 'agent-graph-013', project: 'p', state: 'idle', conversation_ids: ['a'] },
      { id: 'r3', name: 'agent-graph-001', project: 'p', state: 'idle', conversation_ids: ['c'] }],
  } });
  const roots = selectRoots(target.getSnapshot(), 'p');
  expect(Object.fromEntries(roots.map(root => [root.kit_name, root.name]))).toEqual({
    'agent-graph-013': 'agent-graph-20261008', 'agent-graph-014': 'agent-graph-20261008-2', 'agent-graph-001': 'agent-graph-20261006' });
});
it('前の日の時刻にも、日付に続けて時と分を出す', () => {
  const now = new Date(2026, 9, 8, 12, 0).getTime();
  expect(formatWhen(new Date(2026, 9, 6, 9, 5), 'en', now)).toBe('Oct 6 9:05');
  expect(formatWhen(new Date(2026, 9, 6, 9, 5), 'ja', now)).toBe('10月6日 9:05');
});
it('結果を返して待機に戻った Claude の子は完了と出し、general-purpose の役割は出さない', () => {
  const target = flowStore(2);
  for (const run of target.getSnapshot().projection.runs!) if (run.id === 'child-1:1') run.state = 'idle';
  render(<MemoryRouter><WorkspacePage project="repo" target={target} client={client}/></MemoryRouter>);
  const flow = screen.getByRole('complementary', { name: 'Panel' });
  const row = [...flow.querySelectorAll<HTMLElement>('.graph-card-link')].find(element => element.textContent?.includes('Task 1'))!;
  expect(row.getAttribute('aria-label')).toContain('Done');
  expect(row.textContent).not.toContain('general-purpose');
});
