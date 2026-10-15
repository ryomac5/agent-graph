import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from "./current-fixture.ts";
import { SESSION_PROVIDER_KEY } from '../lib/session-start.ts';
import type { Ack } from '../lib/client.ts';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0, projection: {}, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ack = (result: unknown = {}): Ack => ({ type: 'ack', cmd_id: 'cmd', ok: true, result });
function Location() { const location = useLocation(); return <output data-testid="route">{location.pathname + location.search}</output>; }
function mount(command: (name: string, payload?: unknown) => Promise<Ack>, route = '/') {
  const target = createStore(); target.setSnapshot({ seq: 0, generation: 0, projection: { projects: [{ id: 'p', root_path: '/body', display_name: 'Demo', state: 'registered' }] } }); target.setConnection('connected');
  return render(<MemoryRouter initialEntries={[route]}><App target={target} client={{ command }}/><Location/></MemoryRouter>);
}
it.each([undefined, 'codex'] as const)('starts directly with the saved provider %s and prevents a second launch', async provider => {
  if (provider) localStorage.setItem(SESSION_PROVIDER_KEY, provider);
  let finish!: (result: Ack) => void;
  const command = vi.fn(async (name: string) => name === 'session.launch' ? new Promise<Ack>(resolve => { finish = resolve; }) : name === 'session.hosts' ? ack({ hosts: [{ terminalId: 't', conversationId: 'c' }] }) : ack());
  mount(command);
  const button = screen.getByRole('button', { name: 'Start conversation: Demo' });
  fireEvent.click(button); fireEvent.click(button);
  expect(button.hasAttribute('disabled')).toBe(true); expect(button.getAttribute('aria-busy')).toBe('true');
  expect(button.querySelector('.project-start-spinner')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('menu')).toBeNull();
  expect(command).toHaveBeenCalledWith('session.launch', { projectId: 'p', provider: provider ?? 'claude', target: { kind: 'local' } });
  finish(ack({ terminalId: 't' }));
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/p/p?conversation=c'));
  expect(command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(1);
  expect(command.mock.calls.some(([name]) => name === 'worktree.create' || name === 'intake.submit')).toBe(false);
});
it('shows a short failure and allows retry', async () => {
  const command = vi.fn(async (name: string) => name === 'session.launch' ? { ...ack(), ok: false, error: 'Failure' } : ack());
  mount(command); fireEvent.click(screen.getByRole('button', { name: 'Start conversation: Demo' }));
  await screen.findByText('Unable to start conversation');
  expect(screen.getByRole('button', { name: 'Start conversation: Demo' }).hasAttribute('disabled')).toBe(false);
});
it.each([false, true])('offers the SSH dialog only with a connection: %s', async connected => {
  const command = vi.fn(async (name: string) => name === 'ssh.read' ? ack({ connections: connected ? [{ id: 'ssh' }] : [] }) : ack());
  mount(command); await waitFor(() => expect(command).toHaveBeenCalledWith('ssh.read', {}));
  fireEvent.click(screen.getByRole('button', { name: 'Search and commands' }));
  const input = screen.getByRole('combobox', { name: 'Search commands' }); fireEvent.change(input, { target: { value: 'SSH' } });
  if (connected) { await screen.findByText('Start conversation over SSH'); fireEvent.keyDown(input, { key: 'Enter' }); await screen.findByRole('dialog', { name: 'Create session' }); }
  else expect(screen.getByText('No commands')).toBeTruthy();
});
it.each(['en', 'ja'] as const)('adds a project without starting a conversation in %s', async language => {
  localStorage.setItem('agent-graph-language', language);
  const command = vi.fn(async (name: string) => name === 'project.add' ? ack({ projectId: 'added' }) : name === 'fs.directories' ? ack({ paths: ['/home/demo'] }) : ack());
  mount(command); fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? 'プロジェクトを追加' : 'Add project' }));
  fireEvent.change(screen.getByLabelText(language === 'ja' ? '場所' : 'Location'), { target: { value: '~/demo' } });
  await waitFor(() => expect(document.querySelector('datalist option')?.getAttribute('value')).toBe('/home/demo/'));
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('/p/added'));
  expect(command).toHaveBeenCalledWith('project.add', { path: '~/demo' });
  expect(command.mock.calls.some(([name]) => name === 'session.launch')).toBe(false);
});

it('ignores the removed task creation query', () => {
  const command = vi.fn(async (_name: string) => ack());
  mount(command, '/p/p?create=1');
  expect(screen.queryByRole('form')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(command.mock.calls.some(([name]) => name === 'intake.submit')).toBe(false);
});

it('reveals and expands an existing hidden project after adding it', async () => {
  localStorage.setItem('agent-graph-project-list', JSON.stringify({ order: ['p'], hidden: ['p'] }));
  const command = vi.fn(async (name: string) => name === 'project.add' ? ack({ projectId: 'p' }) : ack());
  mount(command);
  fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
  fireEvent.change(screen.getByLabelText('Location'), { target: { value: '/body' } });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Toggle sessions for Demo' }).getAttribute('aria-expanded')).toBe('true'));
  expect(command.mock.calls.some(([name]) => name === 'session.launch')).toBe(false);
});
