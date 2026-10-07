import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
import { createKeyHandler, DEFAULT_KEYS, SEQUENCE_TIMEOUT_MS, validateBindings } from '../lib/keys.ts';
import { CommandPalette } from '../components/command/Commands.tsx';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function Location() { return <output data-testid="location">{useLocation().pathname}</output>; }
function mount(path = '/') {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    projects: [{ id: 'demo', display_name: 'demo', root_path: '/projects/demo', state: 'registered' }],
    tasks: [{ id: 't', name: 'Task', project: 'demo' }],
    conversations: [{ id: 'c', task_id: 't', name: 'Build console', origin: 'managed', provider: 'claude' }],
    runs: [{ id: 'r', conversation_id: 'c', state: 'running', generation: 1 }],
    approvals: ['one', 'two'].map(id => ({ id, run_id: 'r', state: 'requested', available_decisions: '["allow","deny"]' })),
  } });
  target.setConnection('connected');
  let keys = { ...DEFAULT_KEYS };
  const client = { command: vi.fn(async (name: string, payload?: unknown) => {
    if (name === 'settings.write') keys = { ...(payload as { patch: { keys: typeof keys } }).patch.keys };
    return { type: 'ack' as const, cmd_id: name, ok: true, result: name === 'settings.read' ? { config: { keys } } : [] };
  }) };
  render(<MemoryRouter initialEntries={[path]}><App target={target} client={client}/><Location/></MemoryRouter>);
  return { target, client, setKeys: (value: typeof keys) => { keys = value; } };
}
function press(key: string, target: Element | Document = document, options = {}) { fireEvent.keyDown(target, { key, ...options }); }
it.each([['h', '/'], ['w', '/p/demo'], ['i', '/inbox'], ['t', '/p/demo/tree'], ['c', '/p/demo/changes']])('navigates with g %s', async (key, path) => {
  mount('/p/demo');
  await act(async () => {});
  press('g'); press(key);
  expect(screen.getByTestId('location').textContent).toBe(path);
});
it('moves through approval rows and sends allow and deny exactly once', async () => {
  const { client } = mount('/inbox'); await act(async () => {});
  press('j');
  expect(document.activeElement?.getAttribute('data-approval-id')).toBe('one');
  press('j'); expect(document.activeElement?.getAttribute('data-approval-id')).toBe('two');
  press('k'); expect(document.activeElement?.getAttribute('data-approval-id')).toBe('one');
  await act(async () => press('a', document.activeElement!));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'one', decision: 'allow' });
  press('j'); await act(async () => press('d', document.activeElement!));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'two', decision: 'deny' });
  expect(client.command.mock.calls.filter(([name]) => name === 'answer')).toHaveLength(2);
});
it('requires confirmation before interrupting and Escape cancels the dialog', async () => {
  const { client } = mount('/c/c'); await act(async () => {});
  press('Escape'); expect(screen.getByRole('dialog', { name: 'Interrupt run?' })).toBeTruthy();
  expect(client.command).not.toHaveBeenCalledWith('interrupt', expect.anything());
  press('Escape', document.activeElement!); expect(screen.queryByRole('dialog')).toBeNull();
  press('Escape'); await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Confirm interrupt' })));
  expect(client.command).toHaveBeenCalledWith('interrupt', { runId: 'r' });
});
it('shows the current key list with ? and restores focus after dismissal', async () => {
  mount(); await act(async () => {});
  const opener = screen.getByRole('button', { name: /Search and commands/ }); opener.focus();
  press('?', opener, { shiftKey: true });
  const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
  for (const key of Object.values(DEFAULT_KEYS)) expect(within(dialog).getByText(key)).toBeTruthy();
  press('Escape', document.activeElement!); expect(document.activeElement).toBe(opener);
});
it.each(['input', 'textarea', 'select', 'editable', 'textbox'])('leaves character shortcuts alone in %s', async kind => {
  mount(); await act(async () => {});
  const field = document.createElement(['editable', 'textbox'].includes(kind) ? 'div' : kind);
  if (kind === 'editable') field.setAttribute('contenteditable', '');
  if (kind === 'textbox') field.setAttribute('role', 'textbox');
  document.body.append(field);
  for (const key of ['g', 'i', 'j', 'k', 'a', 'd', '?']) expect(fireEvent.keyDown(field, { key })).toBe(true);
  expect(screen.getByTestId('location').textContent).toBe('/'); expect(screen.queryByRole('dialog')).toBeNull();
  press('k', field, { metaKey: true }); expect(screen.getByRole('combobox', { name: 'Search commands' })).toBeTruthy();
  field.remove();
});
it('searches and executes commands with keyboard and opens conversations and creation', async () => {
  mount(); await act(async () => {});
  press('k', document, { metaKey: true });
  const input = screen.getByRole('combobox', { name: 'Search commands' }); expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'console' } }); press('Enter', input);
  expect(screen.getByTestId('location').textContent).toBe('/c/c'); expect(screen.queryByRole('dialog')).toBeNull();
  press('k', document, { metaKey: true });
  fireEvent.change(screen.getByRole('combobox', { name: 'Search commands' }), { target: { value: 'create task' } }); press('Enter', screen.getByRole('combobox', { name: 'Search commands' }));
  expect(screen.getByRole('form', { name: 'Create task' })).toBeTruthy();
});
it('handles no matches, arrow selection and focus wrapping in the palette', async () => {
  mount(); await act(async () => {}); press('k', document, { metaKey: true });
  const input = screen.getByRole('combobox', { name: 'Search commands' });
  fireEvent.change(input, { target: { value: 'not a command' } }); expect(screen.getByText('No commands found')).toBeTruthy();
  press('Enter', input); expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.change(input, { target: { value: 'go to' } }); press('ArrowDown', input); press('Enter', input);
  expect(screen.getByTestId('location').textContent).toBe('/p/demo');
  press('k', document, { metaKey: true });
  const close = within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' });
  close.focus(); press('Tab', close, { shiftKey: true });
  expect(document.activeElement?.textContent).toBe('Open workspace: demo');
  press('Tab', document.activeElement!); expect(document.activeElement).toBe(close);
});
it('answers a named approval from the palette on any page', async () => {
  const { client } = mount(); await act(async () => {});
  press('k', document, { metaKey: true });
  const input = screen.getByRole('combobox', { name: 'Search commands' });
  fireEvent.change(input, { target: { value: 'deny approval two' } });
  await act(async () => press('Enter', input));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'two', decision: 'deny' });
});
it('saves remapped keys through config, applies immediately and rejects duplicates', async () => {
  const { client } = mount('/settings'); await act(async () => {});
  fireEvent.change(screen.getByLabelText('keys · command'), { target: { value: 'Cmd+P' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save keyboard shortcuts' })));
  expect(client.command).toHaveBeenCalledWith('settings.write', { store: 'config', patch: { keys: { ...DEFAULT_KEYS, command: 'Cmd+P' } } });
  press('k', document, { metaKey: true }); expect(screen.queryByRole('dialog')).toBeNull();
  press('p', document, { metaKey: true }); expect(screen.getByRole('dialog')).toBeTruthy();
  press('Escape', document.activeElement!);
  fireEvent.change(screen.getByLabelText('keys · command'), { target: { value: 'j' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save keyboard shortcuts' })));
  expect(screen.getByRole('alert').textContent).toBe('Duplicate key binding');
  expect(client.command.mock.calls.filter(([name]) => name === 'settings.write')).toHaveLength(1);
});
it('refreshes watched bindings and prevents legacy approval keys after remapping', async () => {
  vi.useFakeTimers(); const { client, setKeys } = mount('/inbox'); await act(async () => {});
  setKeys({ ...DEFAULT_KEYS, allow: 'x' }); await act(async () => vi.advanceTimersByTime(1500));
  press('j'); await act(async () => press('a', document.activeElement!));
  expect(client.command.mock.calls.filter(([name]) => name === 'answer')).toHaveLength(0);
  await act(async () => press('x', document.activeElement!));
  expect(client.command).toHaveBeenCalledWith('answer', { approvalId: 'one', decision: 'allow' });
});
it('rejects equivalent modifiers and ambiguous prefixes', () => {
  expect(() => validateBindings({ command: 'META+k', allow: 'cmd+K' })).toThrow('Duplicate');
  expect(() => validateBindings({ allow: 'g' })).toThrow('Duplicate');
  expect(() => validateBindings({ allow: '' })).toThrow('Invalid');
  expect(() => validateBindings({ command: 'Cmd+Meta+K' })).toThrow('Invalid');
  expect(() => validateBindings({ command: 'Ctrl+Control+K' })).toThrow('Invalid');
  expect(() => validateBindings({ help: 'Shift+Shift+?' })).toThrow('Invalid');
});
it('preserves sequences while pressing modifiers for the next stroke', () => {
  const execute = vi.fn();
  const handle = createKeyHandler(validateBindings({ home: 'g Ctrl+h' }), execute);
  expect(handle(new KeyboardEvent('keydown', { key: 'g' }))).toBe(true);
  expect(handle(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))).toBe(false);
  expect(handle(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }))).toBe(true);
  expect(execute).toHaveBeenCalledExactlyOnceWith('home');
});
it('expires sequences and ignores repeats, composition and unrelated modifier chords', () => {
  vi.useFakeTimers(); const execute = vi.fn(); const handle = createKeyHandler(DEFAULT_KEYS, execute);
  handle(new KeyboardEvent('keydown', { key: 'g' })); vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS);
  handle(new KeyboardEvent('keydown', { key: 'i' }));
  handle(new KeyboardEvent('keydown', { key: 'a', repeat: true }));
  handle(new KeyboardEvent('keydown', { key: 'a', isComposing: true }));
  handle(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }));
  expect(execute).not.toHaveBeenCalled();
});
it('restarts navigation when a prefix is pressed again', () => {
  const execute = vi.fn();
  const handle = createKeyHandler(DEFAULT_KEYS, execute);
  handle(new KeyboardEvent('keydown', { key: 'g' }));
  handle(new KeyboardEvent('keydown', { key: 'g' }));
  handle(new KeyboardEvent('keydown', { key: 'h' }));
  expect(execute).toHaveBeenCalledExactlyOnceWith('home');
});
it('supports named keys and treats Shift+? as the help key', () => {
  const execute = vi.fn();
  const handle = createKeyHandler(validateBindings({ next: 'ArrowRight', previous: 'Space', help: 'Shift+?' }), execute);
  handle(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  handle(new KeyboardEvent('keydown', { key: ' ' }));
  handle(new KeyboardEvent('keydown', { key: '?', shiftKey: true }));
  expect(execute.mock.calls).toEqual([['next'], ['previous'], ['help']]);
  expect(() => validateBindings({ allow: 'Shift+?' })).toThrow('Duplicate');
  expect(() => validateBindings({ unknown: 'x' })).toThrow('Invalid');
});
it('selects delegation tree rows with j and k', async () => {
  const { target } = mount('/p/demo/tree');
  // 木には委譲を起こした作業だけが出る。
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    conversations: { remove: [], upsert: [{ id: 'child', provider: 'codex', origin: 'managed', name: 'Child' }] },
    runs: { remove: [], upsert: [{ id: 'child:1', conversation_id: 'child', state: 'running', generation: 1 }] },
    delegations: { remove: [], upsert: [{ id: 'd', request_id: 'd', title: 'Child work', role: 'implement', state: 'running', attempt: 1,
      parent: JSON.stringify({ confidence: 'confirmed', conversation_id: 'c' }), attempts: JSON.stringify([{ attempt: 1, run_id: 'child:1' }]) }] },
  } }));
  await act(async () => {});
  press('j');
  expect(document.activeElement?.classList.contains('delegation-select')).toBe(true);
  expect(document.activeElement?.getAttribute('aria-pressed')).toBe('true');
  press('k');
  expect(document.activeElement?.classList.contains('delegation-select')).toBe(true);
});
it('skips unavailable commands and clamps selection when live commands change', () => {
  const run = vi.fn(); const onClose = vi.fn();
  const commands = [{ id: 'disabled', name: 'Disabled command', disabled: true, run }, { id: 'one', name: 'One', run }, { id: 'two', name: 'Two', run }];
  const { rerender } = render(<CommandPalette commands={commands} onClose={onClose}/>);
  const input = screen.getByRole('combobox');
  press('ArrowDown', input);
  expect(input.getAttribute('aria-activedescendant')).toBe('command-two');
  rerender(<CommandPalette commands={commands.slice(0, 2)} onClose={onClose}/>);
  expect(input.getAttribute('aria-activedescendant')).toBe('command-one');
  press('Enter', input);
  expect(run).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});
