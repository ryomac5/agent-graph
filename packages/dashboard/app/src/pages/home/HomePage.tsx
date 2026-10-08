import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { getProjectName } from '../../lib/projects.ts';
import { selectRoots, useRootIndex, buildRootTree, rootProject } from '../../lib/roots.ts';
import { getRegisteredProjects, OTHER_PROJECT } from '../../lib/projects.ts';
import { RootList, RootTree } from '../../components/RootViews.tsx';
import { Icon } from '../../components/Icon.tsx';
import '../../components/activity.css';

const PROJECT_ROOT_LIMIT = 5;
export function HomePage({ target = store, language = 'en' }: { target?: ScreenStore; client?: ConversationClient; language?: Language }) {
  const t = dictionaries[language];
  const navigate = useNavigate();
  const state = useScreenStore(target);
  const roots = useMemo(() => selectRoots(state), [state.projection.roots, state.projection.conversations]);
  const index = useRootIndex(state);
  const groups = useMemo(() => {
    const groups = new Map<string, typeof roots>();
    const registered = new Set(getRegisteredProjects(state).map(row => String(row.id)));
    for (const root of roots) {
      const project = rootProject(root, registered);
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project)!.push(root);
    }
    return groups;
  }, [roots, state.projection.projects]);
  const trees = useMemo(() => new Map([...groups.values()].flatMap(items => items.slice(0, PROJECT_ROOT_LIMIT))
    .map(root => [root.id, buildRootTree(root, index)])), [groups, index]);
  const [otherOpen, setOtherOpen] = useState(false);
  const other = groups.get(OTHER_PROJECT) ?? [];
  const renderRoot = (project: string, root: (typeof roots)[number]) => <div className="root-block" key={root.id}><RootList roots={[root]} language={language}/><RootTree tree={trees.get(root.id) ?? buildRootTree(root, index)} runningOnly language={language} onSelect={node => {
    if (node.conversationId) navigate(`/p/${encodeURIComponent(project)}?root=${encodeURIComponent(root.id)}&child=${encodeURIComponent(node.conversationId)}`);
  }}/></div>;
  return <div className="page home-page"><header className="page-header"><h1>{t.overview}</h1></header>
    {[...groups].filter(([project]) => project !== OTHER_PROJECT).map(([project, items]) => <section className="activity-group project-section" aria-label={getProjectName(state, project)} key={project}>
      <header className="section-header"><h2><Link to={`/p/${encodeURIComponent(project)}`}><Icon name="folder" size={14}/>{getProjectName(state, project)}</Link></h2></header>
      <div className="root-card">{items.slice(0, PROJECT_ROOT_LIMIT).map(root => renderRoot(project, root))}</div>
      {items.length > PROJECT_ROOT_LIMIT && <Link className="btn btn-link show-more" to={`/p/${encodeURIComponent(project)}`}>{t.viewAll}</Link>}
    </section>)}
    {!roots.length && <p className="empty-row">{t.noConversations}</p>}
    {other.length > 0 && <details className="activity-group fold-section project-section" aria-label={t.other} open={otherOpen}><summary className="section-header" onClick={event => { event.preventDefault(); setOtherOpen(value => !value); }}>
      <Icon name={otherOpen ? 'chevronDown' : 'chevronRight'} size={14}/><h2>{t.other}</h2><span className="column-count numeric">{other.length}</span></summary>
      {otherOpen && <><div className="root-card">{other.slice(0, PROJECT_ROOT_LIMIT).map(root => renderRoot(OTHER_PROJECT, root))}</div>
        {other.length > PROJECT_ROOT_LIMIT && <Link className="btn btn-link show-more" to={`/p/${OTHER_PROJECT}`}>{t.viewAll}</Link>}</>}
    </details>}
  </div>;
}
