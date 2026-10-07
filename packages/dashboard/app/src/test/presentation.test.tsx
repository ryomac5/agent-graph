import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore, type Row } from '../lib/store.ts';
import { approvalOutcome, evidenceLabel, projectLabel, readApprovalRequest, runLabel, summarizeApproval, worktreeLabel } from '../lib/format.ts';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { Inbox } from '../pages/inbox/Inbox.tsx';
import { selectTimeline } from '../components/conversation/model.ts';
import { Notifications } from '../components/notifications/Notifications.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const REPO = '/var/folders/07/abc/T/agent-graph-ui-x/repo';
const CONVERSATION = '["claude","session-1"]';
const RUN = `${CONVERSATION}:1`;
// 本物の runner の投影と同じ形の行。会話と実行の ID は native ID から作られた JSON の文字列になる。
function projection(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    tasks: [{ id: 'task', name: 'Browser fixture task', project: REPO, state: 'running' }],
    conversations: [{ id: CONVERSATION, task_id: 'task', provider: 'claude', origin: 'managed', type: 'interactive', history_format: 'jsonl', name: 'Browser fixture task' }],
    runs: [{ id: RUN, conversation_id: CONVERSATION, generation: 1, state: 'waiting_approval', started_ts: '2026-10-07T01:00:00Z',
      last_evidence: JSON.stringify({ fact_id: 'f', kind: 'run.state_changed' }), last_evidence_ts: '2026-10-07T01:00:05Z',
      launch: JSON.stringify({ cwd: REPO, model: { model: 'claude-sonnet', effort: 'high' } }), cwd: REPO, branch: 'main' }],
    messages: [{ id: 'm1', role: 'assistant', source_ts: '2026-10-07T01:00:01Z', source: 'host-claude', confidence: 'confirmed', body_state: 'stored',
      body: JSON.stringify([{ type: 'text', text: 'Listing files' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }]) },
    { id: 'm2', role: 'user', source_ts: '2026-10-07T01:00:02Z', source: 'transcript-claude', confidence: 'confirmed', body_state: 'stored',
      body: JSON.stringify([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\nsrc' }]) }],
    message_memberships: ['m1', 'm2'].map(id => ({ id, message_id: id, conversation_id: CONVERSATION, active: 1 })),
    approvals: [{ id: 'approval', run_id: RUN, conversation_id: CONVERSATION, request_id: 'r', state: 'pending', requested_ts: '2026-10-07T01:00:03Z',
      available_decisions: JSON.stringify(['allow', 'deny']), request: JSON.stringify({ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, tool_use_id: 'toolu_2' }) }],
    ...extra,
  };
}
function setup() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: projection() });
  target.setConnection('connected');
  return target;
}
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };

it('names projects by repository, worktrees by place and branch, and runs by conversation and generation', () => {
  expect(projectLabel(REPO)).toEqual({ name: 'repo', detail: '…/T/agent-graph-ui-x', full: REPO });
  expect(projectLabel('/Users/me/code/app').detail).toBe('~/code');
  expect(projectLabel('demo')).toEqual({ name: 'demo', detail: '', full: 'demo' });
  expect(worktreeLabel({ cwd: '/tmp/work/feature-tree', branch: 'feature/x' })).toEqual({ place: 'feature-tree', branch: 'feature/x', full: '/tmp/work/feature-tree' });
  expect(worktreeLabel({ worktree_id: 'abc123' })).toBeUndefined();
  const state = setup().getSnapshot();
  expect(runLabel(state, RUN)).toBe('Browser fixture task · Run 1');
  expect(runLabel(state, 'missing')).toBe('Unknown run');
  expect(evidenceLabel(JSON.stringify({ fact_id: 'f', kind: 'run.state_changed' }))).toBe('run state changed');
});

it('reads Claude tool inputs and Codex requests into one approval shape without raw JSON', () => {
  expect(readApprovalRequest({ name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } })).toMatchObject({ tool: 'Bash', command: 'npm test', summary: 'Run the tests' });
  expect(readApprovalRequest({ name: 'Edit', input: { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } })).toMatchObject({ tool: 'Edit', file: '/r/a.ts', diff: '-a\n+b' });
  expect(readApprovalRequest({ command: ['npm', 'run', 'build'], reason: 'Build the bundle' })).toMatchObject({ tool: 'Command', command: 'npm run build', summary: 'Build the bundle' });
  expect(summarizeApproval(JSON.stringify({ name: 'Edit', input: { file_path: '/r/src/a.ts', old_string: 'a', new_string: 'b' } }))).toBe('Edit: a.ts');
});

