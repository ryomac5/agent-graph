import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { ConversationPage, type ConversationClient } from '../pages/conversation/ConversationPage.tsx';
import { RootList } from '../components/RootViews.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { createStore, type Row } from '../lib/store.ts';
import { selectRoots } from '../lib/roots.ts';
import { isWorkingTurn, resolveWorkingTurn, workingElapsed } from '../lib/turns.ts';

const START = '2026-10-11T00:00:00Z';
const NOW = Date.parse(START) + 192_000;
const run = (state = 'running', extra: Row = {}): Row => ({ id: 'r', conversation_id: 'c', generation: 1, state,
  started_ts: '2026-10-10T00:00:00Z', last_evidence_ts: START, last_evidence: { kind: 'turn_started' }, ...extra });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
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
  for (const state of ['idle', 'ended', 'failed', 'unknown']) expect(resolveWorkingTurn(run(state), START, turn)).toBeUndefined();
  expect(isWorkingTurn(resolveWorkingTurn(run('starting')))).toBe(true);
});
it('keeps the clock through tool results and approval waits and resets on the next turn or generation', () => {
  const first = resolveWorkingTurn(run());
  const tool = run('running', { last_evidence_ts: '2026-10-11T00:02:00Z', last_evidence: { kind: 'tool_result' } });
  const next = resolveWorkingTurn(tool, '', first);
  expect(workingElapsed(next, NOW)).toBe('3m 12s');
  const approval = resolveWorkingTurn({ ...tool, state: 'waiting_approval' }, '', next);
  expect(isWorkingTurn(approval)).toBe(false);
  expect(workingElapsed(resolveWorkingTurn(tool, '', approval), NOW)).toBe('3m 12s');
  const newTurn = resolveWorkingTurn(run('running', { last_evidence_ts: '2026-10-11T00:03:00Z' }), '', next);
  expect(workingElapsed(newTurn, NOW)).toBe('12s');
  expect(workingElapsed(resolveWorkingTurn({ ...tool, id: 'new', generation: 2 }, '', next), NOW)).toBe('1m 12s');
});
it('uses the user message when the start evidence has been replaced, with a timestamp fallback for a limited history window', () => {
  const tool = run('running', { last_evidence: { kind: 'tool_call' }, last_evidence_ts: '2026-10-11T00:02:00Z' });
  expect(workingElapsed(resolveWorkingTurn(tool, START), NOW)).toBe('3m 12s');
  expect(workingElapsed(resolveWorkingTurn(tool), NOW)).toBe('1m 12s');
  expect(workingElapsed(resolveWorkingTurn(run('running', { started_ts: undefined, last_evidence_ts: undefined })), NOW)).toBe('');
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
  target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, runs: [run('running', { last_evidence_ts: undefined, started_ts: undefined })], messages: [], message_memberships: [] } });
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
  const unknownStart = resolveWorkingTurn(run('running', { started_ts: undefined, last_evidence_ts: undefined }));
  expect(workingElapsed(resolveWorkingTurn(run(), '', unknownStart), NOW)).toBe('3m 12s');
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
it('disables all activity animation for reduced motion and uses distinct shapes for running and waiting', () => {
  const css = readFileSync('app/src/styles.css', 'utf8');
  expect(css).toMatch(/\.status\.activity-mark\.status-running \.status-dot \{[^}]*working-spin/);
  expect(css).toMatch(/\.status\.activity-mark\.status-input \.status-dot \{[^}]*border-radius: 2px/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\* \{ animation: none !important;/);
});
