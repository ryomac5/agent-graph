import { Link } from 'react-router';
import type { Language } from '../lib/i18n.ts';
import { isStoppedState, providerName } from './ActivityRow.tsx';
import { countActiveDelegations, countAllDelegations, type DelegationLine } from './overview.ts';

/** 「Codex gpt-6.1-sol · implement · running · 2 attempts」の形の 1 行の要約を作る。 */
export function summarizeDelegation(line: DelegationLine, language: Language = 'en'): string {
  const ja = language === 'ja';
  const node = line.node;
  const who = [node.provider && providerName(node.provider), node.model].filter(Boolean).join(' ') || (ja ? 'エージェント未記録' : 'Agent not recorded');
  const state = (node.state || 'unknown').replace(/_/g, ' ');
  const attempts = ja ? `試行 ${line.attempts} 回` : `${line.attempts} ${line.attempts === 1 ? 'attempt' : 'attempts'}`;
  return [who, node.role || (ja ? '委譲' : 'delegation'), state, attempts].join(' · ');
}

function Line({ line, language }: { line: DelegationLine; language: Language }) {
  const target = line.node.conversationId ? `/c/${encodeURIComponent(line.node.conversationId)}` : undefined;
  const summary = summarizeDelegation(line, language);
  return <li className={`delegation-line status-${line.state}${isStoppedState(line.state) && !line.active ? ' is-stopped' : ''}`}>
    <div className="delegation-line-row" aria-label={`${summary} · ${line.node.label}`}>
      <span className="state-dot" aria-hidden="true"/>
      {target ? <Link className="delegation-line-summary" to={target}>{summary}</Link> : <span className="delegation-line-summary">{summary}</span>}
      <span className="delegation-line-title" title={line.node.label}>{line.node.label}</span>
    </div>
    {line.children.length > 0 && <ul className="delegation-lines">{line.children.map(child => <Line key={child.id} line={child} language={language}/>)}</ul>}
  </li>;
}

/** 作業の下に委譲を木として畳んで出す。動いている委譲があれば開いて出す。 */
export function DelegationFold({ lines, language = 'en', label }: { lines: DelegationLine[]; language?: Language; label?: string }) {
  if (!lines.length) return null;
  const ja = language === 'ja';
  const total = countAllDelegations(lines);
  const active = countActiveDelegations(lines);
  const title = label ?? (ja ? '委譲' : total === 1 ? 'delegation' : 'delegations');
  return <details className="delegation-fold" open={active > 0}>
    <summary><span className="numeric">{total}</span> {title}{active > 0 && <span className="delegation-fold-active"> · <span className="numeric">{active}</span> {ja ? '進行中' : 'active'}</span>}</summary>
    <ul className="delegation-lines" aria-label={ja ? '委譲の木' : 'Delegations'}>{lines.map(line => <Line key={line.id} line={line} language={language}/>)}</ul>
  </details>;
}
