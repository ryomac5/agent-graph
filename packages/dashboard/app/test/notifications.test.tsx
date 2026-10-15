import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Notifications } from '../src/components/notifications/Notifications.tsx';
import { collectNotifications, loadPreferences, NOTIFICATION_KINDS, PREFERENCES_KEY } from '../src/components/notifications/model.ts';
import { createStore, type ScreenState } from "../src/test/current-fixture.ts";

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function snapshot(projection: ScreenState['projection'] = {}, seq = 1): ScreenState {
  return { seq, generation: 0, projection, connection: 'connected', deltas: {} };
}
function setup() {
  const target = createStore();
  target.setSnapshot(snapshot()); target.setConnection('connected');
  const client = { command: vi.fn(async (_command: string, _payload?: unknown) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })) };
  render(<Notifications client={client} target={target}/>);
  return { target, client };
}
const pending = { id: 'approval', state: 'pending', run_id: 'run', conversation_id: 'conversation',
  request: { command: 'echo full approval command' }, available_decisions: ['allow', 'deny'] };
it('classifies every notification type and distinguishes unknown from completed', () => {
  const before = snapshot({ runs: [{ id: 'r', state: 'running' }] });
  const next = snapshot({ send_watches: [{ id: 'delivery', state: 'rejected', decision: { display: 'Not delivered' }, body: 'missing text', conversation_id: 'conversation', failed_ts: new Date().toISOString() }], approvals: [pending, { id: 'review', state: 'stale', reason: 'patch changed' }],
    state_decisions: [{ id: 'failure', result: { value: 'failed' } }], runs: [{ id: 'r', state: 'unknown', conversation_id: 'c', reason: 'Disconnected', last_evidence: { fact_id: 'fact' }, last_evidence_ts: '2026-10-07' },
      { id: 'input', state: 'waiting_input', last_evidence_ts: new Date().toISOString() }, { id: 'failed', state: 'idle', decision_id: 'failure', cause: 'error', last_evidence_ts: new Date().toISOString() },
      { id: 'end', state: 'idle', end_evidence: { kind: 'host_exit', exit_code: 0 }, last_evidence_ts: new Date().toISOString() }] }, 2);
  next.connection = 'runner_unavailable';
  const notices = collectNotifications(before, next);
  expect(new Set(notices.map(notice => notice.kind))).toEqual(new Set(NOTIFICATION_KINDS));
  expect(notices.some(notice => notice.conversationId === 'c')).toBe(false);
  expect(notices.filter(notice => notice.kind === 'completed')).toHaveLength(1);
  expect(collectNotifications(next, next)).toEqual([]);
});
it('does not replay historical completion on initial load or notify merely for elapsed time', () => {
  const current = snapshot({ runs: [{ id: 'a', state: 'idle' }, { id: 'b', state: 'running', started_ts: '2020-01-01' }] });
  expect(collectNotifications(undefined, current)).toEqual([]);
  expect(collectNotifications(snapshot(), current)).toEqual([]);
  expect(collectNotifications(current, { ...current, seq: 100, deltas: { run: { runId: 'b', text: 'delta' } } })).toEqual([]);
});
it('一覧を後から読み足した古い実行は、終わったばかりとして通知しない', () => {
  const before = snapshot({ runs: [{ id: 'known', state: 'running' }] });
  const next = snapshot({ runs: [{ id: 'known', state: 'running' }, { id: 'old', state: 'idle', last_evidence_ts: '2026-09-01T00:00:00Z' },
    { id: 'old-failed', state: 'idle', decision_id: 'failure', last_evidence_ts: '2026-09-01T00:00:00Z' }] }, 2);
  expect(collectNotifications(before, next, 'ja', Date.parse('2026-10-08T00:00:00Z'))).toEqual([]);
});
it('saves per-kind settings and recovers invalid saved preferences', async () => {
  setup();
  fireEvent.click(screen.getByText('Settings'));
  fireEvent.change(screen.getByLabelText('Run failed'), { target: { value: 'silent' } });
  await waitFor(() => expect(loadPreferences(localStorage).failed).toBe('silent'));
  expect(loadPreferences(localStorage).completed).toBe('in_app');
  localStorage.setItem(PREFERENCES_KEY, '{broken');
  expect(loadPreferences(localStorage).failed).toBe('in_app');
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ failed: 'bad', input: 'browser' }));
  expect(loadPreferences(localStorage).failed).toBe('in_app');
  expect(loadPreferences(localStorage).input).toBe('browser');
});
it('answers approvals directly in notifications and marks expired requests unavailable', async () => {
  const { target, client } = setup();
  act(() => target.setSnapshot(snapshot({ approvals: [pending] }, 2)));
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'approval', decision: 'allow' }));
  await screen.findByText('Sent');
  act(() => target.setSnapshot(snapshot({ approvals: [{ ...pending, state: 'expired' }] }, 3)));
  expect(screen.getByText('Approval expired')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
});
it('suppresses silent kinds and unknown executions', () => {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ failed: 'silent' }));
  const { target } = setup();
  act(() => target.setSnapshot(snapshot({ runs: [{ id: 'f', state: 'idle', decision_id: 'failure' }, { id: 'u', state: 'unknown',
    conversation_id: 'conversation', last_evidence: 'Last event', last_evidence_ts: '2026-10-07', reason: 'Lost connection' }] }, 2)));
  expect(screen.queryByRole('heading', { name: 'Run failed' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Run unknown' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Conversation' })).toBeNull();
  expect(screen.getByText('No notifications yet')).toBeTruthy();
});
it('requests browser permission only on preference change and opens inline approval from browser click', async () => {
  const created: FakeNotification[] = [];
  class FakeNotification {
    static permission = 'default';
    static requestPermission = vi.fn(async () => { FakeNotification.permission = 'granted'; return 'granted'; });
    onclick?: () => void;
    onclose?: () => void;
    close = vi.fn();
    title: string;
    options: unknown;
    constructor(title: string, options: unknown) { this.title = title; this.options = options; created.push(this); }
  }
  vi.stubGlobal('Notification', FakeNotification);
  const { target, client } = setup();
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Approval pending'), { target: { value: 'browser' } });
  await waitFor(() => expect(FakeNotification.permission).toBe('granted'));
  fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
  act(() => target.setSnapshot(snapshot({ approvals: [pending] }, 2)));
  expect(created).toHaveLength(1); expect(created[0].title).toBe('Approval pending');
  act(() => created[0].onclick?.());
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'approval', decision: 'deny' }));
  act(() => target.setSnapshot(snapshot({ approvals: [pending] }, 2)));
  expect(created).toHaveLength(1);
});
it('reports browser permission denial and keeps the in-app notification', async () => {
  class DeniedNotification { static permission = 'denied'; }
  vi.stubGlobal('Notification', DeniedNotification);
  const { target } = setup();
  fireEvent.change(screen.getByLabelText('Approval pending'), { target: { value: 'browser' } });
  await screen.findByText('Browser notifications are blocked; notifications will appear here.');
  act(() => target.setSnapshot(snapshot({ approvals: [pending] }, 2)));
  expect(screen.getByRole('heading', { name: 'Approval pending' })).toBeTruthy();
});
it('keeps connection faults out of notifications during snapshot resync', () => {
  const { target } = setup();
  act(() => target.setConnection('runner_unavailable'));
  act(() => target.setConnection('reconnecting'));
  expect(screen.queryByRole('heading', { name: 'Connection error' })).toBeNull();
  act(() => target.setConnection('reconnecting'));
  expect(screen.queryByRole('heading', { name: 'Connection error' })).toBeNull();
  act(() => target.setConnection('connected'));
  act(() => target.setConnection('reconnecting'));
  expect(screen.queryByRole('heading', { name: 'Connection error' })).toBeNull();
});

