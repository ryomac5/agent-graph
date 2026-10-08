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
  fireEvent.click(screen.getByRole('button', { name: 'New task' }));
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
  await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'New task' })));
  expect(client.command.mock.calls.filter(([name]) => name === 'intake.submit')).toHaveLength(3);
  const ids = new Set<string>();
  client.command.mock.calls.filter(([name]) => name === 'intake.submit').forEach(([command, payload, cmdId], index) => {
    expect(command).toBe('intake.submit');
    expect(cmdId).toBeTruthy(); ids.add(cmdId!);
    expect(payload).toEqual({ requestId: `ui:${JSON.stringify([cmdId])}`, source: 'ui', role: 'implement',
      title: `Build feature (${index + 1}/3)`, task: 'Implement feature and validate it.', accept: [],
      cwd: '/repo/alpha', project: '/repo/alpha', provider: 'claude', model: 'test-claude-model', effort: 'high', constraints: { excludeFamily: ['openai'] } });
  });
  expect(ids.size).toBe(3);
  expect(screen.getByText('3/3 requests started')).toBeTruthy();
});
it('sends all delegations before acknowledgements arrive and prevents duplicate submissions', async () => {
  const resolves: ((ack: Ack) => void)[] = [];
  const client = { command: vi.fn((name: string) => name === 'intake.submit' ? new Promise<Ack>(resolve => resolves.push(resolve)) : Promise.resolve({ type: 'ack' as const, cmd_id: 'model', ok: true })) };
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
  fillTaskForm(); fireEvent.submit(screen.getByRole('form', { name: 'New task' }));
  expect(client.command.mock.calls.filter(([name]) => name === 'intake.submit')).toHaveLength(3);
  fireEvent.submit(screen.getByRole('form', { name: 'New task' }));
  expect(client.command.mock.calls.filter(([name]) => name === 'intake.submit')).toHaveLength(3);
  await act(async () => resolves.forEach(resolve => resolve({ type: 'ack', cmd_id: 'id', ok: true })));
});
it('interrupts the selected root and keeps projected state until a patch arrives', async () => {
 const client = createCommandClient(); render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
 await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })));
 expect(client.command).toHaveBeenCalledWith('interrupt', { runId: 'r1' });
 expect(within(screen.getByRole('region', { name: 'Conversations' })).getByText('Running')).toBeTruthy();
});it('does not list parallel child conversations among roots', () => {
 const target = createActivityStore(); const snapshot = target.getSnapshot();
 target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, conversations: [...snapshot.projection.conversations, { id: 'parallel', provider: 'claude', origin: 'managed', name: 'Parallel child' }] } });
 render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={target} client={createCommandClient()}/></MemoryRouter>);
 const roots = screen.getByRole('region', { name: 'Conversations' }); expect(within(roots).getAllByRole('link')).toHaveLength(2);
 expect(within(roots).queryByText('Parallel child')).toBeNull();
 fireEvent.click(within(roots).getByRole('link', { name: /Investigate latency/ })); expect(screen.getByText('Investigate latency. Then report.')).toBeTruthy();
});it('disables root controls without the runner and reports rejected interrupts', async () => {
 const target = createActivityStore(); const client = createCommandClient(); target.setConnection('runner_unavailable');
 render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={target} client={client}/></MemoryRouter>);
 const stop = screen.getByRole('button', { name: 'Interrupt' }) as HTMLButtonElement; expect(stop.disabled).toBe(true);
 act(() => target.setConnection('connected')); await act(async () => {});
 client.command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'id', ok: false, error: 'Run is not open' });
 await act(async () => fireEvent.click(stop)); expect(screen.getByText('Run is not open')).toBeTruthy();
});it('reports partial creation failure without hiding successful requests', async () => {
  const client = createCommandClient();
  client.command.mockImplementation(async (name, _payload, cmdId) => ({ type: 'ack', cmd_id: cmdId ?? 'id', ok: name !== 'intake.submit' || client.command.mock.calls.filter(([command]) => command === 'intake.submit').length > 1, error: 'Runner unavailable' }));
  render(<MemoryRouter><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
  fillTaskForm();
  await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'New task' })));
  expect(screen.getByText('2/3 requests started · Runner unavailable')).toBeTruthy();
});
