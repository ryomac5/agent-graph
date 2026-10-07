import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { AppLink } from '../../components/AppLink.tsx';
import { DelegationGraph } from '../../components/graph/DelegationGraph.tsx';
import type { Language } from '../../lib/i18n.ts';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { buildDelegationTree, type TreeNode } from './model.ts';
import { NodeSummary } from './NodeSummary.tsx';
import './tree.css';

export function TreePage({ project, target = store, client, language = 'en' }: {
  project?: string; target?: ScreenStore; client?: ConversationClient; language?: Language;
}) {
  const params = useParams();
  const projectId = project ?? params.project;
  const state = useScreenStore(target);
  const tree = useMemo(() => buildDelegationTree(state, projectId), [state, projectId]);
  const [selected, setSelected] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ja = language === 'ja';
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const current = selected ? byId.get(selected) : undefined;
  const prefix = `/p/${encodeURIComponent(projectId ?? '')}`;
  async function retry(node: TreeNode) {
    if (!client || pending || !node.delegation) return;
    setPending(true); setError('');
    try {
      const ack = await client.command('intake.retry', { requestId: node.delegation.request_id ?? node.delegation.id });
      if (!ack.ok) setError(ack.error || (ja ? '再試行に失敗しました' : 'Retry failed'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  function renderBranch(id: string) {
    const node = byId.get(id)!;
    const edge = tree.edges.find(edge => edge.target === id && edge.kind === 'delegated');
    return <li key={id}>
      {edge && <p className="delegation-edge-label">{edge.title} · {edge.confidence}</p>}
      <div className={`delegation-tree-card ${selected === id ? 'is-selected' : ''} ${node.state === 'unknown' ? 'is-unknown' : ''}`}>
        <button className="delegation-select" aria-pressed={selected === id} onClick={() => setSelected(id)}>{node.label}</button>
        <NodeSummary node={node} language={language}/>
      </div>
      {node.children.length > 0 && <ul>{node.children.map(renderBranch)}</ul>}
    </li>;
  }
  return <div className="page tree-page">
    <header className="page-header"><div className="page-title"><h1>{ja ? '委譲の木とグラフ' : 'Delegation tree and graph'}</h1></div></header>
    {projectId && <nav className="tabs" aria-label={ja ? 'プロジェクト' : 'Project'}>
      <AppLink to={prefix}>{ja ? 'プロジェクト' : 'Project'}</AppLink>
      <AppLink to={`${prefix}/tree`} aria-current="page">{ja ? '委譲' : 'Tree'}</AppLink>
      <AppLink to={`${prefix}/changes`}>Changes</AppLink>
    </nav>}
    {tree.nodes.length === 0 ? <div className="empty-state">{ja ? '委譲はまだありません' : 'No delegations yet'}</div> : <>
      <div className="delegation-layout">
        <section className="delegation-tree" aria-label={ja ? '委譲の木' : 'Delegation tree'}>
          <ul>{tree.roots.map(renderBranch)}</ul>
          {tree.unresolved.length > 0 && <section className="delegation-unresolved" aria-label={ja ? '親が未確定' : 'Unconfirmed parent'}>
            <h2>{ja ? '親が未確定' : 'Unconfirmed parent'}</h2>
            <ul>{tree.unresolved.map(renderBranch)}</ul>
          </section>}
        </section>
        <DelegationGraph tree={tree} selected={selected} onSelect={setSelected} language={language}/>
      </div>
      <section className="delegation-detail" id="delegation-evidence" aria-label={ja ? '選択した節' : 'Selected node'}>
        {current ? <>
          <h2>{current.label}</h2>
          <div className="delegation-actions">
            {current.conversationId && <AppLink className="btn btn-secondary" to={`/c/${encodeURIComponent(current.conversationId)}`}>{ja ? '会話を開く' : 'Open conversation'}</AppLink>}
            {current.run && projectId && <AppLink className="btn btn-secondary" to={`${prefix}/changes?run=${encodeURIComponent(String(current.run.id))}`}>Changes</AppLink>}
            {current.delegation?.state === 'failed' && <button className="btn btn-secondary" disabled={pending || !client || state.connection !== 'connected'} onClick={() => void retry(current)}>{ja ? '再試行' : 'Retry delegation'}</button>}
          </div>
          {current.attempts.length > 0 && <details className="delegation-attempts"><summary>{ja ? '試行の履歴' : 'Attempt history'}</summary>
            <ol>{current.attempts.map(attempt => {
              const run = state.projection.runs?.find(run => run.id === attempt.run_id);
              return <li key={String(attempt.attempt)}>{ja ? '試行' : 'Attempt'} {String(attempt.attempt)} · {String(attempt.state ?? 'unknown')}
                {run && <AppLink to={`/c/${encodeURIComponent(String(run.conversation_id))}`}>{ja ? '会話を開く' : 'Open conversation'}</AppLink>}
                {run && projectId && <AppLink to={`${prefix}/changes?run=${encodeURIComponent(String(run.id))}`}>Changes</AppLink>}
              </li>;
            })}</ol>
          </details>}
        </> : <p>{ja ? '節を選択してください' : 'Select a node to open its conversation, changes and attempts.'}</p>}
        {error && <p className="banner banner-danger" role="alert">{error}</p>}
      </section>
    </>}
  </div>;
}
