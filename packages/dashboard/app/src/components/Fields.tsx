import type { ReactNode } from 'react';

// 物の値を、JSON の文字列ではなく見出しと値の組で出す。
function humanize(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, letter => letter.toUpperCase());
}
function renderValue(value: unknown, depth: number): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="muted-text">—</span>;
  if (typeof value === 'string') return value.includes('\n') ? <pre className="code-block">{value}</pre> : <span className="field-text">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean') return <span className="field-text mono">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.every(item => item === null || typeof item !== 'object')) return <span className="field-text">{value.map(String).join(', ')}</span>;
    return <ol className="field-list">{value.map((item, index) => <li key={index}>{renderValue(item, depth + 1)}</li>)}</ol>;
  }
  if (depth > 2) return <span className="muted-text">{Object.keys(value).length} fields</span>;
  return <Fields value={value as Record<string, unknown>} depth={depth + 1}/>;
}
export function Fields({ value, depth = 0, empty = 'No details' }: { value: unknown; depth?: number; empty?: string }) {
  if (typeof value === 'string') return <span className="field-text">{value}</span>;
  const entries = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).filter(([, entry]) => entry !== undefined) : [];
  if (!entries.length) return <span className="muted-text">{empty}</span>;
  return <dl className={depth ? 'fields nested' : 'fields'}>{entries.map(([key, entry]) => <div key={key}><dt>{humanize(key)}</dt><dd>{renderValue(entry, depth)}</dd></div>)}</dl>;
}
