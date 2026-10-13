import { useEffect, useRef, useState } from 'react';
import type { ConversationClient, SessionHost } from '../pages/conversation/ConversationPage.tsx';
import type { Row } from '../lib/store.ts';
import { ProviderMark } from './RootViews.tsx';
import { CommandDialog } from './command/Commands.tsx';
import './session-create.css';
import { request, startSession, readSessionProvider, SESSION_PROVIDER_KEY } from '../lib/session-start.ts';
export { request } from '../lib/session-start.ts';
export interface SshConnection { id: string; name: string; destination: string; projects: { projectId: string; path: string }[] }
export function SessionCreate({ client, projects, initialProject, language = 'en', onClose, onCreated }: {
  client: ConversationClient; projects: Row[]; initialProject?: string; language?: 'ja' | 'en'; onClose(): void; onCreated(project: string, conversation: string, host: SessionHost): void;
}) {
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
  const [projectId, setProject] = useState(initialProject ?? String(projects[0]?.id ?? ''));
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [destination, setDestination] = useState('local');
  const [base, setBase] = useState('origin/main');
  const [branches, setBranches] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState(readSessionProvider);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTerminal, setPendingTerminal] = useState<string>();
  const inFlight = useRef(false);
  const createdTree = useRef<{ key: string; path: string } | undefined>(undefined);
  const mounted = useRef(true);
  const target = destination === 'local' ? { kind: 'local' } : { kind: 'ssh', id: destination };
  const path = destination === 'local' ? String(projects.find(row => row.id === projectId)?.root_path ?? '') : connections.find(row => row.id === destination)?.projects.find(row => row.projectId === projectId)?.path ?? '';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { let active = true; void request<{ connections: SshConnection[] }>(client, 'ssh.read').then(result => { if (active) setConnections(result?.connections ?? []); }, cause => { if (active) setError(text('Unable to load SSH connections', 'SSH の接続先を読み込めません')); }); return () => { active = false; }; }, [client]);
  useEffect(() => {
    let active = true; setBranches([]); setBase('origin/main'); setError('');
    if (projectId && path) void request<{ branches: string[] }>(client, 'git.branches', { projectId, target }).then(result => { if (active) setBranches(result?.branches ?? []); }, cause => { if (active) setError(text('Unable to load branches', 'ブランチの一覧を読み込めません')); });
    return () => { active = false; };
  }, [client, projectId, destination, path]);
  async function create() {
    if (inFlight.current || !projectId || !path) return;
    inFlight.current = true; setBusy(true); setError('');
    try {
      let worktree: { path: string } | undefined;
      if (!pendingTerminal && name) {
        const key = JSON.stringify([projectId, target, base, name]);
        worktree = createdTree.current?.key === key ? createdTree.current : await request<{ path: string }>(client, 'worktree.create', { projectId, target, base, name });
        createdTree.current = { key, path: worktree.path };
      }
      const host = await startSession(client, { projectId, target, provider, ...(worktree ? { worktree: worktree.path } : {}) }, {
        terminalId: pendingTerminal, onLaunched: setPendingTerminal, active: () => mounted.current,
      });
      if (host) onCreated(projectId, host.conversationId, host);
    } catch { if (mounted.current) setError(text('Unable to start conversation', '会話を始められません')); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  return <CommandDialog language={language} title={text('Create session', 'セッションを作成')} onClose={onClose}>
    <form className="session-create" onSubmit={event => { event.preventDefault(); void create(); }} onKeyDown={event => { if (event.metaKey && event.key === 'Enter') { event.preventDefault(); void create(); } }}>
      <label>{text('Project', 'プロジェクト')}<select disabled={busy || Boolean(pendingTerminal)} value={projectId} onChange={event => setProject(event.target.value)}>{projects.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.display_name ?? row.id)}</option>)}</select></label>
      <label>{text('Run on', '実行先')}<div className="session-target"><select aria-label={text('Run on', '実行先')} disabled={busy || Boolean(pendingTerminal)} value={destination} onChange={event => setDestination(event.target.value)}><option value="local">{text('This Mac', 'この Mac')}</option>{connections.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select><span title={path}>{path || text('Project path is not configured', 'プロジェクトのパスが未設定です')}</span></div></label>
      <label>{text('Create from', '作成元')}<select disabled={busy || Boolean(pendingTerminal)} value={base} onChange={event => setBase(event.target.value)}>{[...new Set(['origin/main', ...branches])].map(branch => <option key={branch}>{branch}</option>)}</select></label>
      <label>{text('Worktree name', 'ワークツリー名')}<input aria-label={text('Worktree name', 'ワークツリー名')} disabled={busy || Boolean(pendingTerminal)} value={name} pattern="[a-zA-Z0-9_][a-zA-Z0-9._-]*" onChange={event => setName(event.target.value)}/></label>
      <fieldset disabled={busy || Boolean(pendingTerminal)}><legend>{text('Agent', 'エージェント')}</legend><div className="session-agents">{['claude', 'codex'].map(value => <button type="button" key={value} className="btn btn-secondary" aria-pressed={provider === value} onClick={() => { setProvider(value); localStorage.setItem(SESSION_PROVIDER_KEY, value); }}><ProviderMark provider={value}/>{value === 'claude' ? 'Claude' : 'Codex'}</button>)}</div></fieldset>
      {error && <p role="alert">{error}</p>}<div className="session-create-actions"><button className="btn btn-primary" disabled={busy || !projectId || !path}>{busy ? text('Creating…', '作成中…') : text('Create', '作成')} <kbd>⌘ ↵</kbd></button></div>
    </form>
  </CommandDialog>;
}
