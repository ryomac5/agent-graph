import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { ConversationPage, type ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { CHILD, createRootlineFacts, ROOT, START as START_ROOT } from '../../../../core/test/ledger/fixtures/rootline.ts';
import { project } from '../../../../core/src/ledger/projections/index.ts';
import type { Fact } from '../../../../core/src/ledger/facts.ts';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';
import { RootList } from '../components/RootViews.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { createStore, type Row, type ScreenState } from '../lib/store.ts';
import { currentRootConversation, selectRoots } from '../lib/roots.ts';
import { isWorkingTurn, publishTurns, resolveWorkingTurn, workingElapsed } from '../lib/turns.ts';
import * as conversationModel from '../components/conversation/model.ts';
import * as activityModel from '../lib/activity.ts';

const START = '2026-10-11T00:00:00Z';
const NOW = Date.parse(START) + 192_000;
const run = (state = 'running', extra: Row = {}): Row => ({ id: 'r', conversation_id: 'c', generation: 1, state,
  turn_started_ts: START, started_ts: '2026-10-10T00:00:00Z', last_evidence_ts: START, last_evidence: { kind: 'turn_started' }, ...extra });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); publishTurns(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const client: ConversationClient = { command: async name => ({ type: 'ack', cmd_id: 'cmd', ok: true,
  result: name === 'session.hosts' ? { hosts: [] } : name === 'list_models' ? [] : {} }) };
function setup(state = 'idle') {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    roots: [{ id: 'root', name: 'Main agent', state, conversation_ids: ['c'], project: 'p' }],
    conversations: [{ id: 'c', name: 'Main agent', provider: 'claude', origin: 'managed', history_format: 'jsonl' }],
    runs: [run(state)], messages: [{ id: 'u', role: 'user', body: 'Build the feature', source_ts: START }],
    message_memberships: [{ id: 'u', message_id: 'u', conversation_id: 'c', active: 1 }],
  } });
  target.setConnection('connected');
  return target;
}
it('starts and clears work from the parent turn state, without an inactivity timeout', () => {
  const turn = resolveWorkingTurn(run());
  expect(isWorkingTurn(turn)).toBe(true);
  expect(workingElapsed(turn, NOW)).toBe('3m 12s');
  expect(workingElapsed(turn, Date.parse(START) - 1000)).toBe('0s');
  expect(workingElapsed(turn, NOW + 600_000)).toBe('13m 12s');
  for (const state of ['idle', 'ended', 'failed', 'unknown']) expect(resolveWorkingTurn(run(state))).toBeUndefined();
  expect(isWorkingTurn(resolveWorkingTurn(run('starting')))).toBe(true);
});
it('uses only the projected start through tools and approval waits, and resets with the next turn', () => {
  const tool = run('running', { last_evidence_ts: '2026-10-11T00:02:00Z', last_evidence: { kind: 'tool_result' } });
  expect(workingElapsed(resolveWorkingTurn(tool), NOW)).toBe('3m 12s');
  const approval = resolveWorkingTurn({ ...tool, state: 'waiting_approval' });
  expect(isWorkingTurn(approval)).toBe(false);
  expect(workingElapsed(approval, NOW)).toBe('3m 12s');
  expect(workingElapsed(resolveWorkingTurn(tool), NOW)).toBe('3m 12s');
  expect(workingElapsed(resolveWorkingTurn(run('running', { turn_started_ts: '2026-10-11T00:03:00Z' })), NOW)).toBe('12s');
  expect(workingElapsed(resolveWorkingTurn({ ...tool, generation: 2, turn_started_ts: '2026-10-11T00:02:00Z' }), NOW)).toBe('1m 12s');
  expect(workingElapsed(resolveWorkingTurn({ ...tool, turn_started_ts: undefined }), NOW)).toBe('');
});
it('shows eleven minutes from the projected start even when the latest tool is eighteen seconds old', () => {
  const now = Date.parse(START) + 660_000;
  expect(workingElapsed(resolveWorkingTurn(run('running', { last_evidence_ts: new Date(now - 18_000).toISOString(), last_evidence: { kind: 'tool_call' } })), now)).toBe('11m 0s');
});
it('shows on turn start, ticks through waiting for a child and a background command, and disappears on parent completion', async () => {
  const target = setup();
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.queryByRole('status', { name: 'Working' })).toBeNull();
  function update(parentState: string, childState: string, toolName: string, input: Row = {}) {
    const snapshot = target.getSnapshot();
    act(() => target.setSnapshot({ ...snapshot, seq: snapshot.seq + 1, projection: { ...snapshot.projection,
      runs: [run(parentState, { last_evidence_ts: toolName === 'Agent' ? START : new Date().toISOString(),
        last_evidence: { kind: parentState === 'idle' ? 'turn_completed' : toolName === 'Agent' ? 'turn_started' : 'tool_call' } }),
        { id: 'child-run', conversation_id: 'child', generation: 1, state: childState }],
      relations: [{ id: 'child', type: 'delegated', from_id: 'c', to_id: 'child', active: 1 }],
      messages: [...snapshot.projection.messages.filter(row => row.id !== 'tool'), { id: 'tool', role: 'assistant', source_ts: '2026-10-11T00:01:00Z',
        body: [{ type: 'tool_use', id: 'call', name: toolName, input }] }],
      message_memberships: [...snapshot.projection.message_memberships, { id: 'tool', message_id: 'tool', conversation_id: 'c', active: 1 }],
    } }));
  }
  update('running', 'running', 'Agent', { description: 'Review the implementation' });
  const indicator = screen.getByRole('status', { name: 'Working' });
  expect(indicator.closest('.composer')).toBeTruthy();
  expect(indicator.textContent).toContain('Working · 3m 12s');
  expect(indicator.querySelector('.working-tool')?.textContent).toBe('Agent · Review the implementation');
  act(() => vi.advanceTimersByTime(60_000));
  expect(indicator.textContent).toContain('4m 12s');
  update('running', 'ended', 'wait');
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('4m 12s');
  update('running', 'ended', 'Bash', { command: 'long-task &', run_in_background: true });
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('timer').textContent).toContain('4m 13s');
  expect(screen.getByRole('status', { name: 'Working' }).querySelector('.working-tool')?.textContent).toBe('Waiting on a background task: Bash');
  update('idle', 'running', 'Bash');
  expect(screen.queryByRole('status', { name: 'Working' })).toBeNull();
});
it.each(['en', 'ja'] as const)('shows working even without a timestamp in %s', async language => {
  const target = setup('running'); const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, runs: [run('running', { turn_started_ts: undefined, last_evidence_ts: undefined, started_ts: undefined })], messages: [], message_memberships: [] } });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language={language}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: language === 'ja' ? '作業中' : 'Working' })).toBeTruthy();
  expect(screen.queryByRole('timer')).toBeNull();
});
it.each([START, undefined])('omits tools from an earlier turn with start evidence %s and recovers when it arrives late', async start => {
  const target = setup('running'); const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
    runs: [run('running', { turn_started_ts: start })],
    messages: [...snapshot.projection.messages, { id: 'old', role: 'assistant', source_ts: '2026-10-10T23:59:00Z', body: [{ type: 'tool_use', name: 'Old tool', input: {} }] }],
    message_memberships: [...snapshot.projection.message_memberships, { id: 'old', message_id: 'old', conversation_id: 'c', active: 1 }],
  } });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: 'Working' }).querySelector('.working-tool')).toBeNull();
  act(() => appendMessage(target, { id: 'current', role: 'assistant', source_ts: '2026-10-11T00:01:00Z', body: [{ type: 'tool_use', name: 'Current tool', input: {} }] }));
  expect(screen.getByRole('status', { name: 'Working' }).querySelector('.working-tool')?.textContent).toBe('Current tool');
  act(() => {
    const state = target.getSnapshot();
    target.setSnapshot({ ...state, projection: { ...state.projection, runs: [run()] } });
  });
  expect(screen.getByRole('status', { name: 'Working' }).querySelector('.working-tool')?.textContent).toBe('Current tool');
  expect(screen.getByRole('timer').textContent).toContain('3m 12s');
  const unknownStart = resolveWorkingTurn(run('running', { turn_started_ts: undefined, started_ts: undefined, last_evidence_ts: undefined }));
  expect(workingElapsed(unknownStart, NOW)).toBe('');
  expect(workingElapsed(resolveWorkingTurn(run()), NOW)).toBe('3m 12s');
});
it.each(['running', 'idle', 'waiting_approval', 'waiting_input'])('shows a named activity mark on the list and tab for %s', async state => {
  const target = setup(state);
  render(<MemoryRouter><RootList roots={selectRoots(target.getSnapshot())} state={target.getSnapshot()}/>
    <Workbench project="p" session="root" conversationId="c" client={client} language="en" renderConversation={id => <ConversationPage conversationId={id} target={target} client={client} embedded/>}/></MemoryRouter>);
  await act(async () => {});
  const tab = screen.getByRole('tab', { name: 'Main agent' });
  const label = { running: 'Working', idle: 'Idle', waiting_approval: 'Needs approval', waiting_input: 'Waiting' }[state];
  expect(tab.querySelector('.activity-mark .status-label')?.getAttribute('data-label')).toBe(label);
  expect(document.querySelector('.root-row-meta .status-label')?.textContent).toBe(label);
  expect(document.querySelector('.root-row .activity-mark')?.getAttribute('data-state')).toBe(state);
});
it('uses the projected clock without reading message bodies on list ticks', () => {
  const snapshot = setup('running').getSnapshot();
  const readMessageBody = vi.fn(() => 'Build the feature');
  const state: ScreenState = { ...snapshot, projection: { ...snapshot.projection,
    messages: [{ ...snapshot.projection.messages[0], get body() { return readMessageBody(); } }],
  } };
  render(<MemoryRouter><RootList roots={selectRoots(state)} state={state}/></MemoryRouter>);
  expect(readMessageBody).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByLabelText('Elapsed time').textContent).toBe('3m 13s');
  expect(readMessageBody).not.toHaveBeenCalled();
});
it('disables all activity animation for reduced motion and uses distinct shapes for running and waiting', () => {
  const css = readFileSync('app/src/styles.css', 'utf8');
  expect(css).toMatch(/\.status\.activity-mark\.status-running \.status-dot \{[^}]*working-spin/);
  expect(css).toMatch(/\.status\.activity-mark\.status-input \.status-dot \{[^}]*border-radius: 2px/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\* \{ animation: none !important;/);
});

it('uses the active root peer for the list, tab and composer even when the selected peer is unknown', async () => {
  const target = setup('running');
  const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
    roots: [{ ...snapshot.projection.roots[0], state: 'idle', conversation_ids: ['c', 'new'] }],
    conversations: [...snapshot.projection.conversations, { id: 'new', name: 'New peer', origin: 'observed', provider: 'claude' }],
    runs: [run('running', { last_evidence_ts: new Date(NOW - 18_000).toISOString() }),
      { id: 'new-run', conversation_id: 'new', generation: 2, state: 'unknown' }],
  } });
  vi.setSystemTime(Date.parse(START) + 660_000);
  render(<MemoryRouter><RootList roots={selectRoots(target.getSnapshot())} state={target.getSnapshot()}/>
    <Workbench project="p" session="root" conversationId="new" client={client} language="en"
      renderConversation={id => <ConversationPage conversationId={id} seriesState="idle" displayName="Main agent" target={target} client={client} embedded/>}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('11m 0s');
  expect(screen.getByLabelText('Elapsed time').textContent).toBe('11m 0s');
  expect(screen.getByRole('tab', { name: 'Main agent' }).querySelector('.activity-mark')?.getAttribute('data-state')).toBe('running');
  expect(document.querySelector('.root-row .activity-mark')?.getAttribute('data-state')).toBe('running');
});

