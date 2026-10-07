import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WorkspacePage } from '../src/pages/workspace/WorkspacePage.tsx';
import type { Ack } from '../src/lib/client.ts';
import { createActivityStore } from './home.test.tsx';

afterEach(cleanup);
function createCommandClient() {
  return { command: vi.fn(async (_command: string, _payload?: unknown, cmdId?: string): Promise<Ack> => ({ type: 'ack', cmd_id: cmdId ?? 'cmd', ok: true })) };
}
function fillTaskForm() {
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Build feature' } });
  fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'Implement feature and validate it.' } });
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'claude' } });
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'test-claude-model' } });
  fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } });
  fireEvent.change(screen.getByLabelText('Agents'), { target: { value: '3' } });
}
it('creates concurrent intake delegations with selected provider, model, effort and independent stable command IDs', async () => {
  const client = createCommandClient();
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
  fillTaskForm();
  await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Create task' })));
  expect(client.command).toHaveBeenCalledTimes(3);
  const ids = new Set<string>();
  client.command.mock.calls.forEach(([command, payload, cmdId], index) => {
    expect(command).toBe('intake.submit');
    expect(cmdId).toBeTruthy(); ids.add(cmdId!);
    expect(payload).toEqual({ requestId: `ui:${JSON.stringify([cmdId])}`, source: 'ui', role: 'implement',
      title: `Build feature (${index + 1}/3)`, task: 'Implement feature and validate it.', accept: [],
      cwd: '/repo/alpha', project: '/repo/alpha', provider: 'claude', model: 'test-claude-model', effort: 'high', constraints: { excludeFamily: ['openai'] } });
  });
  expect(ids.size).toBe(3);
  expect(screen.getByText('3/3 requests accepted')).toBeTruthy();
});
it('sends all delegations before acknowledgements arrive and prevents duplicate submissions', async () => {
  const resolves: ((ack: Ack) => void)[] = [];
  const client = { command: vi.fn(() => new Promise<Ack>(resolve => resolves.push(resolve))) };
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
  fillTaskForm(); fireEvent.submit(screen.getByRole('form', { name: 'Create task' }));
  expect(client.command).toHaveBeenCalledTimes(3);
  fireEvent.submit(screen.getByRole('form', { name: 'Create task' }));
  expect(client.command).toHaveBeenCalledTimes(3);
  await act(async () => resolves.forEach(resolve => resolve({ type: 'ack', cmd_id: 'id', ok: true })));
});
it('stops the selected run with interrupt and keeps observed state until a patch arrives', async () => {
  const client = createCommandClient();
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop run' })));
  expect(client.command).toHaveBeenCalledWith('interrupt', { runId: 'r1' });
  expect(screen.getByRole('link', { name: 'Running · Evidence' })).toBeTruthy();
});
it('places parallel runs in the task column and selects their conversation and Changes', () => {
  const target = createActivityStore();
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    conversations: { remove: [], upsert: [{ id: 'parallel', task_id: 't1', provider: 'claude', origin: 'managed', name: 'Implement API', name_is_provisional: false, first_request_excerpt: null }] },
    runs: { remove: [], upsert: [{ id: 'r4', conversation_id: 'parallel', state: 'waiting_input', generation: 1 }] },
    messages: { remove: [], upsert: [{ id: 'pm', role: 'assistant', body: 'Parallel response' }] },
    message_memberships: { remove: [], upsert: [{ id: 'pl', message_id: 'pm', conversation_id: 'parallel', active: 1 }] },
  } }));
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={target} client={createCommandClient()}/></MemoryRouter>);
  const tasks = screen.getByRole('region', { name: 'Tasks' });
  expect(within(tasks).getAllByRole('article', { name: 'Implement API' })).toHaveLength(2);
  expect(within(tasks).queryByRole('article', { name: 'Review UI' })).toBeNull();
  fireEvent.click(within(tasks).getAllByRole('button', { name: 'Implement API' })[1]);
  expect(within(screen.getByRole('region', { name: 'Conversation' })).getByText('Parallel response')).toBeTruthy();
  expect(screen.getByText('Not reported')).toBeTruthy();
  expect(within(screen.getByRole('complementary', { name: 'Changes' })).getByText('No artifact yet')).toBeTruthy();
});
it('disables commands without the runner and reports rejected stop commands', async () => {
  const target = createActivityStore(); const client = createCommandClient();
  target.setConnection('runner_unavailable');
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={target} client={client}/></MemoryRouter>);
  const stop = screen.getByRole('button', { name: 'Stop run' }) as HTMLButtonElement;
  expect(stop.disabled).toBe(true); fireEvent.click(stop); expect(client.command).not.toHaveBeenCalled();
  act(() => target.setConnection('connected'));
  client.command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'id', ok: false, error: 'Run is not open' });
  await act(async () => fireEvent.click(stop));
  expect(screen.getByRole('alert').textContent).toBe('Run is not open');
});
it('reports partial creation failure without hiding successful requests', async () => {
  const client = createCommandClient();
  client.command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'id', ok: false, error: 'Runner unavailable' });
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
  fillTaskForm();
  await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Create task' })));
  expect(screen.getByText('2/3 requests accepted · Runner unavailable')).toBeTruthy();
});
