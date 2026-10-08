import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Inbox } from '../src/pages/inbox/Inbox.tsx';
import { answerApproval } from '../src/pages/inbox/model.ts';
import { createStore, type Row } from '../src/lib/store.ts';

afterEach(cleanup);
const NOW = '2026-10-07T10:00:00Z';
function setup(rows: Row[] = []) {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: { approvals: rows,
    runs: [{ id: 'run', conversation_id: 'conversation', state: 'waiting_approval', last_evidence_ts: NOW }],
    messages: [{ id: 'message', role: 'assistant', body: 'Please review this change.', body_state: 'stored', source_ts: NOW }],
    message_memberships: [{ id: 'link', message_id: 'message', conversation_id: 'conversation', active: 1 }] } });
  const client = { command: vi.fn(async (_command: string, _payload?: unknown) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })) };
  render(<Inbox client={client} target={target}/>);
  return { target, client };
}
function approval(id: string, overrides: Row = {}): Row {
  return { id, state: 'pending', run_id: 'run', conversation_id: 'conversation', requested_ts: NOW,
    available_decisions: ['accept', 'decline', 'acceptForSession'], request: { command: 'printf "full command"\necho next', diff: '-old\n+new' }, ...overrides };
}
it('orders all projects oldest first, displays commands, expanded diffs, wait and conversation tail', () => {
  // 待ち時間は今の時刻に依存するため、時計を固定する。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.parse(NOW) + 42_000));
  onTestFinished(() => { vi.useRealTimers(); });
  setup([approval('new', { project: 'p2', requested_ts: '2026-10-07T11:00:00Z' }), approval('old', { project: 'p1' })]);
  const list = screen.getByRole('list', { name: 'Pending approvals' });
  expect(within(list).getAllByRole('listitem').map(item => item.dataset.approvalId)).toEqual(['old', 'new']);
  expect(screen.getAllByLabelText('Full command')[0].textContent).toBe('printf "full command"\necho next');
  expect(screen.getAllByLabelText('Expanded file diff')[0].textContent).toBe('-old\n+new');
  expect(screen.getAllByText(/Waiting/)[0].textContent).toBe('Waiting 42s');
  fireEvent.click(screen.getAllByText('Recent messages')[0]);
  expect(screen.getAllByText('Please review this change.')).toHaveLength(2);
});
it.each([['Allow', 'accept'], ['Deny', 'decline'], ['Always allow', 'acceptForSession']])('answers %s with the offered decision', async (label, decision) => {
  const { client } = setup([approval('a')]);
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'a', decision }));
  await screen.findByText('Sent');
  expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
});
it('answers selected requests once each and excludes expired requests', async () => {
  const { client } = setup([approval('a'), approval('b'), approval('expired', { state: 'expired', reason: 'restart' })]);
  fireEvent.click(screen.getByLabelText('Select all pending'));
  fireEvent.click(screen.getByRole('button', { name: 'Deny selected' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledTimes(2));
  expect(client.command.mock.calls).toEqual([['answer', { approvalId: 'a', decision: 'decline' }], ['answer', { approvalId: 'b', decision: 'decline' }]]);
  expect(within(screen.getByRole('list', { name: 'Expired approvals' })).getAllByRole('listitem')).toHaveLength(1);
});
it('resumes expired requests with a non-empty prompt without answering them', async () => {
  const { client } = setup([approval('expired', { state: 'expired' })]);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('resume', { conversationId: 'conversation', input: { text: 'Continue from where you stopped.' } }));
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
});
it.each([['a', 'accept'], ['d', 'decline'], ['s', 'acceptForSession']])('supports single key %s on a focused row', async (key, decision) => {
  const { client } = setup([approval('a')]);
  const row = screen.getByRole('list', { name: 'Pending approvals' }).querySelector('li')!;
  row.focus(); fireEvent.keyDown(row, { key });
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'a', decision }));
});
it('uses selected rows for shortcuts and ignores text inputs, modifiers and repeats', async () => {
  const { client } = setup([approval('a'), approval('b')]);
  fireEvent.click(screen.getByLabelText('Select all pending'));
  fireEvent.keyDown(screen.getByLabelText('Select a'), { key: 'a' });
  fireEvent.keyDown(screen.getByRole('region', { name: 'Approvals' }), { key: 'a', ctrlKey: true });
  fireEvent.keyDown(screen.getByRole('region', { name: 'Approvals' }), { key: 'a', repeat: true });
  expect(client.command).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('region', { name: 'Approvals' }), { key: 's' });
  await waitFor(() => expect(client.command).toHaveBeenCalledTimes(2));
});
it('does not invent conversation permissions or expire a long waiting approval', async () => {
  const { client } = setup([approval('a', { available_decisions: ['allow', 'deny'], requested_ts: '2020-01-01T00:00:00Z' })]);
  expect((screen.getByRole('button', { name: 'Always allow' }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByRole('list', { name: 'Pending approvals' })).getAllByRole('listitem')).toHaveLength(1);
  await expect(answerApproval(client, approval('a', { available_decisions: ['allow', 'deny'] }), 'session')).rejects.toThrow('not available');
});
it('reports partial bulk failure and allows retry only for the failed request', async () => {
  const { client } = setup([approval('a'), approval('b')]);
  client.command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'cmd', ok: true }).mockResolvedValueOnce({ type: 'ack', cmd_id: 'cmd', ok: false });
  fireEvent.click(screen.getByLabelText('Select all pending'));
  fireEvent.click(screen.getByRole('button', { name: 'Allow selected' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Allow selected' }));
  await waitFor(() => expect(client.command).toHaveBeenCalledTimes(3));
  expect(client.command.mock.calls[2]).toEqual(['answer', { approvalId: 'b', decision: 'accept' }]);
});
