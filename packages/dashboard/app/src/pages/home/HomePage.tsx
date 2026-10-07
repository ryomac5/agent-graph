import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { getProjectName } from '../../lib/projects.ts';
import { selectRoots, useRootIndex, buildRootTree } from '../../lib/roots.ts';
import { readAttempts } from '../tree/model.ts';
import { RootList, RootTree } from '../../components/RootViews.tsx';
import '../../components/activity.css';

const PROJECT_ROOT_LIMIT = 5;
export function HomePage({ target = store }: { target?: ScreenStore; client?: ConversationClient; language?: Language }) {
  const navigate = useNavigate();
  const state = useScreenStore(target);
  const roots = useMemo(() => selectRoots(state), [state.projection.roots]);
  const index = useRootIndex(state);
  const groups = useMemo(() => {
    const groups = new Map<string, typeof roots>();
    for (const root of roots) {
      const project = root.project ?? 'other';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project)!.push(root);
    }
    return groups;
  }, [roots]);
  const trees = useMemo(() => new Map([...groups.values()].flatMap(items => items.slice(0, PROJECT_ROOT_LIMIT))
    .map(root => [root.id, buildRootTree(root, index)])), [groups, index]);
  const [unattendedOpen, setUnattendedOpen] = useState(false);
  const linked = new Set<string>();
  function markLinked(id: string) {
    if (linked.has(id)) return;
    linked.add(id);
    for (const relation of index.children.get(id) ?? []) markLinked(String(relation.to_id));
  }
  for (const root of roots) {
    for (const id of root.conversation_ids) markLinked(id);
    for (const delegation of index.delegations.get(root.id) ?? []) {
      if (delegation.conversation_id) markLinked(String(delegation.conversation_id));
      for (const attempt of readAttempts(delegation)) {
        const conversation = index.runsById.get(String(attempt.run_id))?.conversation_id;
        if (conversation) markLinked(String(conversation));
      }
    }
  }
  const unattended = [...index.conversations.values()].filter(row => row.type === 'unattended' && !linked.has(String(row.id)));
  return <div className="page home-page"><header className="page-header"><div className="page-title"><h1>Overview</h1><p className="muted-text">Root conversations and their running agents</p></div></header>
    {[...groups].map(([project, items]) => <section className="activity-group project-section" aria-label={getProjectName(state, project)} key={project}>
      <header className="section-header"><h2><Link to={`/p/${encodeURIComponent(project)}`}>{getProjectName(state, project)}</Link></h2></header>
      {items.slice(0, PROJECT_ROOT_LIMIT).map(root => <div key={root.id}><RootList roots={[root]}/><RootTree tree={trees.get(root.id)!} runningOnly onSelect={node => {
        if (node.conversationId) navigate(`/p/${encodeURIComponent(project)}?root=${encodeURIComponent(root.id)}&child=${encodeURIComponent(node.conversationId)}`);
      }}/></div>)}
      {items.length > PROJECT_ROOT_LIMIT && <Link className="btn btn-link" to={`/p/${encodeURIComponent(project)}`}>View all root conversations</Link>}
    </section>)}
    {!roots.length && <p className="empty-row">No root conversations yet</p>}
    <details className="activity-group" open={unattendedOpen}><summary onClick={event => { event.preventDefault(); setUnattendedOpen(value => !value); }}>Unattended <span className="count-pill">{unattended.length}</span></summary>
      {unattendedOpen && unattended.map(row => <Link className="root-row" key={String(row.id)} to={`/c/${encodeURIComponent(String(row.id))}`}>{String(row.name || 'Unattended run')} · {String(index.runs.get(String(row.id))?.state ?? row.state ?? 'unknown')}</Link>)}
    </details>
  </div>;
}
