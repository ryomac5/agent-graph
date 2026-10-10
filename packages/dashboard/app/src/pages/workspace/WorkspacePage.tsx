import { useMemo, useState, useRef, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { resolveProjectId } from '../../lib/projects.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { ConversationPage } from '../conversation/ConversationPage.tsx';
import { selectRoots, useRootIndex, buildRootTree, orderSeries } from '../../lib/roots.ts';
import { RootList } from '../../components/RootViews.tsx';
import { CreateTaskForm } from '../../components/CreateTaskForm.tsx';
import { Icon } from '../../components/Icon.tsx';
import { WorkspacePanel } from './WorkspacePanel.tsx';
import { OpenWorkspaceFile } from '../../lib/workspace-context.ts';
import { Workbench } from './Workbench.tsx';
import type { KeyBindings } from '../../lib/keys.ts';
import '../../components/activity.css';
import '../files/files.css';

/** プロジェクトの見出しと、同じ並びのタブ。作業場と依頼の流れと変更で共有する。 */
export function ProjectHeader({ route, name, language = 'en', actions }: { route: string; name: string; language?: Language; actions?: ReactNode }) {
  const t = dictionaries[language];
  const prefix = `/p/${encodeURIComponent(route)}`;
  const [search] = useSearchParams();
  const rootQuery = search.get('root') ? `?root=${encodeURIComponent(search.get('root')!)}` : '';
  return <header className="workspace-header"><h1 className="workspace-title"><Icon name="folder" size={16}/><span className="truncate">{name}</span></h1>
    <nav className="tabs header-tabs" aria-label={t.project}><NavLink end to={`${prefix}${rootQuery}`}>{t.conversations}</NavLink><NavLink to={`${prefix}/graph${rootQuery}`}>{language === 'ja' ? 'グラフ' : 'Graph'}</NavLink><NavLink to={`${prefix}/changes`}>{t.changes}</NavLink></nav>
    <span className="spacer"/>{actions}</header>;
}

export function WorkspacePage({ project: suppliedProject, target = store, client, renderConversation, language = 'en', showRootList = true, conversationId: suppliedConversation, bindings }: {
  project?: string; target?: ScreenStore; client: ConversationClient; language?: Language; renderConversation?: (conversationId: string) => ReactNode;
  /** 会話の一覧を作業場に出すか。サイドバーに一覧があるアプリの画面では出さない。 */
  showRootList?: boolean; conversationId?: string; bindings?: KeyBindings;
}) {
  const t = dictionaries[language];
  const openFile = useRef<(path: string, worktree?: string) => void>(() => {});
  const params = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const route = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target);
  const project = resolveProjectId(state, route);
  const roots = useMemo(() => selectRoots(state, project), [state.projection.roots, state.projection.conversations, project]);
  const index = useRootIndex(state);
  const selected = roots.find(root => suppliedConversation && (root.conversation_ids.includes(suppliedConversation) || buildRootTree(root, index).nodes.some(node => node.conversationId === suppliedConversation))) ?? roots.find(root => root.id === search.get('root')) ?? roots[0];
  const creating = search.get('create') === '1';
  const newSession = search.get('session') ?? undefined;
  const draftWorkspace = useRef<{ token: string; session: string }>(undefined);
  if (newSession && draftWorkspace.current?.token !== newSession) draftWorkspace.current = { token: newSession, session: selected?.id ?? newSession };
  function setCreating(open: boolean) { const next = new URLSearchParams(search); if (open) next.set('create', '1'); else next.delete('create'); setSearch(next); }
  const [retryError, setRetryError] = useState('');
  async function retry(node: { delegation?: Record<string, unknown> }) {
    if (!node.delegation) return;
    setRetryError('');
    try { const ack = await client.command('intake.retry', { requestId: node.delegation.request_id ?? node.delegation.id }); if (!ack.ok) setRetryError(ack.error ?? 'Retry failed'); }
    catch (cause) { setRetryError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const tree = useMemo(() => selected ? buildRootTree(selected, index) : { nodes: [], edges: [], roots: [], unresolved: [] }, [selected, index]);
  const requestedChild = search.get('child') ?? suppliedConversation;
  const selectedNode = tree.nodes.find(node => node.conversationId === requestedChild || node.id === requestedChild);
  const childId = requestedChild && !selected?.conversation_ids.includes(requestedChild) ? selectedNode?.conversationId : undefined;
  // 系列は最後に動いた会話を末尾に並べ、その会話を開く。
  const series = useMemo(() => selected ? orderSeries(state, selected.conversation_ids) : [], [selected, state.projection.conversations, state.projection.runs]);
  const conversationId = childId ?? suppliedConversation ?? series.at(-1);
  // 子の会話は、頼んだ内容を名前として出す。
  const childNode = selectedNode;
  const childTitle = childNode ? tree.edges.find(edge => edge.target === childNode.id)?.title || undefined : undefined;
  const breadcrumb = <>{childId && <button className="btn btn-ghost btn-sm root-back" aria-label={`${language === 'ja' ? '戻る:' : 'Back to'} ${selected?.name ?? ""}`} onClick={() => { const next = new URLSearchParams(search); next.delete('child'); if (selected) next.set('root', selected.id); if (suppliedConversation) navigate(`/p/${encodeURIComponent(project)}?${next}`); else setSearch(next); }}>{selected?.name}</button>}{childId && <span aria-hidden="true">/</span>}</>;
  const workspaceSession = newSession ? draftWorkspace.current!.session : childId ?? selected?.id ?? conversationId ?? '';
  return <OpenWorkspaceFile.Provider value={(path, worktree) => openFile.current(path, worktree)}><div className={`workspace root-workspace three-workspace${showRootList ? ' with-roots' : ''}`}>
    {creating && <div className="workspace-notices"><CreateTaskForm project={project} root={String(state.projection.projects?.find(row => row.id === project)?.root_path ?? '')} client={client} disabled={state.connection !== 'connected'} language={language} onCancel={() => setCreating(false)}/></div>}
    <div className="workspace-columns">
      {/* アプリの画面では、会話の一覧は左のサイドバーのプロジェクトの下に置き、作業場は会話とサブエージェントに広さを渡す。 */}
      {showRootList && <section className="workspace-roots" aria-label={t.conversations}><header className="column-header"><h2>{t.conversations}</h2><span className="column-count numeric">{roots.length}</span></header>
        <div className="column-scroll"><RootList roots={roots} selected={selected?.id} language={language} onSelect={root => {
          const next = new URLSearchParams(search); next.set('root', root.id); next.delete('path'); next.delete('child'); next.delete('session'); setSearch(next);
        }}/></div></section>}
      {(conversationId || newSession) ? <Workbench key={`${project}:${workspaceSession}`} project={project} session={workspaceSession} conversationId={conversationId ?? ''} newSession={newSession} client={client} language={language} bindings={bindings} registerOpenFile={openFile}
        renderConversation={(tabConversation, onConversation) => <>
          {tabConversation === conversationId && childNode?.delegation?.state === 'failed' && <div className="request-detail-actions"><strong>{childTitle || childNode.label}</strong><button className="btn btn-secondary btn-sm" disabled={state.connection !== 'connected'} onClick={() => void retry(childNode)}>{t.retry}</button></div>}
          {retryError && <p role="alert" className="status-line danger">{retryError}</p>}
          {renderConversation && (tabConversation !== conversationId || childId || selected?.conversation_ids.length === 1) ? <>{childId && <header className="conv-header"><div className="conv-title-row conv-breadcrumb">{breadcrumb}</div></header>}{renderConversation(tabConversation)}</>
            : <ConversationPage onConversation={onConversation} newSession={{ projectId: project, cwd: String(state.projection.projects?.find(row => row.id === project)?.root_path ?? '') }} target={target} client={client} conversationId={tabConversation} embedded language={language}
                breadcrumb={childId ? breadcrumb : undefined} seriesIds={tabConversation === conversationId && !childId ? series : undefined} seriesState={tabConversation === conversationId ? childId ? childNode?.state : selected?.state : undefined} displayName={tabConversation === conversationId ? childId ? childTitle : selected?.name : undefined}/>}
        </>}/>
        : <section className="workspace-conversation" aria-label={t.conversation}><p className="empty-row">{t.selectConversation}</p></section>}
      <WorkspacePanel bindings={bindings} project={project} target={target} client={client} language={language} rootId={selected?.id}/>
    </div>
  </div></OpenWorkspaceFile.Provider>;
}
export default WorkspacePage;
