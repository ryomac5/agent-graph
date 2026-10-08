import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { conversationName, formatWhen, readTitle } from '../../lib/format.ts';
import { getProjectName } from '../../lib/projects.ts';
import type { Language } from '../../lib/i18n.ts';
import { SEARCH_KINDS, getResultHref, extractSnippet, type SearchClient, type SearchKind, type SearchQuery, type SearchResponse } from './model.ts';
import { selectRoots } from '../../lib/roots.ts';
import { readAttempts } from '../tree/model.ts';
import './search.css';

const TEXT = {
  en: { title: 'Search', query: 'Search conversations', project: 'Project', provider: 'Provider', from: 'From', to: 'To', kind: 'Kind', all: 'All',
    message: 'Messages', tool_output: 'Tool output', diff: 'Diffs', finding: 'Findings', task: 'Task names', alias: 'Aliases',
    loading: 'Searching…', empty: 'No results', conversation: 'Conversation', run: 'Run', unknown: 'Unknown', confidence: 'Confidence',
    retention: 'Body removed by retention policy.', missing: 'Message unavailable.',
    unsupported: 'Unsupported history formats cannot be searched.', fallback: 'Showing substring matches', more: 'Load more', failed: 'Search unavailable' },
  ja: { title: '検索', query: '会話を検索', project: 'プロジェクト', provider: 'プロバイダー', from: '開始日時', to: '終了日時', kind: '種別', all: 'すべて',
    message: 'メッセージ', tool_output: 'ツールの出力', diff: '差分', finding: '指摘', task: 'タスク', alias: '別名',
    loading: '検索中…', empty: '結果なし', conversation: '会話', run: '実行', unknown: '不明', confidence: '確度',
    retention: '保持期間により本文が削除されました。', missing: 'メッセージを取得できません。',
    unsupported: '形式未対応の会話は検索できません。', fallback: '部分一致で表示しています', more: 'さらに表示', failed: '検索できません' },
};
function formatTimestamp(value: string, language: Language): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? formatWhen(value, language) : value;
}
export function SearchPage({ client, target = store, language = 'en' }: { client: SearchClient; target?: ScreenStore; language?: Language }) {
  const state = useScreenStore(target);
  const t = TEXT[language];
  const rootNames = new Map(selectRoots(state).flatMap(root => root.conversation_ids.map(id => [id, root.name] as const)));
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
      {(['from', 'to'] as const).map(key => <label key={key}>{t[key]}<input type={language === 'ja' ? 'text' : 'datetime-local'} lang={language} placeholder={language === 'ja' ? '年/月/日 時:分' : undefined} pattern={language === 'ja' ? '[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}' : undefined} value={language === 'ja' ? (query[key] ?? '').replaceAll('-', '/').replace('T', ' ') : query[key] ?? ''} onChange={event => setQuery({ ...query, [key]: language === 'ja' ? event.target.value.replaceAll('/', '-').replace(' ', 'T') : event.target.value })}/></label>)}
      <label>{t.kind}<select value={query.kind ?? ''} onChange={event => setQuery({ ...query, kind: event.target.value as SearchKind || undefined })}><option value="">{t.all}</option>{SEARCH_KINDS.map(kind => <option key={kind} value={kind}>{t[kind]}</option>)}</select></label>
      <button className="btn btn-primary" type="submit">{t.title}</button>
    </form>
    {loading && <p role="status">{t.loading}</p>}{error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite">
      {result.mode === 'substring' && <p>{t.fallback}</p>}
      {result.unsupported.length > 0 && <aside aria-label={t.unsupported} className="muted-text" title={result.unsupported.map(row => row.reason).join('\n')}><span>{t.unsupported}</span> <span className="numeric">({result.unsupported.length})</span></aside>}
      <p role="status">{result.total === 0 ? t.empty : `${result.total} ${language === 'ja' ? '件' : 'results'}`}</p>
      {SEARCH_KINDS.map(kind => {
        const rows = result.results.filter(row => row.kind === kind);
        return rows.length > 0 && <section key={kind} aria-label={t[kind]}><h2>{t[kind]}</h2><ul className="search-results">{rows.map(row => {
          const href = getResultHref(row, state);
          const id = state.identities?.conversations[row.conversation_id ?? ''] ?? row.conversation_id ?? '';
          const conversation = state.projection.conversations?.find(item => item.id === id);
          const task = state.projection.tasks?.find(item => item.id === conversation?.task_id || `task:${item.id}` === row.subject);
          const delegation = state.projection.delegations?.find(d => d.conversation_id === id || Boolean(row.run_id) && (d.run_id === row.run_id || readAttempts(d).some(a => a.run_id === row.run_id)));
          const usable = (value: unknown) => /^(done|ended|idle|running|failed|unknown)$/i.test(readTitle(value)) ? '' : readTitle(value);
          const rootName = usable(rootNames.get(id));
          const name = rootName || usable(conversationName(state, id)) || usable(delegation?.title) || usable(task?.name) || t.conversation;
          const taskName = usable(delegation?.title) || usable(task?.name) || name;
          const projectName = getProjectName(state, String(conversation?.project ?? task?.project ?? row.project ?? ''));
          const title = row.kind === 'diff' ? `${t.diff} · ${taskName}` : row.kind === 'finding' ? `${t.finding} · ${taskName}` : name;
          return <li key={row.id}><article><header>{href ? <Link to={href}>{title}</Link> : <strong>{title}</strong>}</header>
            <dl><div><dt>{t.conversation}</dt><dd>{name}</dd></div><div><dt>{t.task}</dt><dd>{taskName}</dd></div>
              <div><dt>{t.project}</dt><dd>{projectName}</dd></div></dl><time dateTime={row.source_ts} title={row.source_ts}>{formatTimestamp(row.source_ts, language)}</time>
            {row.body === null ? <p className="muted-text">{row.reason === 'retention' ? t.retention : t.missing}</p> : <p className="search-excerpt">{extractSnippet(row.body, submitted.current.query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</p>}
          </article></li>;
        })}</ul></section>;
      })}
      {result.results.length < result.total && <button className="btn" disabled={loading} onClick={() => void search({ ...submitted.current, offset: result.results.length }, true)}>{t.more}</button>}
    </div>}
  </div>;
}
