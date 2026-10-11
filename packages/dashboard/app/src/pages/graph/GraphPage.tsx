import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type Row, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { agentName, conversationName, readModel } from '../../lib/format.ts';
import { buildRootTree, currentRootConversation, selectRoots, useRootIndex, type ChildRole } from '../../lib/roots.ts';
import { getProjectName, resolveProjectId } from '../../lib/projects.ts';
import { ProjectHeader } from '../workspace/WorkspacePage.tsx';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { readObject, readText } from '../../components/conversation/model.ts';
import { answerApproval, getConversation, isPending } from '../inbox/model.ts';
import { buildRows, readCurrentWork, readExpanded, readReport, PAGE_SIZE, type GraphRow, type GraphTree } from './rows.ts';
import { GraphOutline, GraphSummary, type OutlineProps } from './GraphOutline.tsx';
import { GraphTimeline, type TimeRange } from './GraphTimeline.tsx';
import { GraphDetail } from './GraphDetail.tsx';
import './graph.css';

export function GraphPage({ project: suppliedProject, target = store, client, language = 'en', embedded = false, rootId }: {
  project?: string; target?: ScreenStore; client: ConversationClient; language?: Language; embedded?: boolean; rootId?: string;
}) {
  const params = useParams(); const [search, setSearch] = useSearchParams();
  const route = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target); const project = resolveProjectId(state, route);
  const roots = useMemo(() => selectRoots(state, project), [state, project]);
  const root = roots.find(item => item.id === (rootId ?? search.get('root'))) ?? roots[0];
  const index = useRootIndex(state);
  const loading = !state.projectionError && ['roots', 'conversations', 'runs', 'relations', 'delegations', 'approvals'].some(table => state.pages?.[table]?.next);
  const tree = useMemo<GraphTree>(() => {
    if (!root) return { nodes: [], edges: [], roots: [], unresolved: [] };
    const built = buildRootTree(root, index);
    const rootConversation = currentRootConversation(root, index);
    const pending = (state.projection.approvals ?? []).filter(isPending);
    const nodes = built.nodes.map(node => {
      const conversationId = node.id === root.id ? rootConversation : node.conversationId;
      const conversation = index.conversations.get(conversationId ?? ''); const run = node.run ?? index.runs.get(conversationId ?? '');
      const approvals = pending.filter(row => Boolean(run && row.run_id === run.id) || Boolean(conversationId && getConversation(row, state) === conversationId));
      const edge = built.edges.find(edge => edge.target === node.id);
      const review = (state.projection.relations ?? []).find(row => row.type === 'review_of' && row.from_id === conversationId && row.active !== 0 && row.active !== false);
      return { ...node, conversationId, run, role: review ? 'review' : node.role,
        provider: node.provider || String(conversation?.provider ?? ''), model: node.model || readModel(run).model || String(run?.model ?? conversation?.model ?? ''),
        label: node.id === root.id ? root.name : readText(node.delegation?.description ?? readObject(node.delegation?.request).description) || edge?.title || conversationName(state, conversationId ?? '') || (node.role === 'planner' ? node.label : agentName(node.provider, node.model) || 'Agent'),
        state: approvals.length ? 'waiting_approval' : node.state, approvals,
        currentWork: readCurrentWork(state, conversationId ?? '', language), report: readReport(state, conversationId ?? ''),
        inferred: edge?.confidence === 'inferred' || node.role === 'review' && !review,
      };
    });
    // 対象が確かなレビューを作業の子へ移す。
    for (const relation of state.projection.relations ?? []) {
      if (relation.type !== 'review_of' || relation.active === 0 || relation.active === false) continue;
      const child = nodes.find(node => node.conversationId === relation.from_id); const parent = nodes.find(node => node.conversationId === relation.to_id);
      if (!child || !parent || child.id === parent.id) continue;
      let ancestor = parent; const seen = new Set<string>();
      while (ancestor && !seen.has(ancestor.id) && ancestor.id !== child.id) { seen.add(ancestor.id); ancestor = nodes.find(node => node.children.includes(ancestor.id))!; }
      if (ancestor?.id === child.id) continue;
      nodes.forEach(node => { node.children = node.children.filter(id => id !== child.id); }); parent.children.push(child.id);
    }
    return { ...built, nodes };
  }, [root, index, state, language]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  const [role, setRole] = useState<ChildRole>(); const [range, setRange] = useState<TimeRange>('6h');
  const requested = tree.nodes.find(node => node.conversationId === search.get('child'))?.id;
  const [detail, setDetail] = useState<string>();
  useEffect(() => { setDetail(undefined); }, [requested, root?.id]);
  const selected = detail ?? requested ?? root?.id ?? '';
  const expanded = readExpanded(search.getAll('expanded'));
  const model = buildRows(tree, { now, expanded, selected, role, state });
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!requested) return;
    if (role && !model.rows.some(row => row.id === requested)) setRole(undefined);
    const row = Array.from(surface.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? []).find(item => item.dataset.nodeId === requested);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [requested, role]);
  useEffect(() => {
    if (!requested || role) return;
    const automatic = model.rows.filter(row => row.group && !row.group.more && row.group.shown > (expanded.get(row.id) ?? 0));
    if (!automatic.length) return;
    setSearch(current => { const query = new URLSearchParams(current); const next = readExpanded(query.getAll('expanded')); automatic.forEach(row => next.set(row.id, row.group!.shown)); query.delete('expanded'); next.forEach((count, id) => query.append('expanded', `${id}@${count}`)); return query; }, { replace: true });
  }, [requested, search.toString(), role]);
  const [sent, setSent] = useState(new Set<string>()); const answering = useRef(new Set<string>()); const [error, setError] = useState('');
  async function answer(row: Row, action: 'allow' | 'deny') {
    const id = String(row.id); if (answering.current.has(id)) return;
    answering.current.add(id); setSent(current => new Set([...current, id])); setError('');
    try { await answerApproval(client, row, action); }
    catch (cause) { answering.current.delete(id); setSent(current => { const next = new Set(current); next.delete(id); return next; }); setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function group(id: string, action: 'more' | 'close') {
    const next = new Map(expanded); if (action === 'close') next.delete(id); else next.set(id, (next.get(id) ?? 0) + PAGE_SIZE);
    setSearch(current => { const query = new URLSearchParams(current); query.delete('expanded'); next.forEach((count, key) => query.append('expanded', `${key}@${count}`)); return query; });
  }
  function href(row: GraphRow) {
    const query = new URLSearchParams(search); query.set('root', root!.id); query.delete('child');
    if (row.role !== 'main' && row.node?.conversationId) query.set('child', row.node.conversationId);
    return `/p/${encodeURIComponent(route)}?${query}`;
  }
  const props: OutlineProps = { model, language, selected, now, embedded, href, onSelect: row => {
    setDetail(embedded && row.node?.conversationId ? undefined : row.id);
    if (!embedded) setSearch(current => { const query = new URLSearchParams(current); query.set('root', root!.id); query.delete('child'); if (row.role !== 'main' && row.node?.conversationId) query.set('child', row.node.conversationId); return query; });
  }, onGroup: group, onAnswer: answer, sent, connected: state.connection === 'connected' };
  const selectedRow = model.all.find(row => row.id === (detail ?? requested));
  return <div className="graph-page" ref={surface} aria-busy={loading}>
    {!embedded && <ProjectHeader route={route} name={getProjectName(state, project)} language={language}/>}
    {loading ? <div className="graph-empty" role="status">{language === 'ja' ? '読み込み中…' : 'Loading…'}</div> : root ? <>
      {!embedded && <div className="graph-toolbar"><span title={root.name}>{root.name}</span></div>}
      <GraphSummary model={model} role={role} onRole={setRole} language={language} embedded={embedded}/>
      {error && <p className="banner banner-danger" role="alert">{error}</p>}
      {embedded ? <div className="graph-scroll"><GraphOutline {...props}/></div> : <GraphTimeline {...props} range={range} onRange={setRange}/>}
      {(!embedded || detail) && selectedRow?.node && <GraphDetail row={selectedRow} language={language} now={now} href={href(selectedRow)} onClose={() => { setDetail(undefined); if (!embedded) setSearch(current => { const query = new URLSearchParams(current); query.delete('child'); return query; }); }}/>}
    </> : <div className="graph-empty">{language === 'ja' ? '会話がありません' : 'No conversations yet'}</div>}
  </div>;
}
