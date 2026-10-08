import { useState } from 'react';
import { Link } from 'react-router';
import { shownRole, type Root } from '../lib/roots.ts';
import { agentName, formatWhen, summarizeApproval } from '../lib/format.ts';
import type { Row } from '../lib/store.ts';
import { dictionaries, type Language } from '../lib/i18n.ts';
import type { DelegationTree, TreeNode } from '../pages/tree/model.ts';
import { StatusDot, stateLabel } from './StateBadge.tsx';
import { Icon } from './Icon.tsx';

/** 依頼先の印。頭文字は Claude と Codex で重なるので、色と形で分ける。 */
export function ProviderMark({ provider }: { provider?: string }) {
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
      <span className="root-row-meta">{[...ACTIVE, ...WAITING, 'failed', 'denied', 'ended', 'done'].includes(root.state) && <StatusDot className="root-state" state={root.state} language={language}/>}
        {root.running_children > 0 && <span className="root-running">{runningText(root.running_children, language)}</span>}
        {root.last_activity_ts && <time className="root-time" dateTime={root.last_activity_ts} title={formatWhen(root.last_activity_ts, language)}>{formatWhen(root.last_activity_ts, language)}</time>}</span></>;
    return onSelect ? <button key={root.id} className="root-row activity-name" aria-pressed={selected === root.id} onClick={() => onSelect(root)}>{content}</button>
      : <Link key={root.id} className="root-row activity-name" to={`/p/${encodeURIComponent(project ?? root.project ?? 'other')}?root=${encodeURIComponent(root.id)}`}>{content}</Link>;
  };
  return <div className="root-list">{current.map(row)}
    {older.length > 0 && (showEarlier ? <>{<p className="root-earlier-label">{language === 'ja' ? '以前' : 'Earlier'}</p>}{older.map(row)}</>
      : <button className="btn btn-ghost btn-sm root-earlier" onClick={() => setShowEarlier(true)}>{language === 'ja' ? '以前の会話' : 'Earlier'} <span className="numeric">({older.length})</span></button>)}
    {!roots.length && <p className="empty-row">{t.noConversations}</p>}</div>;
}

export function lastActivity(node: TreeNode): string {
  const run = node.run;
  return String(run?.ended_ts ?? run?.last_evidence_ts ?? run?.started_ts ?? node.delegation?.updated_ts ?? node.delegation?.completed_ts ?? node.delegation?.created_ts ?? '');
}

