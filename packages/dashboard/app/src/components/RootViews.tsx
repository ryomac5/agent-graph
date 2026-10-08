import { useState } from 'react';
import { Link } from 'react-router';
import type { Root } from '../lib/roots.ts';
import { agentName, formatAgo, formatWhen, summarizeApproval } from '../lib/format.ts';
import type { Row } from '../lib/store.ts';
import { dictionaries, type Language } from '../lib/i18n.ts';
import type { DelegationTree, TreeNode } from '../pages/tree/model.ts';
import { StatusDot, stateLabel } from './StateBadge.tsx';
import { Icon } from './Icon.tsx';

/** 依頼先の印。頭文字は Claude と Codex で重なるので、色と形で分ける。 */
function ProviderMark({ provider }: { provider?: string }) {
  const name = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Agent';
  return <span className={`request-avatar provider-${provider || 'unknown'}`} title={name} aria-hidden="true">
    <Icon name={provider === 'codex' ? 'terminal' : provider === 'claude' ? 'sparkle' : 'bot'} size={13}/></span>;
}
import './roots.css';

const ACTIVE = ['running', 'starting', 'assigned', 'verifying', 'reviewing'];
const WAITING = ['waiting_approval', 'waiting_input'];
const RECENT_LIMIT = 20;
const EARLIER_MS = 24 * 60 * 60 * 1000;
function runningText(count: number, language: Language): string {
  const t = dictionaries[language];
  return language === 'ja' ? `${count} ${t.agentsRunning}` : `${count} ${count === 1 ? t.agentRunning : t.agentsRunning}`;
}

/** 根の会話の 1 行。1 行目に名前と時刻、2 行目に状態と動いているエージェントの数を出す。 */
export function RootList({ roots, selected, onSelect, project, language = 'en' }: { roots: Root[]; selected?: string; onSelect?: (root: Root) => void; project?: string; language?: Language }) {
  const t = dictionaries[language];
  const [showEarlier, setShowEarlier] = useState(false);
  // 動いている会話と、24 時間以内に動いた会話を先に出す。それより前の会話は Earlier に畳む。
  const newest = Math.max(...roots.map(root => Date.parse(root.last_activity_ts ?? '')).filter(Number.isFinite));
  const cutoff = Number.isFinite(newest) ? newest - EARLIER_MS : Number.NEGATIVE_INFINITY;
  const recent = (root: Root) => ACTIVE.includes(root.state) || WAITING.includes(root.state) || root.id === selected
    || !Number.isFinite(Date.parse(root.last_activity_ts ?? '')) || Date.parse(root.last_activity_ts ?? '') >= cutoff;
  const current = roots.filter(recent);
  const older = roots.filter(root => !recent(root));
  const row = (root: Root) => {
    const content = <><span className="root-row-line"><strong className="root-name" title={root.kit_name}>{root.name}</strong></span>
      <span className="root-row-meta"><StatusDot className="root-state" state={root.state} language={language}/>
        {root.running_children > 0 && <span className="root-running">{runningText(root.running_children, language)}</span>}
        {root.last_activity_ts && <time className="root-time" dateTime={root.last_activity_ts} title={new Date(root.last_activity_ts).toLocaleString()}>{formatWhen(root.last_activity_ts, language)}</time>}</span></>;
    return onSelect ? <button key={root.id} className="root-row activity-name" aria-pressed={selected === root.id} onClick={() => onSelect(root)}>{content}</button>
      : <Link key={root.id} className="root-row activity-name" to={`/p/${encodeURIComponent(project ?? root.project ?? 'other')}?root=${encodeURIComponent(root.id)}`}>{content}</Link>;
  };
  return <div className="root-list">{current.map(row)}
    {older.length > 0 && (showEarlier ? <>{<p className="root-earlier-label">{language === 'ja' ? '以前' : 'Earlier'}</p>}{older.map(row)}</>
      : <button className="btn btn-ghost btn-sm root-earlier" onClick={() => setShowEarlier(true)}>{language === 'ja' ? '以前の会話' : 'Earlier'} <span className="numeric">({older.length})</span></button>)}
    {!roots.length && <p className="empty-row">{t.noConversations}</p>}</div>;
}

function lastActivity(node: TreeNode): string {
  const run = node.run;
  return String(run?.last_evidence_ts ?? run?.ended_ts ?? run?.started_ts ?? '');
}

