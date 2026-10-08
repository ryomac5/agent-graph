import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type Row, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { agentName, conversationName, formatWhen, readModel, summarizeApproval } from '../../lib/format.ts';
import { buildRootTree, orderSeries, selectRoots, useRootIndex, type Root } from '../../lib/roots.ts';
import { getProjectName, resolveProjectId } from '../../lib/projects.ts';
import { ProviderMark, lastActivity } from '../../components/RootViews.tsx';
import { StatusDot, stateLabel, stateTone, toDisplayState } from '../../components/StateBadge.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ProjectHeader } from '../workspace/WorkspacePage.tsx';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { answerApproval, getConversation, getDecision, isPending } from '../inbox/model.ts';
import { calculateLayout, curvePath, foldEarlier, type GraphLayout, type GraphTree, type PositionedNode } from './layout.ts';
import './graph.css';

const MIN_SCALE = 0.15;
const MAX_SCALE = 2;
const VIEW_PADDING = 48;
interface View { x: number; y: number; scale: number }
const clampScale = (scale: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

export function GraphPage({ project: suppliedProject, target = store, client, language = 'en' }: {
  project?: string; target?: ScreenStore; client: ConversationClient; language?: Language;
}) {
  const params = useParams();
  const [search] = useSearchParams();
  const route = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target);
  const project = resolveProjectId(state, route);
  const roots = useMemo(() => selectRoots(state, project), [state, project]);
  const root = roots.find(item => item.id === search.get('root')) ?? roots[0];
  const index = useRootIndex(state);
  const approvals = (state.projection.approvals ?? []).filter(isPending);
  const tree = useMemo<GraphTree>(() => {
    if (!root) return { nodes: [], edges: [], roots: [], unresolved: [] };
    const built = buildRootTree(root, index);
    const rootConversation = orderSeries(state, root.conversation_ids).at(-1);
    return { ...built, nodes: built.nodes.map(node => {
      const conversationId = node.id === root.id ? rootConversation : node.conversationId;
      const conversation = index.conversations.get(conversationId ?? '');
      const run = node.run ?? index.runs.get(conversationId ?? '');
      const pending = approvals.filter(row => Boolean(run && row.run_id === run.id) || Boolean(conversationId && getConversation(row, state) === conversationId));
      return { ...node, conversationId, run, provider: node.provider || String(conversation?.provider ?? ''),
        model: node.model || readModel(run).model || String(run?.model ?? conversation?.model ?? ''),
        label: node.id === root.id ? root.name : built.edges.find(edge => edge.target === node.id)?.title || conversationName(state, conversationId ?? '') || node.label,
        state: pending.length ? 'waiting_approval' : node.state,
        activity: node.id === root.id ? root.last_activity_ts ?? lastActivity({ ...node, run }) : lastActivity(node), approvalCount: pending.length };
    }) };
  }, [root, index, state]);
  return <div className="graph-page">
    <ProjectHeader route={route} name={getProjectName(state, project)} language={language}/>
    {root ? <GraphCanvas key={root.id} tree={tree} root={root} route={route} language={language} approvals={approvals}
      connected={state.connection === 'connected'} client={client} requestedChild={search.get('child') ?? undefined}/>
      : <div className="graph-empty"><Icon name="bot" size={28}/><h2>{language === 'ja' ? '会話がありません' : 'No conversations yet'}</h2><p>{language === 'ja' ? '会話を始めると、ここに依頼の流れが表示されます。' : 'Start a conversation to see its requests here.'}</p></div>}
  </div>;
}

