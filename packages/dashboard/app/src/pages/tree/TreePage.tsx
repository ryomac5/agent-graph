import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { DelegationGraph } from '../../components/graph/DelegationGraph.tsx';
import { RootList, RootTree } from '../../components/RootViews.tsx';
import { buildRootTree, selectRoots, useRootIndex } from '../../lib/roots.ts';
import type { Language } from '../../lib/i18n.ts';
import { resolveProjectId } from '../../lib/projects.ts';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import './tree.css';

export function TreePage({ project, target = store, client }: { project?: string; target?: ScreenStore; client?: ConversationClient; language?: Language }) {
  const params = useParams(); const [search, setSearch] = useSearchParams();
  const route = project ?? params.project ?? ''; const state = useScreenStore(target);
  const projectId = resolveProjectId(state, route);
  const roots = useMemo(() => selectRoots(state, projectId), [state.projection.roots, projectId]);
  const root = roots.find(row => row.id === search.get('root'));
  const index = useRootIndex(state);
  const tree = useMemo(() => root ? buildRootTree(root, index) : undefined, [root, index]);
  const [selected, setSelected] = useState<string>();
  const prefix = `/p/${encodeURIComponent(route)}`;
  const current = tree?.nodes.find(node => node.id === selected);
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  async function retry() {
    if (!current?.delegation || !client || pending || state.connection !== 'connected') return;
    setPending(true); setError('');
    try { const ack = await client.command('intake.retry', { requestId: current.delegation.request_id ?? current.delegation.id }); if (!ack.ok) setError(ack.error ?? 'Retry failed'); }
    catch (cause) { setError(String(cause)); } finally { setPending(false); }
  }
  function select(id: string) { setSelected(id); }
  return <div className="page tree-page"><header className="page-header"><h1>Delegation tree and graph</h1></header>
    <nav className="tabs" aria-label="Project"><Link to={prefix}>Project</Link><Link to={`${prefix}/tree`} aria-current="page">Tree</Link><Link to={`${prefix}/changes`}>Changes</Link></nav>
    <section aria-label="Root conversations"><h2>Root conversations</h2><RootList roots={roots} selected={root?.id} onSelect={row => { setSelected(undefined); setSearch({ root: row.id }); }}/></section>
    {root && tree && <><h2>{root.name}</h2><div className="delegation-layout"><section className="delegation-tree" aria-label="Delegation tree"><RootTree tree={tree} selected={selected} onSelect={node => select(node.id)}/></section>
      <div className="delegation-graph-pane"><DelegationGraph key={root.id} tree={tree} selected={selected} onSelect={select}/></div></div>
      {current && <section className="delegation-detail" aria-label="Selected node"><h2>{current.label}</h2><div className="delegation-actions">
        {current.conversationId && <Link className="btn btn-secondary" to={prefix + '?root=' + encodeURIComponent(root.id) + (current.id === root.id ? '' : '&child=' + encodeURIComponent(current.conversationId))}>Open conversation</Link>}
        {current.run && <Link className="btn btn-secondary" to={prefix + '/changes?run=' + encodeURIComponent(String(current.run.id))}>Changes</Link>}
        {current.delegation?.state === 'failed' && <button className="btn btn-secondary" disabled={pending || !client || state.connection !== 'connected'} onClick={() => void retry()}>Retry delegation</button>}
      </div>{current.attempts.length > 0 && <details><summary>Attempt history</summary><ol>{current.attempts.map(attempt => <li key={String(attempt.attempt)}>Attempt {String(attempt.attempt)} · {String(attempt.state ?? 'unknown')}</li>)}</ol></details>}
      {error && <p role="alert">{error}</p>}</section>}
    </>}
  </div>;
}