it('shows a delivery failure in the bell at the same ledger seq, with excerpt and conversation link', async () => {
  const { target } = setup();
  const seq = target.getSnapshot().seq;
  act(() => target.setSendWatches([{ id: 'sent', state: 'rejected', decision: { display: 'Not delivered' }, body: 'Please check the delivery', conversation_id: 'c', failed_ts: '2026-10-13T10:00:00Z' }]));
  expect(await screen.findByRole('heading', { name: 'A message you sent did not reach the conversation' })).toBeTruthy();
  expect(screen.getByText('Please check the delivery')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Conversation' }).getAttribute('href')).toBe('/c/c');
  expect(target.getSnapshot().seq).toBe(seq);
  act(() => target.setSendWatches([{ id: 'sent', state: 'rejected', decision: { display: 'Not delivered' }, body: 'Please check the delivery', conversation_id: 'c' }]));
  expect(screen.getAllByRole('heading', { name: 'A message you sent did not reach the conversation' })).toHaveLength(1);
});

it('removes delivery failures from the bell when a late message arrives or retention expires', async () => {
  const { target } = setup();
  act(() => target.setSendWatches([{ id: 'sent', state: 'rejected', decision: { display: 'Not delivered' }, body: 'Late delivery', conversation_id: 'c' }]));
  expect(await screen.findByText('Late delivery')).toBeTruthy();
  act(() => target.setSendWatches([]));
  expect(screen.queryByText('Late delivery')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'A message you sent did not reach the conversation' })).toBeNull();
});

it('通知は API の結果を読み、同じ idle の失敗への変化と次 turn の完了を通知する', () => {
  const running = snapshot({ runs: [{ id: 'r', state: 'running', decision_id: 'running' }] });
  const idle = snapshot({ runs: [{ id: 'r', state: 'idle', decision_id: 'done' }], state_decisions: [{ id: 'done', result: { value: 'not_applicable' } }] }, 2);
  expect(collectNotifications(running, idle).map(row => row.kind)).toEqual(['completed']);
  const failed = snapshot({ runs: [{ id: 'r', state: 'idle', decision_id: 'failed' }], state_decisions: [{ id: 'failed', result: { value: 'failed' } }] }, 3);
  expect(collectNotifications(idle, failed).map(row => row.kind)).toEqual(['failed']);
  expect(collectNotifications(failed, failed)).toEqual([]);
  for (const state of ['stopped', 'not_hosted', 'unknown', 'closed']) expect(collectNotifications(running, snapshot({ runs: [{ id: 'r', state }] }, 4))).toEqual([]);
});
