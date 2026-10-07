export const SEARCH_KINDS = ['message', 'tool_output', 'diff', 'finding', 'task', 'alias'] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
export interface SearchQuery {
  query: string; project?: string; provider?: string; from?: string; to?: string;
  kind?: SearchKind; limit?: number; offset?: number;
}
export interface SearchResult {
  id: string; fact_id: string; subject: string; kind: SearchKind; body: string | null;
  reason: string | null; conversation_id: string | null; run_id: string | null;
  message_id: string | null; project: string | null; provider: string | null;
  source_ts: string; confidence: string;
}
export interface SearchResponse {
  mode: 'fts5' | 'substring'; results: SearchResult[]; total: number;
  unsupported: { subject: string; reason: string }[];
}
export interface SearchClient { search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> }
export function createSearchClient(options: { token: string; url?: string }): SearchClient {
  return { async search(query, signal) {
    const url = new URL(options.url ?? '/api/search', window.location.origin);
    url.searchParams.set('q', query.query);
    for (const key of ['project', 'provider', 'from', 'to', 'kind', 'limit', 'offset'] as const) {
      const value = query[key];
      if (value !== undefined && value !== '') {
        // ブラウザーの現地時刻を、API のタイムゾーンに依存しない時刻へ変換する。
        const encoded = key === 'from' || key === 'to' ? new Date(value).toISOString() : String(value);
        url.searchParams.set(key, encoded);
      }
    }
    const response = await fetch(url, { signal, headers: { 'x-agent-graph-token': options.token } });
    if (!response.ok) throw new Error(`Search unavailable (${response.status})`);
    return response.json() as Promise<SearchResponse>;
  } };
}
export function getResultHref(result: SearchResult): string | undefined {
  if (!result.conversation_id) return undefined;
  const path = `/c/${encodeURIComponent(result.conversation_id)}`;
  return result.message_id ? `${path}#message-${encodeURIComponent(result.message_id)}` : path;
}
