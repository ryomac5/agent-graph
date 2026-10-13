import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useKeySettings } from '../components/command/Commands.tsx';
import { DEFAULT_KEYS } from '../lib/keys.ts';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('makes zero periodic settings requests over 30 seconds and refreshes on focus and reconnect', async () => {
  vi.useFakeTimers();
  let commandKey = DEFAULT_KEYS.command;
  let reconnect: (() => void) | undefined;
  const release = vi.fn();
  const client = {
    command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'settings', ok: true, result: { config: { keys: { ...DEFAULT_KEYS, command: commandKey } } } })),
    subscribeConnected: (listener: () => void) => { reconnect = listener; return release; },
  };
  function Keys() {
    const { bindings, setBindings } = useKeySettings(client);
    return <button onClick={() => setBindings({ ...bindings, command: 'Cmd+L' })}>{bindings.command}</button>;
  }
  const view = render(<Keys/>);
  await act(async () => {});
  expect(client.command).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(client.command).toHaveBeenCalledTimes(1);
  commandKey = 'Cmd+O';
  await act(async () => { fireEvent.focus(window); });
  expect(screen.getByRole('button').textContent).toBe('Cmd+O');
  expect(client.command).toHaveBeenCalledTimes(2);
  commandKey = 'Cmd+U';
  await act(async () => { reconnect!(); });
  expect(screen.getByRole('button').textContent).toBe('Cmd+U');
  expect(client.command).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button').textContent).toBe('Cmd+L');
  view.unmount();
  expect(release).toHaveBeenCalledTimes(1);
  fireEvent.focus(window);
  expect(client.command).toHaveBeenCalledTimes(3);
  console.info('30 seconds idle: periodic settings.read requests 20 -> 0; initial/focus/reconnect 1 each');
});
