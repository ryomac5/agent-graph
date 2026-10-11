import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionCreate } from '../components/SessionCreate.tsx';
import { SshSettings } from '../components/SshSettings.tsx';
import type { ConversationClient } from '../pages/conversation/ConversationPage.tsx';
const projects = [{ id: 'demo', root_path: '/repo', display_name: 'Demo', state: 'registered' }];
const connection = { id: 'server', name: 'Server', destination: 'dev@host', projects: [{ projectId: 'demo', path: '/remote/demo' }] };
function fixture() {
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true,
    result: name === 'ssh.read' ? { connections: [connection] } : name === 'git.branches' ? { branches: ['main', 'origin/main'] }
      : name === 'worktree.create' ? { path: '/cache/tree' } : name === 'session.launch' ? { terminalId: 'terminal' }
      : name === 'session.hosts' ? { hosts: [{ terminalId: 'terminal', conversationId: 'conversation' }] }
      : name === 'ssh.test' ? { connected: true } : {} }));
  return { command, client: { command } as ConversationClient, onCreated: vi.fn(), onClose: vi.fn() };
}
afterEach(cleanup);
it.each(['en', 'ja'] as const)('shows creation fields and creates a worktree on the selected destination in %s', async language => {
  const f = fixture(); const ja = language === 'ja';
  render(<SessionCreate {...f} projects={projects} language={language}/>);
  expect(screen.getByRole('dialog', { name: ja ? 'セッションを作成' : 'Create session' })).toBeTruthy();
  await screen.findByRole('option', { name: 'Server' });
  expect(screen.getByRole('dialog').querySelector('small')).toBeNull();
  expect(screen.queryByText(ja ? '空ならプロジェクトの場所で起動します' : 'Leave empty to use the project directory')).toBeNull();
  fireEvent.change(screen.getByLabelText(ja ? '実行先' : 'Run on'), { target: { value: 'server' } });
  expect(screen.getByText('/remote/demo')).toBeTruthy();
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('git.branches', { projectId: 'demo', target: { kind: 'ssh', id: 'server' } }));
  expect(screen.getByLabelText(ja ? '作成元' : 'Create from').getAttribute('value')).toBeNull();
  fireEvent.change(screen.getByLabelText(ja ? '作業ツリーの名前' : 'Worktree name'), { target: { value: 'feature' } });
  expect(document.querySelector('.provider-claude')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^(作成|Create) / }));
  await waitFor(() => expect(f.onCreated).toHaveBeenCalledWith('demo', 'conversation'));
  expect(f.command).toHaveBeenCalledWith('worktree.create', { projectId: 'demo', target: { kind: 'ssh', id: 'server' }, base: 'origin/main', name: 'feature' });
  expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'demo', target: { kind: 'ssh', id: 'server' }, provider: 'claude', worktree: '/cache/tree' });
});
it('Cmd+Enter launches Codex without a worktree and Escape closes', async () => {
  const f = fixture(); render(<SessionCreate {...f} projects={projects}/>);
  await screen.findByRole('option', { name: 'Server' });
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  fireEvent.keyDown(screen.getByLabelText('Worktree name'), { key: 'Enter', metaKey: true });
  await waitFor(() => expect(f.onCreated).toHaveBeenCalled());
  expect(f.command).toHaveBeenCalledWith('session.launch', { projectId: 'demo', target: { kind: 'local' }, provider: 'codex' });
  expect(f.command.mock.calls.some(([name]) => name === 'worktree.create')).toBe(false);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(f.onClose).toHaveBeenCalled();
});
it('failed discovery retries the existing terminal without launching twice', async () => {
  const f = fixture(); const original = f.command.getMockImplementation()!;
  let fail = true;
  f.command.mockImplementation(async name => name === 'session.hosts' && fail ? { type: 'ack', cmd_id: 'cmd', ok: false, error: 'Unavailable' } as never : original(name));
  render(<SessionCreate {...f} projects={projects}/>);
  await screen.findByRole('option', { name: 'Server' });
  fireEvent.click(screen.getByRole('button', { name: /^Create / }));
  await screen.findByRole('alert'); fail = false;
  fireEvent.click(screen.getByRole('button', { name: /^Create / }));
  await waitFor(() => expect(f.onCreated).toHaveBeenCalled());
  expect(f.command.mock.calls.filter(([name]) => name === 'session.launch')).toHaveLength(1);
});
it.each(['en', 'ja'] as const)('edits and tests SSH connections in %s', async language => {
  const f = fixture(), ja = language === 'ja'; render(<SshSettings client={f.client} projects={projects} language={language}/>);
  await screen.findByDisplayValue('dev@host');
  fireEvent.change(screen.getByLabelText(ja ? '名前' : 'Name'), { target: { value: 'Remote' } });
  fireEvent.change(screen.getByLabelText(ja ? '向こうのパス' : 'Remote path'), { target: { value: '~/project' } });
  fireEvent.click(screen.getByRole('button', { name: ja ? '接続を確かめる' : 'Test connection' }));
  await screen.findByRole('status');
  expect(f.command).toHaveBeenCalledWith('ssh.test', { destination: 'dev@host' });
  fireEvent.click(screen.getByRole('button', { name: ja ? 'SSH の接続先を保存' : 'Save SSH connections' }));
  await waitFor(() => expect(f.command).toHaveBeenCalledWith('ssh.write', { connections: [{ ...connection, name: 'Remote', projects: [{ projectId: 'demo', path: '~/project' }] }] }));
});
