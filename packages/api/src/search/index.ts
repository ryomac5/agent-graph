import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { searchLedger, SearchValidationError, type SearchQuery, type SearchMode } from '../../../core/src/ledger/search.ts';
import { authorize, readRequestUrl } from '../ws/security.ts';

export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const query: SearchQuery = { query: params.get('q') ?? '' };
  const allowed = new Set(['q', 'project', 'provider', 'from', 'to', 'kind', 'limit', 'offset', 'token']);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new SearchValidationError('Invalid search parameter');
  for (const key of ['project', 'provider', 'from', 'to', 'kind'] as const) {
    const value = params.get(key);
    if (value !== null) Object.assign(query, { [key]: value });
  }
  for (const key of ['limit', 'offset'] as const) {
    const value = params.get(key);
    if (value !== null) {
      if (!/^\d+$/.test(value)) throw new SearchValidationError('Invalid search pagination');
      query[key] = Number(value);
    }
  }
  return query;
}

/** /api/search の GET を処理する。既存の HTTP サーバーから呼ぶ公開口。 */
export function createSearchHandler(db: DatabaseSync, options: { port: number; token: string; mode?: SearchMode }) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const url = readRequestUrl(request);
    if (url?.pathname !== '/api/search') return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!authorize(request, options.port, options.token)) { response.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return true; }
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); response.writeHead(405).end(); return true; }
    try {
      const result = searchLedger(db, parseSearchQuery(url.searchParams), options.mode);
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      const invalid = error instanceof SearchValidationError;
      response.writeHead(invalid ? 400 : 500).end(JSON.stringify({ error: invalid ? error.message : 'Search unavailable' }));
    }
    return true;
  };
}
