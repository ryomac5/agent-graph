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
it('interrupts the selected root and keeps projected state until a patch arrives', async () => {
 const client = createCommandClient(); render(<MemoryRouter initialEntries={['/']}><WorkspacePage project="/repo/alpha" target={createActivityStore()} client={client}/></MemoryRouter>);
 await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Interrupt' })));
 expect(client.command).toHaveBeenCalledWith('interrupt', { runId: 'r1' });
 expect(within(screen.getByRole('region', { name: 'Conversations' })).getByRole('img', { name: 'Running' })).toBeTruthy();
});it('does not list parallel child conversations among roots', () => {
 const target = createActivityStore(); const snapshot = target.getSnapshot();
 target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, conversations: [...snapshot.projection.conversations, { id: 'parallel', provider: 'claude', origin: 'managed', name: 'Parallel child' }] } });
 render(<MemoryRouter initialEntries={['/']}><WorkspacePage project="/repo/alpha" target={target} client={createCommandClient()}/></MemoryRouter>);
 const roots = screen.getByRole('region', { name: 'Conversations' }); expect(within(roots).getAllByRole('link')).toHaveLength(2);
 expect(within(roots).queryByText('Parallel child')).toBeNull();
 fireEvent.click(within(roots).getByRole('link', { name: /Investigate latency/ })); expect(screen.getByText('Investigate latency. Then report.')).toBeTruthy();
});it('disables root controls without the runner and reports rejected interrupts', async () => {
 const target = createActivityStore(); const client = createCommandClient(); target.setConnection('runner_unavailable');
 render(<MemoryRouter initialEntries={['/']}><WorkspacePage project="/repo/alpha" target={target} client={client}/></MemoryRouter>);
 const stop = screen.getByRole('button', { name: 'Interrupt' }) as HTMLButtonElement; expect(stop.disabled).toBe(true);
 act(() => target.setConnection('connected')); await act(async () => {});
 client.command.mockResolvedValueOnce({ type: 'ack', cmd_id: 'id', ok: false, error: 'Run is not open' });
 await act(async () => fireEvent.click(stop)); expect(screen.getByText('Run is not open')).toBeTruthy();
});
