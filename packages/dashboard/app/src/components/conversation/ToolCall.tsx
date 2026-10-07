import type { Row } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { Fields } from '../Fields.tsx';
import { Icon } from '../Icon.tsx';
import { readBody, readObject, readText } from './model.ts';
import { translate } from './text.ts';

const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt'];
export function summarizeInput(input: unknown): string {
  const value = readObject(input);
  for (const field of SUMMARY_FIELDS) {
    const entry = value[field];
    if (typeof entry === 'string' && entry) return entry.split('\n')[0]!;
    if (Array.isArray(entry)) return entry.map(String).join(' ');
  }
  return '';
}
function readOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  const block = readObject(value);
  return readBody(block.content ?? value);
}
/** 道具の呼び出しは折りたたんで出し、開くと入力と出力を見せる。 */
export function ToolCall({ name, input, result, language = 'en' }: { name: string; input?: unknown; result?: unknown; language?: Language }) {
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const summary = summarizeInput(input);
  const output = result === undefined ? undefined : readOutput(result);
  const failed = readObject(result).is_error === true;
  const command = readText(readObject(input).command);
  const rest = Object.fromEntries(Object.entries(readObject(input)).filter(([key]) => !(key === 'command' && command)));
  return <details className={`tool-call${failed ? ' failed' : ''}`}>
    <summary><Icon name="chevronRight" size={14} className="caret"/><Icon name={command ? 'terminal' : 'tool'} size={14}/>
      <span className="tool-name">{name}</span>{summary && <span className="tool-summary truncate">{summary}</span>}
      {failed && <span className="chip chip-danger">error</span>}</summary>
    <div className="tool-body">
      {input !== undefined && <section><h4>{t('toolInput')}</h4>{command && <pre className="command-block">{command}</pre>}
        {Object.keys(rest).length > 0 && <Fields value={rest}/>}</section>}
      {result !== undefined && <section><h4>{t('toolResult')}</h4>{output ? <pre className="code-block">{output}</pre> : <p className="muted-text">{t('noOutput')}</p>}</section>}
    </div>
  </details>;
}
/** 会話の中で呼び出しと組になる道具の結果を、呼び出しの ID で引けるようにする。 */
export function collectToolResults(rows: Row[]): Map<string, unknown> {
  const blocks = rows.flatMap(row => Array.isArray(row.body) ? row.body.map(readObject) : []);
  const calls = new Set(blocks.filter(block => block.type === 'tool_use' && typeof block.id === 'string').map(block => block.id));
  const results = new Map<string, unknown>();
  for (const block of blocks) if (block.type === 'tool_result' && calls.has(block.tool_use_id)) results.set(String(block.tool_use_id), block);
  return results;
}
