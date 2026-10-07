import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { getProjectName, resolveProjectId } from '../../lib/projects.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { ConversationPage } from '../conversation/ConversationPage.tsx';
import { selectRoots, useRootIndex, buildRootTree } from '../../lib/roots.ts';
import { RootList, RootTree } from '../../components/RootViews.tsx';
import { CreateTaskForm } from '../../components/CreateTaskForm.tsx';
import { Icon } from '../../components/Icon.tsx';
import '../../components/activity.css';
import '../files/files.css';

export function WorkspacePage({ project: suppliedProject, target = store, client, renderConversation }: {
  project?: string; target?: ScreenStore; client: ConversationClient; language?: Language; renderConversation?: (conversationId: string) => ReactNode;
}) {
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const route = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target);
  const project = resolveProjectId(state, route);
  const roots = useMemo(() => selectRoots(state, project), [state.projection.roots, project]);
  const selected = roots.find(root => root.id === search.get('root')) ?? roots[0];
  const [creating, setCreating] = useState(search.get('create') === '1');
  const [child, setChild] = useState<{ root: string; id: string }>();
  const index = useRootIndex(state);
  const tree = useMemo(() => selected ? buildRootTree(selected, index) : { nodes: [], edges: [], roots: [], unresolved: [] }, [selected, index]);
  const requestedChild = child && child.root === selected?.id ? child.id : search.get('child') ?? undefined;
  const childId = requestedChild && !selected?.conversation_ids.includes(requestedChild) && tree.nodes.some(node => node.conversationId === requestedChild) ? requestedChild : undefined;
  const conversationId = childId ?? selected?.conversation_ids.at(-1);
  const prefix = `/p/${encodeURIComponent(route)}`;
  return <div className="workspace root-workspace">
    <header className="workspace-header"><div className="page-title"><h1><Icon name="folder" size={18}/>{getProjectName(state, project)}</h1></div><button className="btn btn-secondary btn-sm" onClick={() => setCreating(value => !value)} aria-expanded={creating}>New task</button></header>
    {creating && <div className="workspace-notices"><CreateTaskForm project={project} root={String(state.projection.projects?.find(row => row.id === project)?.root_path ?? '')} client={client} disabled={state.connection !== 'connected'} language="en" onCancel={() => setCreating(false)}/></div>}
    <nav className="tabs" aria-label="Project"><Link to={prefix} aria-current="page">Project</Link><Link to={`${prefix}/tree${selected ? `?root=${encodeURIComponent(selected.id)}` : ''}`}>Tree</Link><Link to={`${prefix}/changes`}>Changes</Link></nav>
    <div className="workspace-columns">
      <div className="workspace-center">
        <section className="workspace-tasks" aria-label="Root conversations"><header className="column-header"><h2>Root conversations</h2><span className="count-pill">{roots.length}</span></header>
          <div className="column-scroll"><RootList roots={roots} selected={selected?.id} onSelect={root => {
            setChild(undefined); const next = new URLSearchParams(search); next.set('root', root.id); next.delete('path'); next.delete('child'); setSearch(next);
          }}/></div></section>
        <section className="workspace-conversation" aria-label="Conversation">
          {childId && <button className="btn btn-ghost root-back" onClick={() => { setChild(undefined); const next = new URLSearchParams(search); next.delete('child'); setSearch(next); }}>← Back to {selected?.name}</button>}
          {conversationId ? renderConversation && (childId || selected?.conversation_ids.length === 1) ? renderConversation(conversationId)
            : <ConversationPage key={selected?.id + ':' + (childId ?? 'root')} target={target} client={client} conversationId={conversationId} embedded
              seriesIds={childId ? undefined : selected?.conversation_ids} displayName={childId ? undefined : selected?.name}/>
            : <p className="empty-row">Select a root conversation</p>}
        </section>
      </div>
      <aside className="workspace-changes" aria-label="Delegation tree"><header className="column-header"><h2>Delegation tree</h2></header>
        <div className="column-scroll"><RootTree tree={tree} selected={childId} onSelect={node => { if (node.conversationId && selected) { setChild({ root: selected.id, id: node.conversationId }); } }}/></div></aside>
    </div>
  </div>;
}
export default WorkspacePage;