it('does not infer a clock from a tool timestamp when projected start evidence is missing', () => {
  const tool = run('running', { turn_started_ts: undefined, last_evidence_ts: new Date(NOW - 18_000).toISOString(), last_evidence: { kind: 'tool_call' } });
  const turn = resolveWorkingTurn(tool);
  expect(isWorkingTurn(turn)).toBe(true);
  expect(workingElapsed(turn, NOW)).toBe('');
  expect(workingElapsed(resolveWorkingTurn({ ...tool, turn_started_ts: START }), NOW)).toBe('3m 12s');
});

it.each(['idle', 'running', 'waiting_approval'])('gives your turn the same priority and color on the list, tab and conversation for %s', async state => {
  const target = setup(state);
  const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
    roots: [...snapshot.projection.roots, { id: 'busy', name: 'Busy agent', state: 'running', conversation_ids: ['busy'], project: 'p' }],
    runs: [...snapshot.projection.runs, { id: 'busy-run', conversation_id: 'busy', generation: 1, state: 'running' }],
  } });
  publishTurns({ history: { read: {}, ready: {}, recent: [] }, turns: [
    { id: 'ready', kind: 'idle', conversationId: 'c', time: START, to: '/c/c' },
  ] });
  render(<MemoryRouter><RootList grouped roots={selectRoots(target.getSnapshot())} state={target.getSnapshot()}/>
    <Workbench project="p" session="root" conversationId="c" client={client} language="en"
      renderConversation={id => <ConversationPage conversationId={id} target={target} client={client} embedded/>}/></MemoryRouter>);
  await act(async () => {});
  const expected = state === 'waiting_approval' ? 'waiting_approval' : 'waiting_input';
  const row = screen.getByRole('link', { name: 'Main agent' });
  expect(row.closest('section')?.getAttribute('aria-label')).toBe('Your turn');
  expect(document.querySelectorAll('.session-group')[0]?.getAttribute('aria-label')).toBe('Your turn');
  expect(row.querySelector('.activity-mark')?.getAttribute('data-state')).toBe(expected);
  expect(row.querySelector('.root-elapsed')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Main agent' }).querySelector('.activity-mark')?.getAttribute('data-state')).toBe(expected);
  expect(screen.queryByRole('status', { name: 'Working' })).toBeNull();
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(document.querySelector('.conversation-page .state-badge')?.classList.contains(`status-${expected}`)).toBe(true);
});

