import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { getProjectName, resolveProjectId } from '../../lib/projects.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { ConversationPage } from '../conversation/ConversationPage.tsx';
import { selectRoots, useRootIndex, buildRootTree, orderSeries } from '../../lib/roots.ts';
import { RootList, RootTree } from '../../components/RootViews.tsx';
import { CreateTaskForm } from '../../components/CreateTaskForm.tsx';
import { Icon } from '../../components/Icon.tsx';
import { answerApproval, isPending } from '../inbox/model.ts';
import '../../components/activity.css';
import '../files/files.css';

const REQUESTS_KEY = 'agent-graph-requests-open';
const REQUESTS_MIN_WIDTH = 1280;
// 依頼の流れの列は 1280px 以上で開いて始まる。利用者が畳んだときだけ、その選択を覚えて従う。
function userCollapsed(): boolean { return localStorage.getItem(REQUESTS_KEY) === '0'; }
function initialRequestsOpen(): boolean {
  return !userCollapsed() && (typeof window === 'undefined' || window.innerWidth >= REQUESTS_MIN_WIDTH);
}

/** プロジェクトの見出しと、同じ並びのタブ。作業場と依頼の流れと変更で共有する。 */
export function ProjectHeader({ route, name, language = 'en', actions }: { route: string; name: string; language?: Language; actions?: ReactNode }) {
  const t = dictionaries[language];
  const prefix = `/p/${encodeURIComponent(route)}`;
  return <header className="workspace-header"><h1 className="workspace-title"><Icon name="folder" size={16}/><span className="truncate">{name}</span></h1>
    <nav className="tabs header-tabs" aria-label={t.project}><NavLink end to={prefix}>{t.conversations}</NavLink><NavLink to={`${prefix}/changes`}>{t.changes}</NavLink></nav>
    <span className="spacer"/>{actions}</header>;
}

