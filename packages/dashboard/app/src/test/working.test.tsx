import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { ConversationPage, type ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { RootList } from '../components/RootViews.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { createStore, type Row, type ScreenState } from '../lib/store.ts';
import { selectRoots } from '../lib/roots.ts';
import { isWorkingTurn, publishTurns, resolveWorkingTurn, workingElapsed } from '../lib/turns.ts';

const START = '2026-10-11T00:00:00Z';
const NOW = Date.parse(START) + 192_000;
const run = (state = 'running', extra: Row = {}): Row => ({ id: 'r', conversation_id: 'c', generation: 1, state,
  turn_started_ts: START, started_ts: '2026-10-10T00:00:00Z', last_evidence_ts: START, last_evidence: { kind: 'turn_started' }, ...extra });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); publishTurns(); vi.useRealTimers(); vi.unstubAllGlobals(); });
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
  expect(indicator.querySelector('.working-tool')?.textContent).toBe('Review the implementation');
  act(() => vi.advanceTimersByTime(60_000));
  expect(indicator.textContent).toContain('4m 12s');
  update('running', 'ended', 'wait');
  expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('4m 12s');
  update('running', 'ended', 'Bash', { command: 'long-task &', run_in_background: true });
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('timer').textContent).toContain('4m 13s');
  expect(screen.getByRole('status', { name: 'Working' }).querySelector('.working-tool')?.textContent).toBe('Bash');
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
it('omits tools from an earlier turn and recovers the clock when start evidence arrives late', async () => {
  const target = setup('running'); const snapshot = target.getSnapshot();
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection,
    messages: [...snapshot.projection.messages, { id: 'old', role: 'assistant', source_ts: '2026-10-10T23:59:00Z', body: [{ type: 'tool_use', name: 'Old tool', input: {} }] }],
    message_memberships: [...snapshot.projection.message_memberships, { id: 'old', message_id: 'old', conversation_id: 'c', active: 1 }],
  } });
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client}/></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('status', { name: 'Working' }).querySelector('.working-tool')).toBeNull();
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