it('places your turn and approval waits before running in an ungrouped list', () => {
  const snapshot = setup('idle').getSnapshot();
  const roots = [
    { id: 'busy', name: 'Busy', state: 'running', conversation_ids: ['busy'] },
    { id: 'approval', name: 'Approval', state: 'waiting_approval', conversation_ids: ['approval'] },
    ...snapshot.projection.roots,
  ];
  const state = { ...snapshot, projection: { ...snapshot.projection, roots,
    runs: [...snapshot.projection.runs,
      { id: 'busy', conversation_id: 'busy', generation: 1, state: 'running' },
      { id: 'approval', conversation_id: 'approval', generation: 1, state: 'waiting_approval' }],
  } };
  publishTurns({ history: { read: {}, ready: {}, recent: [] }, turns: [
    { id: 'ready', kind: 'idle', conversationId: 'c', time: START, to: '/c/c' },
  ] });
  render(<MemoryRouter><RootList roots={selectRoots(state)} state={state}/></MemoryRouter>);
  const rows = screen.getAllByRole('link');
  expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Approval', 'Main agent', 'Busy']);
  expect(rows[1].querySelector('.activity-mark')?.getAttribute('data-state')).toBe('waiting_input');
});

it('opens the production root body and shows its work in both list and conversation, then shows the child clock', async () => {
  const target = createStore();
  const facts = createRootlineFacts().map((input, index) => ({ ...input, seq: index + 1,
    fact_id: String(index), payload_hash: '', observed_ts: input.source_ts, schema_version: 1, cursor: null, supersedes: null })) as Fact[];
  const projection = JSON.parse(JSON.stringify(project(facts))) as Record<string, Row[]>;
  target.setSnapshot({ seq: facts.length, generation: 1, projection: {
    ...projection,
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
  } });
  vi.setSystemTime(Date.parse(START_ROOT) + 40_000);
  const root = selectRoots(target.getSnapshot())[0];
  expect(root.conversation_ids).toEqual([ROOT]);
  expect(currentRootConversation(root)).toBe(ROOT);
  const view = render(<MemoryRouter initialEntries={['/p/repo?root=' + encodeURIComponent(ROOT)]}>
    <RootList roots={[root]} state={target.getSnapshot()} language="en"/>
    <WorkspacePage project="repo" target={target} client={client}/>
  </MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('40s');
  expect(within(screen.getByRole('tablist', { name: 'Workspace tabs' })).getByRole('tab', { selected: true }).querySelector('.status-running')).toBeTruthy();
  expect(document.querySelector('.root-row .activity-mark')?.getAttribute('data-state')).toBe('running');
  expect(screen.queryByText('Review of Build a sample feature')).toBeNull();
  view.unmount();
  render(<MemoryRouter><ConversationPage conversationId={CHILD} target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain(
    workingElapsed(resolveWorkingTurn(projection.runs.find(row => row.conversation_id === CHILD)), Date.now()));
  expect(screen.getByRole('timer')).toBeTruthy();
});

it('opens a working continuation source even when an idle continuation has newer messages', () => {
  const target = setup('running');
  const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
    roots: [{ id: 'c', name: 'Main agent', project: 'p', state: 'running', current_conversation_id: 'c', conversation_ids: ['c', 'continued'] }],
    conversations: [...snapshot.projection.conversations, { id: 'continued', name: 'Later conversation', provider: 'claude', last_message_ts: '2026-10-11T00:03:00Z' }],
    runs: [...snapshot.projection.runs, { id: 'continued-run', conversation_id: 'continued', generation: 1, state: 'idle', last_evidence_ts: '2026-10-11T00:03:00Z' }],
  } });
  const root = selectRoots(target.getSnapshot())[0];
  expect(currentRootConversation(root)).toBe('c');
  render(<MemoryRouter><WorkspacePage project="p" target={target} client={client}/></MemoryRouter>);
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('3m 12s');
});

