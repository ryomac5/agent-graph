import { Link } from 'react-router';
import { Icon } from '../../components/Icon.tsx';
import { ProviderMark } from '../../components/RootViews.tsx';
import { agentName } from '../../lib/format.ts';
import { graphText, type Language } from '../../lib/i18n.ts';
import { elapsed } from './GraphOutline.tsx';
import { roleWord, type GraphRow } from './rows.ts';
import type { ModelCatalog } from '../settings/ModelAssignments.tsx';
export function GraphDetail({ row, language, now, href, onClose, catalogs }: { row: GraphRow; language: Language; now: number; href: string; onClose: () => void; catalogs?: ModelCatalog }) {
  const t = graphText[language]; const node = row.node!;
  return <aside className="graph-detail" aria-label={t.request}>
    <header><span>{roleWord(row.role!, language)}</span><button className="btn-icon" aria-label={t.close} onClick={onClose}><Icon name="x"/></button></header>
    <p className="graph-detail-request">{node.label}</p>
    {node.report && <><div className="graph-detail-label">{t.report}</div><p>{node.report}</p></>}
    {row.role !== 'planner' && <div className="graph-detail-provider"><ProviderMark provider={node.provider}/>{agentName(node.provider, node.model, catalogs?.[node.provider]?.models)}</div>}
    <dl><dt>{t.elapsed}</dt><dd>{elapsed(row, now)}</dd><dt>{t.rounds}</dt><dd>{Math.max(1, node.attempts.length)}</dd></dl>
    {node.conversationId && <Link className="btn btn-ghost" to={href}>{t.open}<Icon name="external"/></Link>}
  </aside>;
}