export function WorkspacePage({ project: suppliedProject, target = store, client, renderConversation, language = 'en', showRootList = true }: {
  project?: string; target?: ScreenStore; client: ConversationClient; language?: Language; renderConversation?: (conversationId: string) => ReactNode;
  /** 会話の一覧を作業場に出すか。サイドバーに一覧があるアプリの画面では出さない。 */
  showRootList?: boolean;
}) {
  const t = dictionaries[language];
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const route = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target);
  const project = resolveProjectId(state, route);
  const roots = useMemo(() => selectRoots(state, project), [state.projection.roots, state.projection.conversations, project]);
  const selected = roots.find(root => root.id === search.get('root')) ?? roots[0];
  const [creating, setCreating] = useState(search.get('create') === '1');
  const [requestsOpen, setRequestsOpenState] = useState(() => search.get('requests') === '1' || initialRequestsOpen());
  function setRequestsOpen(open: boolean) {
    setRequestsOpenState(open);
    if (open) localStorage.removeItem(REQUESTS_KEY); else localStorage.setItem(REQUESTS_KEY, '0');
  }
  useEffect(() => {
    const resize = () => { if (!userCollapsed()) setRequestsOpenState(window.innerWidth >= REQUESTS_MIN_WIDTH); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  // 依頼の流れへの移動は、右の列を開いて先頭の行に焦点を置く。
  const requestsWanted = search.get('requests') === '1';
  useEffect(() => {
    if (!requestsWanted) return;
    setRequestsOpenState(true);
    const next = new URLSearchParams(search); next.delete('requests'); setSearch(next, { replace: true });
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.workspace-requests .request-main')?.focus());
  }, [requestsWanted]); // eslint-disable-line react-hooks/exhaustive-deps
  const [retryError, setRetryError] = useState('');
  async function retry(node: { delegation?: Record<string, unknown> }) {
    if (!node.delegation) return;
    setRetryError('');
    try { const ack = await client.command('intake.retry', { requestId: node.delegation.request_id ?? node.delegation.id }); if (!ack.ok) setRetryError(ack.error ?? 'Retry failed'); }
    catch (cause) { setRetryError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const [child, setChild] = useState<{ root: string; id: string }>();
  const index = useRootIndex(state);
  const tree = useMemo(() => selected ? buildRootTree(selected, index) : { nodes: [], edges: [], roots: [], unresolved: [] }, [selected, index]);
  const requestedChild = child && child.root === selected?.id ? child.id : search.get('child') ?? undefined;
  const selectedNode = tree.nodes.find(node => node.conversationId === requestedChild || node.id === requestedChild);
  const childId = requestedChild && !selected?.conversation_ids.includes(requestedChild) ? selectedNode?.conversationId : undefined;
  // 系列は最後に動いた会話を末尾に並べ、その会話を開く。
  const series = useMemo(() => selected ? orderSeries(state, selected.conversation_ids) : [], [selected, state.projection.conversations, state.projection.runs]);
  const conversationId = childId ?? series.at(-1);
  // 子の会話は、頼んだ内容を名前として出す。
  const childNode = selectedNode;
  const childTitle = childNode ? tree.edges.find(edge => edge.target === childNode.id)?.title || undefined : undefined;
  return <div className={`workspace root-workspace${requestsOpen ? '' : ' requests-collapsed'}${showRootList ? ' with-roots' : ''}`}>
    <ProjectHeader route={route} name={getProjectName(state, project)} language={language}
      actions={<button className="btn btn-secondary btn-sm" onClick={() => setCreating(value => !value)} aria-expanded={creating}><Icon name="plus" size={14}/>{t.newTask}</button>}/>
    {creating && <div className="workspace-notices"><CreateTaskForm project={project} root={String(state.projection.projects?.find(row => row.id === project)?.root_path ?? '')} client={client} disabled={state.connection !== 'connected'} language={language} onCancel={() => setCreating(false)}/></div>}
    <div className="workspace-columns">
      {/* アプリの画面では、会話の一覧は左のサイドバーのプロジェクトの下に置き、作業場は会話とサブエージェントに広さを渡す。 */}
      {showRootList && <section className="workspace-roots" aria-label={t.conversations}><header className="column-header"><h2>{t.conversations}</h2><span className="column-count numeric">{roots.length}</span></header>
        <div className="column-scroll"><RootList roots={roots} selected={selected?.id} language={language} onSelect={root => {
          setChild(undefined); const next = new URLSearchParams(search); next.set('root', root.id); next.delete('path'); next.delete('child'); setSearch(next);
        }}/></div></section>}
      <section className="workspace-conversation" aria-label={t.conversation}>
        {childId && <button className="btn btn-ghost btn-sm root-back" aria-label={`Back to ${selected?.name ?? ""}`} onClick={() => { setChild(undefined); const next = new URLSearchParams(search); next.delete('child'); setSearch(next); }}><span aria-hidden="true">←</span>{selected?.name}</button>}
        {childNode?.delegation?.state === 'failed' && <div className="request-detail-actions"><strong>{childTitle || childNode.label}</strong><button className="btn btn-secondary btn-sm" disabled={state.connection !== 'connected'} onClick={() => void retry(childNode)}>{t.retry}</button></div>}
        {retryError && <p role="alert" className="status-line danger">{retryError}</p>}
        {conversationId ? renderConversation && (childId || selected?.conversation_ids.length === 1) ? renderConversation(conversationId)
          : <ConversationPage key={selected?.id + ':' + (childId ?? 'root')} target={target} client={client} conversationId={conversationId} embedded language={language}
            seriesIds={childId ? undefined : series} seriesState={childId ? childNode?.state : selected?.state} displayName={childId ? childTitle : selected?.name}/>
          : <p className="empty-row">{t.selectConversation}</p>}
      </section>
      <aside className="workspace-requests" aria-label={t.requests}><header className="column-header">
        {requestsOpen && <h2>{t.requests}</h2>}<span className="spacer"/>
        <button className="icon-button" aria-label={requestsOpen ? t.hideRequests : t.showRequests} title={requestsOpen ? t.hideRequests : t.showRequests} aria-expanded={requestsOpen}
          onClick={() => setRequestsOpen(!requestsOpen)}><Icon name={requestsOpen ? 'chevronRight' : 'chevronLeft'} size={14}/></button></header>
        {requestsOpen && <div className="column-scroll">{retryError && <p role="alert" className="status-line danger">{retryError}</p>}{selected && <RootTree tree={tree} language={language} selected={childId} root={selected}
          onSelectRoot={() => { setChild(undefined); const next = new URLSearchParams(search); next.delete('child'); setSearch(next); }}
          onRetry={client && state.connection === 'connected' ? node => void retry(node) : undefined}
          approvals={(state.projection.approvals ?? []).filter(isPending)}
          onAnswer={client && state.connection === 'connected' ? (approval, action) => void answerApproval(client, approval, action).catch(error => setRetryError(error instanceof Error ? error.message : String(error))) : undefined}
          onSelect={node => { if (selected) { const id = node.conversationId ?? node.id; setChild({ root: selected.id, id }); const next = new URLSearchParams(search); next.set('root', selected.id); next.set('child', id); setSearch(next); } }}/>}</div>}</aside>
    </div>
  </div>;
}
export default WorkspacePage;