function appendMessage(target: ReturnType<typeof createStore>, row: Row) {
  const state = target.getSnapshot();
  target.setSnapshot({ ...state, seq: state.seq + 1, projection: { ...state.projection,
    messages: [...state.projection.messages, row],
    message_memberships: [...state.projection.message_memberships, { id: row.id, message_id: row.id, conversation_id: 'c', active: 1 }],
  } });
}
it('reuses reply and activity caches on every second tick and refreshes after a new message', async () => {
  const target = setup();
  appendMessage(target, { id: 'a', role: 'assistant', body: 'Ready.', source_ts: '2026-10-11T00:01:00Z' });
  const readGeneration = vi.fn(() => 2);
  const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, runs: [...snapshot.projection.runs,
    { id: 'other-old', conversation_id: 'other', generation: 1, state: 'idle' },
    { id: 'other-new', conversation_id: 'other', get generation() { return readGeneration(); }, state: 'idle' },
  ] } });
  const selectTimeline = vi.spyOn(conversationModel, 'selectTimeline');
  const resolveActivity = vi.spyOn(activityModel, 'resolveActivity');
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByText('Waiting for your reply')).toBeTruthy();
  expect(selectTimeline).toHaveBeenCalled();
  expect(readGeneration).toHaveBeenCalled();
  const historyState = resolveActivity.mock.calls.filter(([state]) => state !== target.getSnapshot()).at(-1)?.[0];
  expect(historyState).toBeTruthy();
  for (let tick = 0; tick < 3; tick++) {
    selectTimeline.mockClear(); resolveActivity.mockClear(); readGeneration.mockClear();
    act(() => vi.advanceTimersByTime(1000));
    expect(resolveActivity.mock.calls.some(([state]) => state === historyState)).toBe(true);
    expect(resolveActivity.mock.calls.every(([state]) => state === historyState || state === target.getSnapshot())).toBe(true);
    expect(selectTimeline).not.toHaveBeenCalled();
    expect(readGeneration).not.toHaveBeenCalled();
    expect(screen.getByText('Waiting for your reply')).toBeTruthy();
  }
  act(() => appendMessage(target, { id: 'question', role: 'assistant', body: 'Continue?', source_ts: '2026-10-11T00:02:00Z' }));
  expect(selectTimeline).toHaveBeenCalled();
  expect(screen.getByText('Needs your answer')).toBeTruthy();
});
it.each(['en', 'ja'] as const)('shows an idle root awaiting a reply in the composer, sidebar and tab in %s', async language => {
  const target = setup();
  appendMessage(target, { id: 'a', role: 'assistant', body: 'The changes are ready.', source_ts: '2026-10-11T00:01:00Z' });
  const state = target.getSnapshot();
  render(<MemoryRouter><RootList roots={selectRoots(state)} state={state} language={language}/>
    <Workbench project="p" session="root" conversationId="c" client={client} language={language}
      renderConversation={id => <ConversationPage conversationId={id} target={target} client={client} embedded language={language}/>}/></MemoryRouter>);
  await act(async () => {});
  const reply = screen.getByText(language === 'ja' ? 'あなたの返事を待っています' : 'Waiting for your reply');
  expect(reply.closest('.composer')).toBeTruthy();
  expect(document.querySelector('.root-row-meta .status-label')?.textContent).toBe(language === 'ja' ? 'あなたの番' : 'Your turn');
  expect(screen.getByRole('tab', { name: 'Main agent' }).querySelector('.status-label')?.getAttribute('data-label')).toBe(language === 'ja' ? 'あなたの番' : 'Your turn');
});
it.each([
  ['idle', 'Shall I continue?', 'en', 'Needs your answer'],
  ['waiting_input', '進めますか？', 'ja', '回答が必要です'],
  ['idle', '進めますか。', 'ja', '回答が必要です'],
  ['idle', 'こちらですか。', 'ja', '回答が必要です'],
  ['idle', 'こちらでしょうか', 'ja', '回答が必要です'],
  ['idle', '進めませんか。', 'ja', '回答が必要です'],
  ['idle', 'Run this:\n```sh\necho hi?\n```', 'en', 'Waiting for your reply'],
  ['idle', 'Run `echo hi?`', 'en', 'Waiting for your reply'],
  ['idle', 'Run this:\n```sh\necho hi?\n```\nShall I continue?', 'en', 'Needs your answer'],
  ['idle', 'Use `echo hi`?', 'en', 'Needs your answer'],
  ['idle', 'そうか。', 'ja', 'あなたの返事を待っています'],
] as const)('uses a stronger reply cue for a question in %s', async (state, body, language, label) => {
  const target = setup(state);
  appendMessage(target, { id: 'a', role: 'assistant', body, source_ts: '2026-10-11T00:01:00Z' });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language={language}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByText(label).classList.contains('reply-required')).toBe(['Needs your answer', '回答が必要です'].includes(label));
});
it('requires an answer for an unanswered question tool and clears it after its result', async () => {
  const target = setup('waiting_input');
  appendMessage(target, { id: 'a', role: 'assistant', source_ts: '2026-10-11T00:01:00Z', body: [{ type: 'tool_use', id: 'question', name: 'AskUserQuestion', input: { questions: [] } }] });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByText('Needs your answer')).toBeTruthy();
  act(() => appendMessage(target, { id: 'result', role: 'user', source_ts: '2026-10-11T00:02:00Z', body: [{ type: 'tool_result', tool_use_id: 'question', content: 'Yes' }] }));
  expect(screen.queryByText('Needs your answer')).toBeNull();
  expect(screen.getByText('Waiting for your reply')).toBeTruthy();
});
it.each(['running', 'ended', 'failed', 'unknown', 'child', 'user-last'])('does not show a reply cue for %s', async kind => {
  const target = setup(['child', 'user-last'].includes(kind) ? 'idle' : kind);
  appendMessage(target, { id: 'a', role: 'assistant', body: 'Continue?', source_ts: '2026-10-11T00:01:00Z' });
  if (kind === 'user-last') appendMessage(target, { id: 'answer', role: 'user', body: 'Yes', source_ts: '2026-10-11T00:02:00Z' });
  if (kind === 'child') {
    const state = target.getSnapshot();
    target.setSnapshot({ ...state, projection: { ...state.projection, relations: [{ id: 'child', type: 'delegated', from_id: 'parent', to_id: 'c', active: 1 }] } });
  }
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.queryByText('Waiting for your reply')).toBeNull();
  expect(screen.queryByText('Needs your answer')).toBeNull();
});
it.each([
  ['en', 'Bash', { description: 'Run the checks', command: 'node --test' }, 'Bash · Run the checks'],
  ['en', 'Bash', { description: 'Wait for review', command: 'agc wait review' }, 'Waiting on a background task: Wait for review'],
  ['ja', 'Bash', { description: '検証を実行', run_in_background: true }, '裏の作業を待っています: 検証を実行'],
  ['en', 'Monitor', { description: 'Watch the checks' }, 'Waiting on a background task: Watch the checks'],
  ['en', 'wait', { description: 'Wait for the child' }, 'Waiting on a background task: Wait for the child'],
] as const)('shows the latest tool description while running in %s with %s', async (language, name, input, label) => {
  const target = setup('running');
  appendMessage(target, { id: 'a', role: 'assistant', source_ts: '2026-10-11T00:01:00Z', body: [{ type: 'tool_use', id: 'tool', name, input }] });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language={language}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: language === 'ja' ? '作業中' : 'Working' }).textContent).toContain(label);
  expect(document.querySelector('.tool-run summary')?.textContent).toContain(input.description);
  expect(screen.queryByText('Waiting for your reply')).toBeNull();
  expect(screen.queryByText('Needs your answer')).toBeNull();
});
it.each(['running', 'idle'])('suppresses reply cues for pending input and preserves delivery indicators while %s', async stateName => {
  const target = setup(stateName);
  appendMessage(target, { id: 'a', role: 'assistant', body: 'Continue?', source_ts: '2026-10-11T00:01:00Z' });
  const state = target.getSnapshot();
  target.setSnapshot({ ...state, projection: { ...state.projection,
    conversations: [{ ...state.projection.conversations[0], pending_inputs: [{ id: 'queued', body: 'Yes', source_ts: '2026-10-11T00:02:00Z' }] }],
  } });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  if (stateName === 'running') expect(screen.getByText('Queued — Claude will read this after the current step')).toBeTruthy();
  expect(screen.queryByText('Needs your answer')).toBeNull();
  expect(screen.queryByText('Waiting for your reply')).toBeNull();
});

