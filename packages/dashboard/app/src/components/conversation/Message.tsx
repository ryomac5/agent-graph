import { describeTool } from './tool-activity.ts';
import { memo, useState } from 'react';
import type { Language } from '../../lib/i18n.ts';
import type { Row } from '../../lib/store.ts';
import { formatClock } from '../../lib/format.ts';
import { Markdown } from './Markdown.tsx';
import { PREVIEW_LINES, readMessageBody, readBody, readObject, readText } from './model.ts';
import { agentReportText, visibleText } from '../../lib/message-body.ts';
import type { Sender } from './participants.ts';
import { Icon } from '../Icon.tsx';
import { toolsLabel, translate } from './text.ts';
import { DelegationCard, isDelegationTool, sameDelegationNodes, type DelegationNodes } from './DelegationCard.tsx';
import { ToolCall } from './ToolCall.tsx';

const SOURCE_LABELS: Record<string, string> = {
  'host-claude': 'Claude host', 'host-codex': 'Codex host', ui: 'Console', hook: 'Hook', intake: 'Intake',
  'transcript-claude': 'Claude transcript', 'rollout-codex': 'Codex rollout',
};
export function sourceLabel(source: string): string { return SOURCE_LABELS[source] ?? source; }

const contents = new WeakMap<Row, { blocks: Row[]; text: string }>();
function readContent(row: Row) {
  const cached = contents.get(row);
  if (cached) return cached;
  const blocks = Array.isArray(row.body) ? row.body.map(readObject) : [];
  const text = visibleText(Array.isArray(row.body) ? blocks.filter(block => !['tool_use', 'tool_result', 'thinking'].includes(readText(block.type))).map(readBody).filter(Boolean).join('\n') : readMessageBody(row), Boolean(row.content_normalized));
  const value = { blocks, text };
  contents.set(row, value);
  return value;
}
/** 本文がなく、道具の呼び出しか結果だけの発言。会話の中では、続くものをまとめて 1 行に畳む。 */
export function isToolOnly(row: Row): boolean {
  if (!Array.isArray(row.body)) return false;
  const { blocks, text } = readContent(row);
  return !text && blocks.some(block => block.type === 'tool_use' || block.type === 'tool_result');
}
/** 画面に何も出さない発言。思考だけの行や、本文のない行である。道具の畳みを切らない。 */
export function isBlank(row: Row): boolean {
  const { blocks, text } = readContent(row);
  return !text && !blocks.some(block => block.type === 'tool_use' || block.type === 'tool_result') && row.body_state !== 'unavailable' && row.body_state !== 'omitted';
}
/** 畳んだ道具の呼び出しの数。結果だけの行は数えない。 */
export function countTools(rows: Row[]): number {
  return rows.reduce((total, row) => total + (Array.isArray(row.body) ? row.body.map(readObject).filter(block => block.type === 'tool_use').length : 0), 0);
}
/**
 * 発言を 1 つ描く。右の列は利用者の吹き出し、左の列はエージェントの吹き出しにする。
 * 送り主の名前は、続く同じ送り主の発言では省く。時刻は常に出す。
 */
