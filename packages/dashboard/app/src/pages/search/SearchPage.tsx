import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { Language } from '../../lib/i18n.ts';
import { SEARCH_KINDS, getResultHref, type SearchClient, type SearchKind, type SearchQuery, type SearchResponse } from './model.ts';
import './search.css';

const TEXT = {
  en: { title: 'Search', query: 'Search all conversations', project: 'Project', provider: 'Provider', from: 'From', to: 'To', kind: 'Kind', all: 'All',
    message: 'Messages', tool_output: 'Tool output', diff: 'Diffs', finding: 'Findings', task: 'Task names', alias: 'Aliases',
    loading: 'Searching…', empty: 'No results', conversation: 'Conversation', run: 'Run', unknown: 'Unknown', confidence: 'Confidence',
    retention: 'Body removed by retention policy.', missing: 'Body unavailable or outside the storage scope.',
    unsupported: 'Unsupported history formats cannot be searched.', fallback: 'Substring search (FTS5 unavailable)', more: 'Load more', failed: 'Search unavailable' },
  ja: { title: '検索', query: '会話を横断検索', project: 'プロジェクト', provider: 'プロバイダー', from: '開始日時', to: '終了日時', kind: '種別', all: 'すべて',
    message: '発言', tool_output: '道具の出力', diff: '差分', finding: '指摘', task: '作業の名前', alias: '別名',
    loading: '検索中…', empty: '結果なし', conversation: '会話', run: '実行', unknown: '不明', confidence: '確度',
    retention: '保持期間により本文が削除されました。', missing: '本文は保存範囲外、または取得できません。',
    unsupported: '形式未対応の会話は検索できません。', fallback: '部分一致検索（FTS5 が利用できません）', more: 'さらに表示', failed: '検索できません' },
};
export function SearchPage({ client, language = 'en' }: { client: SearchClient; language?: Language }) {
  const t = TEXT[language];
  const [query, setQuery] = useState<SearchQuery>({ query: '' });
  const [result, setResult] = useState<SearchResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const submitted = useRef<SearchQuery>({ query: '' });
  const revision = useRef(0);
  useEffect(() => () => { controller.current?.abort(); revision.current++; }, []);
  async function search(next: SearchQuery, append = false) {
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const version = ++revision.current;
    setLoading(true); setError('');
    if (!append) setResult(undefined);
    submitted.current = next;
    try {
      const response = await client.search(next, active.signal);
      if (version !== revision.current) return;
      setResult(previous => append && previous ? { ...response, results: [...previous.results, ...response.results] } : response);
    } catch (failure) {
      if (version === revision.current && !active.signal.aborted) setError(failure instanceof Error ? failure.message : t.failed);
    } finally { if (version === revision.current) setLoading(false); }
  }
  return <div className="page search-page"><header className="page-header"><h1>{t.title}</h1></header>
    <form className="search-form" onSubmit={event => { event.preventDefault(); void search({ ...query, offset: 0 }); }}>
      <label>{t.query}<input type="search" value={query.query} onChange={event => setQuery({ ...query, query: event.target.value })}/></label>
      <label>{t.project}<input value={query.project ?? ''} onChange={event => setQuery({ ...query, project: event.target.value })}/></label>
      <label>{t.provider}<select value={query.provider ?? ''} onChange={event => setQuery({ ...query, provider: event.target.value })}><option value="">{t.all}</option><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
      {(['from', 'to'] as const).map(key => <label key={key}>{t[key]}<input type="datetime-local" value={query[key] ?? ''} onChange={event => setQuery({ ...query, [key]: event.target.value })}/></label>)}
      <label>{t.kind}<select value={query.kind ?? ''} onChange={event => setQuery({ ...query, kind: event.target.value as SearchKind || undefined })}><option value="">{t.all}</option>{SEARCH_KINDS.map(kind => <option key={kind} value={kind}>{t[kind]}</option>)}</select></label>
      <button className="btn btn-primary" type="submit">{t.title}</button>
    </form>
    {loading && <p role="status">{t.loading}</p>}{error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite">
      {result.mode === 'substring' && <p>{t.fallback}</p>}
      {result.unsupported.length > 0 && <aside aria-label={t.unsupported}><p>{t.unsupported}</p><ul>{result.unsupported.map((row, index) => <li key={`${row.subject}:${index}`}>{row.subject}: {row.reason}</li>)}</ul></aside>}
      <p role="status">{result.total === 0 ? t.empty : `${result.total} ${language === 'ja' ? '件' : 'results'}`}</p>
      {SEARCH_KINDS.map(kind => {
        const rows = result.results.filter(row => row.kind === kind);
        return rows.length > 0 && <section key={kind} aria-label={t[kind]}><h2>{t[kind]}</h2><ul className="search-results">{rows.map(row => {
          const href = getResultHref(row);
          return <li key={row.id}><article><header>{href ? <Link to={href}>{row.subject}</Link> : <strong>{row.subject}</strong>}</header>
            <dl><div><dt>{t.conversation}</dt><dd>{row.conversation_id ?? t.unknown}</dd></div><div><dt>{t.run}</dt><dd>{row.run_id ?? t.unknown}</dd></div>
              <div><dt>{t.confidence}</dt><dd>{row.confidence}</dd></div></dl><time dateTime={row.source_ts}>{row.source_ts}</time>
            {row.body === null ? <p className="muted-text">{row.reason === 'retention' ? t.retention : t.missing}</p> : <pre>{row.body}</pre>}
          </article></li>;
        })}</ul></section>;
      })}
      {result.results.length < result.total && <button className="btn" disabled={loading} onClick={() => void search({ ...submitted.current, offset: result.results.length }, true)}>{t.more}</button>}
    </div>}
  </div>;
}