function GraphCanvas({ tree, root, route, language, approvals, connected, client, requestedChild }: {
  tree: GraphTree; root: Root; route: string; language: Language; approvals: Row[]; connected: boolean;
  client: ConversationClient; requestedChild?: string;
}) {
  const ja = language === 'ja';
  const canvas = useRef<HTMLDivElement>(null);
  const links = useRef(new Map<string, HTMLElement>());
  const previous = useRef<GraphLayout | undefined>(undefined);
  const [size, setSize] = useState({ width: window.innerWidth, height: 640 });
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const parents = new Set<string>();
    let child = tree.nodes.find(node => node.conversationId === requestedChild)?.id;
    while (child) {
      const parent = tree.edges.find(edge => edge.target === child)?.source;
      if (!parent || parents.has(parent)) break;
      parents.add(parent); child = parent;
    }
    return parents;
  });
  const [now, setNow] = useState(Date.now);
  const [focused, setFocused] = useState(requestedChild ? tree.nodes.find(node => node.conversationId === requestedChild)?.id ?? root.id : root.id);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const visible = useMemo(() => foldEarlier(tree, expanded, now, focused), [tree, expanded, now, focused]);
  const layout = useMemo(() => calculateLayout(visible, size.width, previous.current), [visible, size.width]);
  const byId = new Map(visible.nodes.map(node => [node.id, node]));
  const positions = new Map(layout.nodes.map(node => [node.id, node]));
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view); viewRef.current = view;
  const [sent, setSent] = useState(new Set<string>());
  const answering = useRef(new Set<string>());
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const measuredSize = useRef(size);
  const drag = useRef<{ id: number; x: number; y: number; view: View } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  function fit() {
    const scale = Math.max(0.001, Math.min(1, Math.max(1, size.width - VIEW_PADDING * 2) / Math.max(layout.width, 1), Math.max(1, size.height - VIEW_PADDING * 2) / Math.max(layout.height, 1)));
    setView({ scale, x: (size.width - layout.width * scale) / 2, y: (size.height - layout.height * scale) / 2 });
  }
  function zoom(factor: number, x = size.width / 2, y = size.height / 2) {
    setView(current => {
      const scale = factor < 1 && current.scale < MIN_SCALE ? Math.max(0.001, current.scale * factor) : clampScale(current.scale * factor);
      return { scale, x: x - (x - current.x) * scale / current.scale, y: y - (y - current.y) * scale / current.scale };
    });
  }
  function reveal(node: PositionedNode) {
    setView(current => {
      const left = current.x + node.x * current.scale; const top = current.y + node.y * current.scale;
      const right = left + node.width * current.scale; const bottom = top + node.height * current.scale;
      return { ...current, x: current.x + (left < 20 ? 20 - left : right > size.width - 20 ? size.width - 20 - right : 0),
        y: current.y + (top < 20 ? 20 - top : bottom > size.height - 76 ? size.height - 76 - bottom : 0) };
    });
  }
  useLayoutEffect(() => {
    const changedDirection = previous.current && previous.current.vertical !== layout.vertical;
    const resized = measuredSize.current.width !== size.width || measuredSize.current.height !== size.height;
    measuredSize.current = size;
    previous.current = layout;
    if (!initialized.current || changedDirection || resized) { fit(); initialized.current = true; }
    else {
      const node = positions.get(focused);
      if (node) reveal(node);
    }
  }, [layout, size.height]);
  useEffect(() => {
    const element = canvas.current!;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({ width: rect.width || window.innerWidth, height: rect.height || 640 });
    };
    measure(); window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => { window.removeEventListener('resize', measure); observer?.disconnect(); };
  }, []);
  useEffect(() => {
    const element = canvas.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoom(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [size]);
  async function answer(row: Row, action: 'allow' | 'deny') {
    const id = String(row.id);
    if (answering.current.has(id)) return;
    answering.current.add(id); setSent(current => new Set([...current, id])); setError('');
    try { await answerApproval(client, row, action); }
    catch (cause) { answering.current.delete(id); setSent(current => { const next = new Set(current); next.delete(id); return next; }); setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function move(event: KeyboardEvent, id: string) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const node = positions.get(id)!;
    const horizontal = ['ArrowLeft', 'ArrowRight'].includes(event.key);
    const sign = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
    const candidates = layout.nodes.filter(other => other.id !== id).map(other => {
      const dx = other.x + other.width / 2 - node.x - node.width / 2;
      const dy = other.y + other.height / 2 - node.y - node.height / 2;
      return { other, forward: (horizontal ? dx : dy) * sign, distance: Math.hypot(dx, dy) + Math.abs(horizontal ? dy : dx) * 2 };
    }).filter(item => item.forward > 0).sort((a, b) => a.distance - b.distance);
    const next = event.key === 'Home' ? layout.nodes[0] : event.key === 'End' ? layout.nodes.at(-1) : candidates[0]?.other;
    if (next) { setFocused(next.id); reveal(next); links.current.get(next.id)?.focus(); }
  }
  const running = tree.nodes.filter(node => toDisplayState(node.state) === 'running' || toDisplayState(node.state) === 'starting').length;
  const waiting = tree.nodes.filter(node => node.state === 'waiting_approval').length;
  const earlierLabel = (count: number) => ja ? `以前の依頼 ${count} 件` : `${count} earlier ${count === 1 ? 'request' : 'requests'}`;
  return <>
    <div className="graph-toolbar"><div className="graph-context"><span className="graph-context-label">{ja ? '根の会話' : 'ROOT CONVERSATION'}</span><strong title={root.name}>{root.name}</strong></div>
      <div className="graph-summary"><span className="graph-total">{ja ? `依頼 ${tree.nodes.filter(node => node.id !== root.id && node.role !== 'planner').length} 件` : `${tree.nodes.filter(node => node.id !== root.id && node.role !== 'planner').length} requests`}</span>
        {running > 0 && <span><i className="graph-indicator running"/>{ja ? `${running} 実行中` : `${running} running`}</span>}
        {waiting > 0 && <span><i className="graph-indicator waiting"/>{ja ? `${waiting} 承認待ち` : `${waiting} awaiting approval`}</span>}</div></div>
    {error && <p className="banner banner-danger" role="alert">{error}</p>}
    <div ref={canvas} className={`graph-canvas${dragging ? ' dragging' : ''}`} role="region" aria-label={ja ? '依頼のグラフ' : 'Request graph'} data-direction={layout.vertical ? 'vertical' : 'horizontal'}
      onPointerDown={event => {
        if (event.button !== 0 || (event.target as Element).closest('.graph-card, .graph-controls')) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view: viewRef.current };
        event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
      }} onPointerMove={event => {
        if (!drag.current || drag.current.id !== event.pointerId) return;
        setView({ ...drag.current.view, x: drag.current.view.x + event.clientX - drag.current.x, y: drag.current.view.y + event.clientY - drag.current.y });
      }} onPointerUp={() => { drag.current = undefined; setDragging(false); }} onPointerCancel={() => { drag.current = undefined; setDragging(false); }}>
      <div className="graph-world" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        <svg className="graph-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {visible.edges.map(edge => {
            const parent = positions.get(edge.source); const child = positions.get(edge.target); const node = byId.get(edge.target);
            if (!parent || !child || !node) return null;
            const tone = stateTone(toDisplayState(node.state));
            return <g key={edge.id} className={`graph-edge edge-${tone}${edge.confidence === 'inferred' ? ' edge-inferred' : ''}`}><path d={curvePath(parent, child, layout.vertical)}/>
              {tone === 'running' && <path className="graph-edge-flow" d={curvePath(parent, child, layout.vertical)}/>}
              <circle cx={child.x + (layout.vertical ? child.width / 2 : 0)} cy={child.y + (layout.vertical ? 0 : child.height / 2)} r="3"/></g>;
          })}
        </svg>
        {layout.nodes.map(position => {
          const node = byId.get(position.id)!;
          const isRoot = node.id === root.id;
          const pending = approvals.filter(row => Boolean(node.run && row.run_id === node.run.id) || Boolean(node.conversationId && row.conversation_id === node.conversationId));
          const title = node.earlier ? earlierLabel(node.earlier.count) : node.label;
          const who = agentName(node.provider, node.model) || (ja ? 'エージェント' : 'Agent');
          const tone = stateTone(toDisplayState(node.state));
          const target = `/p/${encodeURIComponent(route)}?root=${encodeURIComponent(root.id)}${!isRoot && node.conversationId ? `&child=${encodeURIComponent(node.conversationId)}` : ''}`;
          const content = <><div className="graph-card-top"><ProviderMark provider={node.provider}/><span className="graph-node-role">{isRoot ? ja ? '根の会話' : 'Root conversation' : node.role === 'planner' ? ja ? '依頼のまとまり' : 'Request group' : ja ? '依頼' : 'Request'}</span>
            {node.state !== 'idle' && <StatusDot state={node.state} language={language}/>}</div>
            <strong className="graph-card-title" title={title}>{title}</strong><div className="graph-card-meta"><span title={who}>{who}</span><time dateTime={node.activity || undefined}>{formatWhen(node.activity, language) || (ja ? '時刻不明' : 'Unknown time')}</time></div></>;
          const focus = () => { setFocused(node.id); reveal(position); };
          return <article key={node.id} className={`graph-card tone-${tone}${toDisplayState(node.state) === 'unknown' ? ' graph-unknown' : ''}${isRoot ? ' graph-root' : ''}${node.earlier ? ' graph-earlier' : ''}${focused === node.id ? ' graph-selected' : ''}`}
            style={{ left: position.x, top: position.y, width: position.width, height: position.height }} data-node-id={node.id} onFocus={focus}>
            {node.earlier ? <button className="graph-card-link" ref={element => { if (element) links.current.set(node.id, element); else links.current.delete(node.id); }} onFocus={focus} onKeyDown={event => move(event, node.id)}
              aria-label={title} aria-expanded="false" onClick={() => { links.current.get(node.earlier!.parent)?.focus(); setFocused(node.earlier!.parent); setExpanded(current => new Set([...current, node.earlier!.parent])); }}><span className="graph-earlier-icon"><Icon name="chevronRight" size={16}/></span><strong>{title}</strong><span>{ja ? '押して開く' : 'Click to expand'}</span></button>
              : node.conversationId ? <Link className="graph-card-link" to={target} ref={element => { if (element) links.current.set(node.id, element); else links.current.delete(node.id); }} onFocus={focus} onKeyDown={event => move(event, node.id)} aria-label={`${title} · ${who} · ${stateLabel(node.state, language)}`}>{content}</Link>
                : <button className="graph-card-link" ref={element => { if (element) links.current.set(node.id, element); else links.current.delete(node.id); }} onFocus={focus} onKeyDown={event => move(event, node.id)}
                  aria-label={title} aria-expanded="true" onClick={() => { const child = node.children.map(id => positions.get(id)).find(Boolean); if (child) { reveal(child); links.current.get(child.id)?.focus(); } }}>{content}</button>}
            {pending.map(row => <div key={String(row.id)} className="graph-approval" data-approval-id={String(row.id)}>
              <code title={summarizeApproval(row.request)}>{summarizeApproval(row.request)}</code><div className="graph-approval-actions">
                {sent.has(String(row.id)) ? <span role="status">{ja ? '回答済み' : 'Answer sent'}</span> : <>{(['allow', 'deny'] as const).map(action => <button key={action} className={`btn btn-xs ${action === 'allow' ? 'btn-primary' : 'btn-secondary'}`}
                  disabled={!connected || !getDecision(row, action)} onClick={() => void answer(row, action)}>{action === 'allow' ? ja ? '許可' : 'Allow' : ja ? '拒否' : 'Deny'}</button>)}</>}</div></div>)}
          </article>;
        })}
      </div>
      <p className="graph-hint">{ja ? 'ドラッグで移動 · ホイールで拡大縮小' : 'Drag to pan · Scroll to zoom'}</p>
      <div className="graph-controls" aria-label={ja ? 'グラフの表示' : 'Graph view controls'}><button onClick={fit} title={ja ? '全体を表示' : 'Fit to view'}>{ja ? '全体を表示' : 'Fit to view'}</button><span className="graph-scale numeric">{Math.round(view.scale * 100)}%</span>
        <button aria-label={ja ? '縮小' : 'Zoom out'} onClick={() => zoom(1 / 1.2)}>−</button><button aria-label={ja ? '拡大' : 'Zoom in'} onClick={() => zoom(1.2)}>+</button></div>
    </div>
  </>;
}