function RenderMessage({ row, sender, showName = true, language = 'en', streaming = false, parentRequest = false, toolResults, delegationNodes, onSelectChild }: {
  row: Row; sender: Sender; showName?: boolean; language?: Language; streaming?: boolean; parentRequest?: boolean; toolResults?: Map<string, unknown>; delegationNodes?: DelegationNodes; onSelectChild?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  // 裏の作業の通知は会話の中に出さない。子の報告は、エージェントの側に畳んだ報告として出す。
  if (sender.key === 'notification') return null;
  if (sender.key === 'agent_report') {
    const report = row.content_normalized ? readMessageBody(row) : agentReportText(readMessageBody(row));
    const time = readText(row.source_ts);
    return <details className="message message-report" id={`message-${encodeURIComponent(String(row.id))}`} aria-label={t('agentReport')}>
      <summary><strong className="message-sender">{t('agentReport')}</strong>
        <span className="message-report-lead">{(report.split('\n').find(line => line.trim()) ?? '').trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')}</span>
        {time && <time dateTime={time} title={time}>{formatClock(time, language)}</time>}</summary>
      <div className="message-bubble"><Markdown text={report}/></div>
    </details>;
  }
  const { blocks, text: rawText } = readContent(row);
  const text = blocks.some(block => block.type === 'image') ? rawText.replace(/\[Image #\d+\]\s*/g, '').trim() : rawText;
  const lines = text.split('\n');
  const long = lines.length > PREVIEW_LINES;
  const tools = blocks.filter(block => block.type === 'tool_use');
  // 添付の画像は、記録の base64 から縮小で描く。本文の「[Image #1]」の印は、画像を描くので消す。
  const images = blocks.filter(block => block.type === 'image').map(block => readObject(block.source))
    .filter(source => source.type === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(readText(source.media_type)) && typeof source.data === 'string')
    .map(source => `data:${readText(source.media_type)};base64,${readText(source.data)}`);
  const hasDelegations = tools.some(isDelegationTool);
  const flow: { text?: string; tool?: Row }[] = [];
  if (hasDelegations) for (const block of blocks) {
    if (block.type === 'tool_use') flow.push({ tool: block });
    else if (!['thinking', 'tool_result'].includes(readText(block.type))) {
      const last = flow.at(-1);
      const part = readBody(block);
      if (last?.text !== undefined) last.text += `\n${part}`;
      else flow.push({ text: part });
    }
  }
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
  if (!unavailable && !streaming && !text && !tools.length && !images.length && end && row.tool_output == null) return null;
  const toolOutput = row.tool_output !== undefined && row.tool_output !== null;
  const hasTools = (!hasDelegations && tools.length > 0) || orphanResults.length > 0 || toolOutput;
  const renderTool = (tool: Row, index: number) => isDelegationTool(tool)
    ? <DelegationCard key={readText(tool.id) || index} tool={tool} node={delegationNodes?.get(tools.indexOf(tool))} language={language} onSelect={onSelectChild}/>
    : <ToolCall key={readText(tool.id) || index} language={language} name={readText(tool.name) || 'Tool'} input={tool.input}
      result={typeof tool.id === 'string' ? toolResults?.get(tool.id) : undefined}/>;
  return <article className={`message ${end ? 'message-user' : 'message-agent'}${showName ? ' message-first' : ''}${streaming ? ' streaming' : ''}`}
    id={`message-${encodeURIComponent(String(row.id))}`} aria-label={`${sender.name} message`} data-side={sender.side}>
    <header className="message-header">
      {showName && <strong className={end ? 'message-requester' : 'message-sender'}>{sender.name}</strong>}
      {time ? <time dateTime={time} title={time}>{formatClock(time, language)}</time> : !streaming && <span className="message-time-unknown">{t('timeUnknown')}</span>}
      {streaming && <span className="chip chip-accent"><span className="pulse" aria-hidden="true"/>{t('streaming')}</span>}
    </header>
    {parentRequest && <span className="message-request-label">{language === 'ja' ? '受けた依頼' : 'Request from root'}</span>}
    <div className="message-main">
      {row.delivery_state === 'sending' && <p className="status-line" role="status">Sending…</p>}
      {row.delivery_state === 'queued' && <p className="status-line" role="status">Queued — Claude will read this after the current step</p>}
      {images.length > 0 && <div className="message-images">{images.map((src, index) => <img key={index} src={src} alt={`${t('image')} ${index + 1}`} loading="lazy"/>)}</div>}
      {unavailable ? <p className="message-gap">{t(row.body_state === 'omitted' ? 'omitted' : 'unavailable')}</p>
        : hasDelegations ? flow.map((part, index) => {
          if (part.tool) return renderTool(part.tool, index);
          const content = visibleText(part.text ?? '', Boolean(row.content_normalized));
          const lines = content.split('\n');
          return content ? <div className="message-bubble" key={`text-${index}`}>
            <Markdown text={lines.length > PREVIEW_LINES && !expanded ? lines.slice(0, PREVIEW_LINES).join('\n') : content}/>
            {lines.length > PREVIEW_LINES && <button className="btn btn-link btn-sm message-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'hide' : 'show')}</button>}
          </div> : null;
        }) : text && <div className="message-bubble">
          <Markdown text={long && !expanded ? lines.slice(0, PREVIEW_LINES).join('\n') : text}/>
          {long && <button className="btn btn-link btn-sm message-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'hide' : 'show')}</button>}
        </div>}
      {hasTools && <div className="tool-calls">
        {!hasDelegations && tools.map(renderTool)}
        {orphanResults.map((block, index) => <ToolCall key={`result-${index}`} language={language} name={t('toolOutput')} result={block}/>)}
        {toolOutput && <ToolCall language={language} name={t('toolOutput')} result={row.tool_output}/>}
      </div>}
    </div>
  </article>;
}

/** 返答全体の呼び出しを 1 行に畳み、名前と失敗数を添える。 */
function RenderToolRun({ rows, toolResults, language = 'en' }: { rows: Row[]; toolResults?: Map<string, unknown>; language?: Language }) {
  const [open, setOpen] = useState(false);
  const tools = rows.flatMap(row => Array.isArray(row.body) ? row.body.map(readObject).filter(block => block.type === 'tool_use') : []);
  const names = [...new Set(tools.map(tool => readText(tool.name) || 'Tool'))].slice(0, 3);
  const description = describeTool(tools.at(-1));
  const failed = tools.filter(tool => readObject(toolResults?.get(readText(tool.id))).is_error === true).length;
  return <details className="tool-run" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }}><Icon name="chevronRight" size={16} className="caret"/><span>{toolsLabel(tools.length, language)}</span>
      {failed > 0 && <span className="tool-failed">{language === 'ja' ? '失敗' : 'Failed'} {failed}</span>}
      {names.length > 0 && <span className="truncate tool-run-names">· {names.join(' · ')}</span>}{description && <span className="truncate tool-run-description" title={description}>· {description}</span>}</summary>
    {open && <div className="tool-run-body">{rows.flatMap(row => Array.isArray(row.body) ? row.body.map(readObject) : []).map((block, index) => <ToolCall key={readText(block.id) || index} language={language} name={readText(block.name) || translate(language, 'toolOutput')} input={block.input} result={block.type === 'tool_result' ? block : toolResults?.get(readText(block.id))}/>)}</div>}
  </details>;
}

// 値が変わらない発言は、時計や別の会話の更新から切り離す。
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Row;
  const right = b as Row;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}
function sameResults(rows: Row[], a?: Map<string, unknown>, b?: Map<string, unknown>): boolean {
  if (a === b) return true;
  return rows.every(row => !Array.isArray(row.body) || row.body.every(value => {
    const block = readObject(value);
    const id = readText(block.id ?? block.tool_use_id);
    return !id || sameValue(a?.get(id), b?.get(id));
  }));
}
export const Message = memo(RenderMessage, (a, b) => {
  if (!sameValue(a.row, b.row) || !sameValue(a.sender, b.sender) || a.showName !== b.showName
    || a.language !== b.language || a.streaming !== b.streaming || a.parentRequest !== b.parentRequest
    || a.onSelectChild !== b.onSelectChild || !sameResults([b.row], a.toolResults, b.toolResults)) return false;
  return sameDelegationNodes(a.delegationNodes, b.delegationNodes);
});
export const ToolRun = memo(RenderToolRun, (a, b) => a.language === b.language
  && a.rows.length === b.rows.length && a.rows.every((row, index) => sameValue(row, b.rows[index]))
  && sameResults(b.rows, a.toolResults, b.toolResults));