it('shows the conversation header with model, effort, worktree place and branch, and keeps the composer after the timeline', () => {
  render(<MemoryRouter><ConversationPage conversationId={CONVERSATION} target={setup()} client={client}/></MemoryRouter>);
  const header = document.querySelector<HTMLElement>('.conv-header')!;
  expect(within(header).getByText('claude-sonnet')).toBeTruthy();
  expect(within(header).getByText('Effort · high')).toBeTruthy();
  expect(within(header).getByText('repo')).toBeTruthy();
  expect(within(header).getByText('main')).toBeTruthy();
  expect(header.textContent).not.toMatch(/Unknown|\[|\{/);
  const page = document.querySelector('.conversation-page')!;
  expect([...page.children].map(child => child.className.split(' ')[0])).toEqual(['conv-header', 'conv-timeline', 'composer']);
});

it('folds tool calls with their paired output and places approvals inline at their requested time', () => {
  const target = setup();
  render(<MemoryRouter><ConversationPage conversationId={CONVERSATION} target={target} client={client}/></MemoryRouter>);
  const tool = screen.getByText('ls -la', { selector: '.tool-summary' }).closest('details')!;
  expect(tool.open).toBe(false);
  fireEvent.click(tool.querySelector('summary')!);
  expect(within(tool).getByText('README.md\nsrc', { collapseWhitespace: false, trim: false })).toBeTruthy();
  // 結果だけの発言は、呼び出しの中に入るので別の発言として出さない。
  expect(screen.getAllByRole('article', { name: /message$/ })).toHaveLength(1);
  const approval = screen.getByRole('article', { name: 'Approval request' });
  expect(within(approval).getByLabelText('Full command').textContent).toBe('npm test');
  expect(within(approval).getByRole('button', { name: 'Allow' }).className).toContain('btn-allow');
  // 主のボタンは入力欄の送信の 1 つだけにする。
  expect(document.querySelectorAll('.btn-primary')).toHaveLength(1);
  expect(within(approval).getByRole('button', { name: 'Deny' }).className).toContain('btn-secondary');
  expect(within(approval).queryByText('Time unknown')).toBeNull();
  expect(selectTimeline(target.getSnapshot(), CONVERSATION).map(entry => entry.kind)).toEqual(['message', 'message', 'approval']);
});

it('lists inbox rows by readable run name and shows the command exactly once', () => {
  render(<MemoryRouter><Inbox target={setup()} client={client}/></MemoryRouter>);
  const row = screen.getByRole('list', { name: 'Pending approvals' }).querySelector('li')!;
  expect(within(row).getByRole('link', { name: 'Browser fixture task · Run 1' }).getAttribute('href')).toBe(`/c/${encodeURIComponent(CONVERSATION)}`);
  expect(within(row).getAllByText('npm test')).toHaveLength(1);
  expect(row.textContent).not.toContain(RUN);
  expect(row.textContent).not.toContain('{');
});

it('shows the repository name in the sidebar with the path as secondary text', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  render(<MemoryRouter><App target={setup()} client={client}/></MemoryRouter>);
  const link = within(screen.getByRole('complementary')).getByRole('link', { name: REPO });
  expect(link.getAttribute('title')).toBe(REPO);
  expect(within(link).getByText('repo')).toBeTruthy();
  expect(within(link).getByText('…/T/agent-graph-ui-x')).toBeTruthy();
});

// 結果ごとの印の名前。Icon の線の組の中で、許可はチェック、拒否はばつ、期限切れは時計、待ちは注意の印になる。
const OUTCOME_PATHS = { allowed: 'm5 12.5 4.5 4.5L19 7.5', denied: 'M6.5 6.5l11 11M17.5 6.5l-11 11', expired: 'M12 7.5V12l3 2', pending: 'M12 9.5v4M12 17h.01' };
function iconPath(element: Element) { return [...element.querySelectorAll('path')].map(path => path.getAttribute('d')).join(' '); }
function approvalRows(): Row[] {
  const base = { run_id: RUN, conversation_id: CONVERSATION, available_decisions: ['allow', 'deny'], request: { name: 'Bash', input: { command: 'npm test' } } };
  return [
    { ...base, id: 'allowed', state: 'resolved', decision: 'allow', requested_ts: '2026-10-07T01:00:03Z' },
    { ...base, id: 'denied', state: 'resolved', decision: 'deny', requested_ts: '2026-10-07T01:00:04Z' },
    { ...base, id: 'declined', state: 'resolved', decision: 'decline', requested_ts: '2026-10-07T01:00:05Z' },
    { ...base, id: 'expired', state: 'expired', reason: 'restart', requested_ts: '2026-10-07T01:00:06Z' },
    { ...base, id: 'pending', state: 'pending', requested_ts: '2026-10-07T01:00:07Z' },
  ];
}

it('decides one outcome per approval: expiry first, then the answered decision, then pending', () => {
  expect(approvalRows().map(row => approvalOutcome(row))).toEqual(['allowed', 'denied', 'denied', 'expired', 'pending']);
  expect(approvalOutcome({ state: 'pending' }, true)).toBe('answered');
  expect(approvalOutcome({ state: 'stale', decision: 'accept' })).toBe('stale');
  expect(approvalOutcome({ state: 'resolved' })).toBe('resolved');
});

it('marks conversation approval cards with a check, a cross, a clock or an alert by outcome and colours them alike', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: projection({ approvals: approvalRows() }) });
  target.setConnection('connected');
  render(<MemoryRouter><ConversationPage conversationId={CONVERSATION} target={target} client={client}/></MemoryRouter>);
  const cards = screen.getAllByRole('article', { name: 'Approval request' });
  const expected = [['allowed', 'Allowed'], ['denied', 'Denied'], ['denied', 'Denied'], ['expired', 'Expired'], ['pending', 'Pending']] as const;
  cards.forEach((card, index) => {
    const [outcome, label] = expected[index]!;
    const icon = card.querySelector('header > svg')!;
    expect(icon.getAttribute('class')).toContain(`outcome-${outcome}`);
    expect(iconPath(icon)).toContain(OUTCOME_PATHS[outcome]);
    const chip = card.querySelector('.outcome-chip')!;
    expect(chip.textContent).toBe(label);
    expect(chip.className).toContain(`outcome-${outcome}`);
    expect(iconPath(chip.querySelector('svg')!)).toContain(OUTCOME_PATHS[outcome]);
  });
  // 拒否の札に許可の印を使わない。
  for (const card of cards.filter(card => card.dataset.outcome === 'denied')) expect(iconPath(card)).not.toContain(OUTCOME_PATHS.allowed);
});