/** 依頼の流れ。根を頂点に置き、頼んだ内容を 1 行目、依頼先と状態と時刻を 2 行目に出す。子の子は字下げで続ける。 */
export function RootTree({ tree, selected, onSelect, runningOnly = false, language = 'en', root, onSelectRoot, approvals = [], onAnswer }: {
  tree: DelegationTree; selected?: string; onSelect: (node: TreeNode) => void; runningOnly?: boolean; language?: Language;
  root?: { name: string; state: string; kit_name?: string; last_activity_ts?: string | null }; onSelectRoot?: () => void; onRetry?: (node: TreeNode) => void;
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
  function isEarlier(id: string, ancestors = new Set<string>()): boolean {
    const node = byId.get(id);
    if (!node || ancestors.has(id)) return false;
    const next = new Set([...ancestors, id]);
    if (ACTIVE.includes(node.state) || WAITING.includes(node.state)) return false;
    const time = Date.parse(lastActivity(node));
    const childrenOld = node.children.every(child => isEarlier(child, next));
    return childrenOld && (node.role === 'planner' && !node.conversationId ? node.children.length > 0 : Number.isFinite(time) && time < Date.now() - EARLIER_MS);
  }
  const descriptions = new Map(tree.edges.map(edge => [edge.target, edge]));
  function branch(id: string, ancestors = new Set<string>()): React.ReactNode {
    const node = byId.get(id);
    if (!node || ancestors.has(id)) return null;
    const next = new Set([...ancestors, id]);
    const childIds = order(node.children);
    const old = childIds.filter(child => isEarlier(child));
    const children = childIds.filter(child => showOlder || !old.includes(child)).map(child => branch(child, next));
    if (old.length && !showOlder && !runningOnly) children.push(<li key="earlier"><button className="btn btn-ghost btn-sm request-older" onClick={() => setShowOlder(true)}>{t.showOlder} <span className="numeric">{old.length}</span></button></li>);
    const shown = !runningOnly || ACTIVE.includes(node.state);
    if (!shown && !children.some(Boolean)) return null;
    const edge = descriptions.get(id);
    const who = agentName(node.provider, node.model) || t.agent;
    const title = edge?.title || [who, shownRole(node.role)].filter(Boolean).join(' · ');
    const activity = lastActivity(node) || latest(id);
    const when = formatWhen(activity, language) || (language === 'ja' ? '時刻不明' : 'Unknown time');
    const group = node.role === 'planner' && !node.conversationId;
    const isSelected = selected === id || Boolean(selected) && node.conversationId === selected;

    return <li key={id}>{(shown || group && children.some(Boolean)) && (group
      ? <h3 className="request-group"><span>{node.label}</span><time dateTime={activity || undefined}>{when}</time></h3>
      : <div className={`request-row${isSelected ? ' selected' : ''}`} onClick={event => { if (!(event.target as Element).closest('.request-main')) onSelect(node); }}>
        <ProviderMark provider={node.provider}/>
        <button className="request-main delegation-select" title={title} aria-label={[edge?.title, [who, shownRole(node.role)].filter(Boolean).join(' · '), stateLabel(node.state, language)].filter(Boolean).join(' · ')} aria-pressed={isSelected} onClick={() => onSelect(node)}>
          <span className="request-title">{title}</span>
          <span className="request-meta"><StatusDot state={node.state} language={language}/><span className="request-who">{[who, shownRole(node.role)].filter(Boolean).join(' · ')}</span>{when && <time className="request-when" dateTime={activity || undefined}>{when}</time>}</span>
        </button>
      </div>)}{(() => {
        const pending = approvals.find(row => (node.conversationId && row.conversation_id === node.conversationId) || (node.run && row.run_id === node.run.id));
        return pending && onAnswer && <div className="request-approval" onClick={event => event.stopPropagation()}>
          <code className="request-approval-command" title={summarizeApproval(pending.request)}>{summarizeApproval(pending.request)}</code>
          <span className="button-row"><button className="btn btn-primary btn-xs" onClick={() => onAnswer(pending, 'allow')}>{language === 'ja' ? '許可' : 'Allow'}</button>
            <button className="btn btn-ghost btn-xs" onClick={() => onAnswer(pending, 'deny')}>{language === 'ja' ? '拒否' : 'Deny'}</button></span>
        </div>;
      })()}{children.some(Boolean) && <ul>{children}</ul>}</li>;
  }
  const children = order(tree.nodes.find(node => node.id === tree.roots[0])?.children ?? []);
  const rendered = children.map(id => ({ id, item: branch(id) })).filter(entry => entry.item);
  // 終了から 24 時間を過ぎた依頼と、新しい 20 件を超えた依頼を畳む。
  const resting = rendered.filter(entry => rank(entry.id) === 2);
  const earlier = resting.filter(entry => isEarlier(entry.id));
  const overflow = resting.filter(entry => !earlier.includes(entry)).slice(RECENT_LIMIT);
  const hidden = !showOlder && !runningOnly ? new Set([...earlier, ...overflow].map(entry => entry.id)) : new Set<string>();
  const items = rendered.filter(entry => !hidden.has(entry.id)).map(entry => entry.item);
  const more = hidden.size > 0 && <li key="older"><button className="btn btn-ghost btn-sm request-older" onClick={() => setShowOlder(true)}>{t.showOlder} <span className="numeric">({hidden.size})</span></button></li>;
  const empty = !items.some(Boolean) && !more;
  if (root) return <div className="root-tree request-flow"><ul><li>
    <div className={`request-row request-apex${selected ? '' : ' selected'}`}><ProviderMark provider="claude"/><button className="request-main" aria-pressed={!selected} onClick={onSelectRoot}>
      <span className="request-title" title={root.kit_name}>{root.name}</span><span className="request-meta"><StatusDot state={root.state} language={language}/><time dateTime={root.last_activity_ts ?? undefined}>{formatWhen(root.last_activity_ts, language) || (language === 'ja' ? '時刻不明' : 'Unknown time')}</time></span></button></div>
    {(!empty || more) && <ul>{items}{more}</ul>}</li></ul>{empty && <p className="empty-row">{t.noRequests}</p>}</div>;
  return <div className="root-tree"><ul>{items}{more}</ul>{empty && !runningOnly && <p className="empty-row">{t.noRequests}</p>}</div>;
}
