import { useState } from 'react';
import type { Language } from '../../lib/i18n.ts';
import type { Row } from '../../lib/store.ts';
import { formatClock } from '../../lib/format.ts';
import { Icon } from '../Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { PREVIEW_LINES, readBody, readObject, readText } from './model.ts';
import { translate } from './text.ts';
import { ToolCall } from './ToolCall.tsx';

const SOURCE_LABELS: Record<string, string> = {
  'host-claude': 'Claude host', 'host-codex': 'Codex host', ui: 'Console', hook: 'Hook', intake: 'Intake',
  'transcript-claude': 'Claude transcript', 'rollout-codex': 'Codex rollout',
};
export function sourceLabel(source: string): string { return SOURCE_LABELS[source] ?? source; }

export function Message({ row, language = 'en', streaming = false, agent, toolResults }: {
  row: Row; language?: Language; streaming?: boolean; agent?: string; toolResults?: Map<string, unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const blocks = (Array.isArray(row.body) ? row.body : []).map(readObject);
  const text = Array.isArray(row.body) ? blocks.filter(block => !['tool_use', 'tool_result', 'thinking'].includes(readText(block.type))).map(readBody).filter(Boolean).join('\n') : readBody(row.body);
  const lines = text.split('\n');
  const long = lines.length > PREVIEW_LINES;
  const tools = blocks.filter(block => block.type === 'tool_use');
  // 呼び出しと組になった結果は、呼び出しの中で見せる。
  const paired = (block: Row) => block.type === 'tool_result' && typeof block.tool_use_id === 'string' && Boolean(toolResults?.has(block.tool_use_id));
  const orphanResults = blocks.filter(block => block.type === 'tool_result' && !paired(block));
  const role = readText(row.role) || 'assistant';
  const user = role === 'user';
  const name = user ? t('user') : role === 'assistant' ? agent || t('assistant') : role;
  const time = readText(row.source_ts);
  const source = readText(row.source);
  const confidence = readText(row.confidence);
  const unavailable = row.body_state === 'unavailable' || row.body_state === 'omitted';
  if (!unavailable && !text && !tools.length && blocks.length > 0 && blocks.every(paired)) return null;
  return <article className={`message ${user ? 'message-user' : 'message-agent'}${streaming ? ' streaming' : ''}`} id={`message-${encodeURIComponent(String(row.id))}`} aria-label={`${name} message`}>
    <div className="message-avatar" aria-hidden="true"><Icon name={user ? 'user' : 'sparkle'} size={14}/></div>
    <div className="message-main">
      <header className="message-header"><strong>{name}</strong>
        {time ? <time dateTime={time} title={time}>{formatClock(time)}</time> : !streaming && <span className="muted-text">{t('timeUnknown')}</span>}
        {streaming && <span className="chip chip-accent"><span className="pulse" aria-hidden="true"/>{t('streaming')}</span>}
        {!streaming && (source || confidence) && <span className="provenance" title={`${t('source')}: ${source || t('unknown')} · ${t('confidence')}: ${confidence || t('unknown')}`}>
          <span>{sourceLabel(source) || t('unknown')}</span><span className={`confidence confidence-${confidence || 'unknown'}`}>{confidence || t('unknown')}</span></span>}
      </header>
      {unavailable ? <p className="message-gap">{t(row.body_state === 'omitted' ? 'omitted' : 'unavailable')}</p>
        : <>{text && <Markdown text={long && !expanded ? lines.slice(0, PREVIEW_LINES).join('\n') : text}/>}
          {long && <button className="btn btn-link btn-sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'hide' : 'show')}</button>}</>}
      {tools.length > 0 && <div className="tool-calls">{tools.map((tool, index) => <ToolCall key={readText(tool.id) || index} language={language}
        name={readText(tool.name) || 'Tool'} input={tool.input} result={typeof tool.id === 'string' ? toolResults?.get(tool.id) : undefined}/>)}</div>}
      {orphanResults.map((block, index) =>
        <ToolCall key={`result-${index}`} language={language} name={t('toolOutput')} result={block}/>)}
      {row.tool_output !== undefined && row.tool_output !== null && <ToolCall language={language} name={t('toolOutput')} result={row.tool_output}/>}
    </div>
  </article>;
}