it('uses the same outcome marks in the inbox expired list and in notifications', () => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: projection({ approvals: approvalRows() }) });
  target.setConnection('connected');
  const view = render(<MemoryRouter><Inbox target={target} client={client}/></MemoryRouter>);
  const expired = screen.getByRole('list', { name: 'Expired approvals' }).querySelector('li')!;
  const chip = expired.querySelector('.outcome-chip')!;
  expect(chip.textContent).toBe('Expired');
  expect(iconPath(chip)).toContain(OUTCOME_PATHS.expired);
  view.unmount();

  const notices = createStore();
  notices.setSnapshot({ seq: 1, generation: 1, projection: projection({ approvals: [] }) });
  render(<MemoryRouter><Notifications target={notices} client={client}/></MemoryRouter>);
  const rows = approvalRows();
  // 待ちとして届いた通知が、後から結果に変わる。
  act(() => notices.setSnapshot({ seq: 2, generation: 1, projection: projection({ approvals: rows.map(row => ({ ...row, state: 'pending', decision: undefined })) }) }));
  act(() => notices.setSnapshot({ seq: 3, generation: 1, projection: projection({ approvals: rows }) }));
  for (const [id, outcome, text] of [['allowed', 'allowed', 'Approval allowed'], ['denied', 'denied', 'Approval denied'], ['expired', 'expired', 'Approval expired']] as const) {
    const line = [...document.querySelectorAll<HTMLElement>('.approval-outcome')].find(element => element.closest('li')?.textContent?.includes(text))!;
    expect(line.dataset.outcome, id).toBe(outcome);
    expect(line.textContent).toBe(text);
    expect(iconPath(line)).toContain(OUTCOME_PATHS[outcome]);
  }
});
