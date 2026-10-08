import { getRegisteredProjects, OTHER_PROJECT } from '../../lib/projects.ts';
import type { ScreenState } from '../../lib/store.ts';
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
export function getResultHref(result: SearchResult, state?: ScreenState): string | undefined {
  const conversationId = state?.identities?.conversations[result.conversation_id ?? ''] ?? result.conversation_id;
  const conversation = state?.projection.conversations?.find(row => row.id === conversationId);
  const task = state?.projection.tasks?.find(row => row.id === conversation?.task_id);
  const projectId = String(conversation?.project ?? task?.project ?? result.project ?? OTHER_PROJECT);
  const project = state && !getRegisteredProjects(state).some(row => row.id === projectId) ? OTHER_PROJECT : projectId;
  if (result.kind === 'diff' || result.kind === 'finding') {
    const finding = state?.projection.findings?.find(row => `finding:${row.id}` === result.subject);
    const artifactId = result.kind === 'diff' ? result.subject.replace(/^artifact:/, '') : String(finding?.artifact_id ?? '');
    const query = artifactId ? `artifact=${encodeURIComponent(artifactId)}` : `run=${encodeURIComponent(result.run_id ?? '')}`;
    return `/p/${encodeURIComponent(project)}/changes?${query}`;
  }
  if (!conversationId) return undefined;
  const path = `/c/${encodeURIComponent(conversationId)}`;
  return result.message_id ? `${path}#message-${encodeURIComponent(result.message_id)}` : path;
}

const SNIPPET_CONTEXT_CHARS = 80;
const SNIPPET_CHAR_LIMIT = 360;
const SNIPPET_LINE_LIMIT = 3;
export function extractSnippet(body: string, query: string): { text: string; match: boolean }[] {
  body = body.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/\*\*|__|~~|\x60{1,3}/g, '').replace(/^\s{0,3}#{1,6}\s+/gm, '');
  const terms = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])].filter(term => !['AND', 'OR', 'NOT', 'NEAR'].includes(term));
  const lower = body.toLocaleLowerCase();
  const hits = terms.map(term => lower.indexOf(term.toLocaleLowerCase())).filter(index => index >= 0);
  const first = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, first - SNIPPET_CONTEXT_CHARS, body.lastIndexOf('\n', first - 1) + 1);
  const window = body.slice(start, start + SNIPPET_CHAR_LIMIT).split('\n').slice(0, SNIPPET_LINE_LIMIT).join('\n');
  const excerpt = (start ? '…' : '') + window + (start + window.length < body.length ? '…' : '');
  if (!terms.length) return [{ text: excerpt, match: false }];
  const pattern = new RegExp('(' + terms.join('|') + ')', 'giu');
  return excerpt.split(pattern).filter(Boolean).map((text) => ({ text, match: terms.some(term => term.toLocaleLowerCase() === text.toLocaleLowerCase()) }));
}
