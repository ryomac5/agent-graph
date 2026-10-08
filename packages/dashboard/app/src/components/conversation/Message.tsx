import { useState } from 'react';
import type { Language } from '../../lib/i18n.ts';
import type { Row } from '../../lib/store.ts';
import { formatClock } from '../../lib/format.ts';
import { Markdown } from './Markdown.tsx';
import { PREVIEW_LINES, readBody, readObject, readText } from './model.ts';
import { visibleText } from '../../lib/message-body.ts';
import type { Sender } from './participants.ts';
import { translate } from './text.ts';
import { ToolCall } from './ToolCall.tsx';

const SOURCE_LABELS: Record<string, string> = {
  'host-claude': 'Claude host', 'host-codex': 'Codex host', ui: 'Console', hook: 'Hook', intake: 'Intake',
  'transcript-claude': 'Claude transcript', 'rollout-codex': 'Codex rollout',
};
export function sourceLabel(source: string): string { return SOURCE_LABELS[source] ?? source; }

/**
 * 発言を 1 つ描く。右の列は塗りの吹き出し、左の列は塗りなしの広い本文にする。
 * 送り主の名前は、続く同じ送り主の発言では省く。時刻は常に出す。
 */
export function Message({ row, sender, showName = true, language = 'en', streaming = false, toolResults }: {
  row: Row; sender: Sender; showName?: boolean; language?: Language; streaming?: boolean; toolResults?: Map<string, unknown>;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const blocks = (Array.isArray(row.body) ? row.body : []).map(readObject);
  const text = visibleText(Array.isArray(row.body) ? blocks.filter(block => !['tool_use', 'tool_result', 'thinking'].includes(readText(block.type))).map(readBody).filter(Boolean).join('\n') : readBody(row.body));
  const lines = text.split('\n');
  const long = lines.length > PREVIEW_LINES;
  const tools = blocks.filter(block => block.type === 'tool_use');
  // 呼び出しと組になった結果は、呼び出しの中で見せる。
  const paired = (block: Row) => block.type === 'tool_result' && typeof block.tool_use_id === 'string' && Boolean(toolResults?.has(block.tool_use_id));
  const orphanResults = blocks.filter(block => block.type === 'tool_result' && !paired(block));
  const end = sender.side === 'end';
  const time = readText(row.source_ts);
  const source = readText(row.source);
  const confidence = readText(row.confidence);
  const unavailable = row.body_state === 'unavailable' || row.body_state === 'omitted';
  if (!unavailable && !text && !tools.length && blocks.length > 0 && blocks.every(paired)) return null;
  // 本文のない利用者の行は、hook が差し込んだ行か道具の結果だけの行である。吹き出しを出さない。
  if (!unavailable && !streaming && !text && !tools.length && end && row.tool_output == null) return null;
  const toolOutput = row.tool_output !== undefined && row.tool_output !== null;
  const hasTools = tools.length > 0 || orphanResults.length > 0 || toolOutput;
  return <article className={`message ${end ? 'message-user' : 'message-agent'}${showName ? ' message-first' : ''}${streaming ? ' streaming' : ''}`}
    id={`message-${encodeURIComponent(String(row.id))}`} aria-label={`${sender.name} message`} data-side={sender.side}>
    <header className="message-header">
      {showName && <strong className="message-sender">{sender.name}</strong>}
      {time ? <time dateTime={time} title={time}>{formatClock(time)}</time> : !streaming && <span className="message-time-unknown">{t('timeUnknown')}</span>}
      {streaming && <span className="chip chip-accent"><span className="pulse" aria-hidden="true"/>{t('streaming')}</span>}
    </header>
    <div className="message-main">
      {unavailable ? <p className="message-gap">{t(row.body_state === 'omitted' ? 'omitted' : 'unavailable')}</p>
        : text && <div className="message-bubble">
          <Markdown text={long && !expanded ? lines.slice(0, PREVIEW_LINES).join('\n') : text}/>
          {long && <button className="btn btn-link btn-sm message-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'hide' : 'show')}</button>}
        </div>}
      {hasTools && <div className="tool-calls">
        {tools.map((tool, index) => <ToolCall key={readText(tool.id) || index} language={language}
          name={readText(tool.name) || 'Tool'} input={tool.input} result={typeof tool.id === 'string' ? toolResults?.get(tool.id) : undefined}/>)}
        {orphanResults.map((block, index) => <ToolCall key={`result-${index}`} language={language} name={t('toolOutput')} result={block}/>)}
        {toolOutput && <ToolCall language={language} name={t('toolOutput')} result={row.tool_output}/>}
      </div>}
    </div>
  </article>;
}
