import { useState } from 'react';
import type { Language } from '../../lib/i18n.ts';
import type { Row } from '../../lib/store.ts';
import { Markdown } from './Markdown.tsx';
import { PREVIEW_LINES, readBody, readObject, readText, showValue } from './model.ts';
import { translate } from './text.ts';

export function Message({ row, language = 'en', streaming = false }: { row: Row; language?: Language; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const text = readBody(row.body);
  const lines = text.split('\n');
  const long = lines.length > PREVIEW_LINES;
  const tools = (Array.isArray(row.body) ? row.body : []).map(readObject)
    .filter(block => ['tool_use', 'tool_result'].includes(readText(block.type)));
  return <article className="conversation-message" id={`message-${row.id}`} aria-label={`${readText(row.role) || 'assistant'} ${row.id}`}>
    <header><strong>{readText(row.role) || 'assistant'}</strong>
      <time>{readText(row.source_ts) || t('timeUnknown')}</time>{streaming && <span>{t('streaming')}</span>}
    </header>
    <div className="conversation-provenance"><span>{t('source')}: {readText(row.source) || t('unknown')}</span>
      <span>{t('confidence')}: {readText(row.confidence) || t('unknown')}</span></div>
    {row.body_state === 'unavailable' || row.body_state === 'omitted'
      ? <p className="conversation-gap">{t(row.body_state === 'omitted' ? 'omitted' : 'unavailable')}</p>
      : <><Markdown text={long && !expanded ? lines.slice(0, PREVIEW_LINES).join('\n') : text}/>
        {long && <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'hide' : 'show')}</button>}</>}
    {tools.map((tool, index) => <details key={readText(tool.id) || index} className="conversation-tool">
      <summary>{readText(tool.name) || readText(tool.type)} {readText(tool.id ?? tool.tool_use_id)}</summary>
      <pre>{showValue(tool.input ?? tool.content)}</pre>
    </details>)}
    {row.tool_output !== undefined && row.tool_output !== null && <details className="conversation-tool"><summary>{t('toolOutput')}</summary><pre>{showValue(row.tool_output)}</pre></details>}
  </article>;
}