/** 依頼の流れ。根を頂点に置き、頼んだ内容を 1 行目、依頼先と状態と時刻を 2 行目に出す。子の子は字下げで続ける。 */
export function RootTree({ tree, selected, onSelect, runningOnly = false, language = 'en', root, onSelectRoot, onRetry, approvals = [], onAnswer }: {
  tree: DelegationTree; selected?: string; onSelect: (node: TreeNode) => void; runningOnly?: boolean; language?: Language;
  root?: { name: string; state: string; kit_name?: string }; onSelectRoot?: () => void; onRetry?: (node: TreeNode) => void;
  /** 承認待ちの行。子の行の中で、何を許すかを見せてその場で答えさせる。 */
  approvals?: Row[]; onAnswer?: (approval: Row, action: 'allow' | 'deny') => void;
}) {
  const t = dictionaries[language];
  const [showOlder, setShowOlder] = useState(false);
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  // 動いている子と待っている子を先に置き、それ以外は最後に動いた時刻の新しい順に並べる。
  const rank = (id: string) => { const node = byId.get(id); return node ? (ACTIVE.includes(node.state) ? 0 : WAITING.includes(node.state) ? 1 : 2) : 3; };
  const latest = (id: string): string => { const node = byId.get(id); return node ? [lastActivity(node), ...node.children.map(latest)].sort().at(-1) ?? '' : ''; };
  const order = (ids: string[]) => ids.toSorted((a, b) => rank(a) - rank(b) || latest(b).localeCompare(latest(a)));
  const descriptions = new Map(tree.edges.map(edge => [edge.target, edge]));
  function branch(id: string, ancestors = new Set<string>()): React.ReactNode {
    const node = byId.get(id);
    if (!node || ancestors.has(id)) return null;
    const next = new Set([...ancestors, id]);
    const children = order(node.children).map(child => branch(child, next));
    const shown = !runningOnly || ACTIVE.includes(node.state);
    if (!shown && !children.some(Boolean)) return null;
    const edge = descriptions.get(id);
    const who = agentName(node.provider, node.model) || t.agent;
    const title = edge?.title || [who, node.role].filter(Boolean).join(' · ');
    const when = formatAgo(lastActivity(node), language);
    const group = node.role === 'planner' && !node.conversationId;
    const isSelected = selected === id || Boolean(selected) && node.conversationId === selected;
    const retry = onRetry && node.delegation && String(node.delegation.state ?? node.state) === 'failed';
    return <li key={id}>{(shown || group && children.some(Boolean)) && (group
      ? <h3 className="request-group">{node.label}</h3>
      : <div className={`request-row${isSelected ? ' selected' : ''}`} onClick={event => { if (!(event.target as Element).closest('.request-retry, .request-main')) onSelect(node); }}>
        <ProviderMark provider={node.provider}/>
        <button className="request-main delegation-select" title={title} aria-label={[edge?.title, [who, node.role].filter(Boolean).join(' · '), stateLabel(node.state, language)].filter(Boolean).join(' · ')} aria-pressed={isSelected} onClick={() => onSelect(node)}>
          <span className="request-title">{title}</span>
          <span className="request-meta"><StatusDot state={node.state} language={language}/><span className="request-who">{[who, node.role].filter(Boolean).join(' · ')}</span>{when && <span className="request-when">{when}</span>}</span>
        </button>
        {retry && <button className="btn btn-ghost btn-xs request-retry" onClick={event => { event.stopPropagation(); onRetry(node); }}>{t.retry}</button>}
      </div>)}{(() => {
        const pending = approvals.find(row => (node.conversationId && row.conversation_id === node.conversationId) || (node.run && row.run_id === node.run.id));
        return pending && onAnswer && <div className="request-approval" onClick={event => event.stopPropagation()}>
          <code className="request-approval-command" title={summarizeApproval(pending.request)}>{summarizeApproval(pending.request)}</code>
          <span className="button-row"><button className="btn btn-primary btn-xs" onClick={() => onAnswer(pending, 'allow')}>Allow</button>
            <button className="btn btn-ghost btn-xs" onClick={() => onAnswer(pending, 'deny')}>Deny</button></span>
        </div>;
      })()}{children.some(Boolean) && <ul>{children}</ul>}</li>;
  }
  const children = order(tree.nodes.find(node => node.id === tree.roots[0])?.children ?? []);
  const rendered = children.map(id => ({ id, item: branch(id) })).filter(entry => entry.item);
  // 動いていない子が多いときは、新しい 20 件だけを出し、残りは Show older で畳む。
  // 動いておらず、24 時間より前に止まった子は、今の作業ではない。Earlier に畳む。
  // 区切りは、子の中で最後に動いた時刻から 24 時間前とする。しばらく動いていなくても、直前の作業は畳まない。
  const newest = Math.max(...rendered.map(entry => Date.parse(latest(entry.id))).filter(Number.isFinite));
  const cutoff = Number.isFinite(newest) ? newest - EARLIER_MS : Number.NEGATIVE_INFINITY;
  const resting = rendered.filter(entry => rank(entry.id) === 2);
  const earlier = resting.filter(entry => { const time = Date.parse(latest(entry.id)); return Number.isFinite(time) && time < cutoff; });
  const overflow = resting.filter(entry => !earlier.includes(entry)).slice(RECENT_LIMIT);
  const hidden = !showOlder && !runningOnly ? new Set([...earlier, ...overflow].map(entry => entry.id)) : new Set<string>();
  const items = rendered.filter(entry => !hidden.has(entry.id)).map(entry => entry.item);
  const more = hidden.size > 0 && <li key="older"><button className="btn btn-ghost btn-sm request-older" onClick={() => setShowOlder(true)}>{t.showOlder} <span className="numeric">({hidden.size})</span></button></li>;
  const empty = !items.some(Boolean);
  if (root) return <div className="root-tree request-flow"><ul><li>
    <div className={`request-row request-apex${selected ? '' : ' selected'}`}><ProviderMark provider="claude"/><button className="request-main" aria-pressed={!selected} onClick={onSelectRoot}>
      <span className="request-title" title={root.kit_name}>{root.name}</span><span className="request-meta"><StatusDot state={root.state} language={language}/></span></button></div>
    {!empty && <ul>{items}{more}</ul>}</li></ul>{empty && <p className="empty-row">{t.noRequests}</p>}</div>;
  return <div className="root-tree"><ul>{items}{more}</ul>{empty && !runningOnly && <p className="empty-row">{t.noRequests}</p>}</div>;
}