it.each([undefined, 'invalid'])('uses the latest user timestamp when start is %s, without showing a previous turn tool', async start => {
  const target = setup('running');
  const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, runs: [run('running', { turn_started_ts: start })] } });
  appendMessage(target, { id: 'old-tool', role: 'assistant', source_ts: '2026-10-10T23:59:00Z', body: [{ type: 'tool_use', name: 'Previous tool', input: {} }] });
  appendMessage(target, { id: 'result', role: 'user', source_ts: '2026-10-11T00:01:00Z', body: [{ type: 'tool_result', content: 'Done', tool_use_id: 'old-tool' }] });
  appendMessage(target, { id: 'report', role: 'agent_report', source_ts: '2026-10-11T00:02:00Z', body: '## Done' });
  const state = target.getSnapshot();
  render(<MemoryRouter><RootList roots={selectRoots(state)} state={state}/><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  const indicator = screen.getByRole('status', { name: 'Working' });
  expect(indicator.closest('.composer')).toBeTruthy();
  expect(indicator.textContent).toContain('3m 12s');
  expect(indicator.querySelector('.working-tool')).toBeNull();
  expect(screen.getByLabelText('Elapsed time').textContent).toBe('3m 12s');
});
it('uses UserPromptSubmit evidence for a missing clock even before messages arrive', () => {
  const turn = resolveWorkingTurn(run('running', { turn_started_ts: undefined, last_evidence: { hook_event_name: 'UserPromptSubmit' } }));
  expect(workingElapsed(turn, NOW)).toBe('3m 12s');
});
