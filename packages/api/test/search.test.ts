import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openLedger } from '../../core/src/ledger/ledger.ts';
import { rebuild } from '../../core/src/ledger/rebuild.ts';
import { createSearchHandler, parseSearchQuery } from '../src/search/index.ts';

test('search API authenticates, validates filters, searches aliases and returns metadata', t => {
  const dir = mkdtempSync(join(tmpdir(), 'api-search-'));
  const path = join(dir, 'ledger.db');
  const ledger = openLedger(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); ledger.close(); rmSync(dir, { recursive: true }); });
  ledger.append({ source: 'kit', source_event_id: 'a', source_ts: '2026-01-01T00:00:00Z',
    kind: 'alias.created', subject: 'alias:a', confidence: 'confirmed', payload: { entity_id: 't', kind: 'kit', name: 'old-kit-0042' } });
  rebuild(db);
  const options = { port: 7422, token: 'test-secret' };
  const handler = createSearchHandler(db, options);
  // HTTP の要求・応答を直接通し、囲い内でも認証と実際のハンドラーを検証する。
  function request(url: string, headers: Record<string, string> = {}, method = 'GET') {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const input = new IncomingMessage(socket);
    input.method = method; input.url = url;
    input.headers = { host: '127.0.0.1:7422', 'x-agent-graph-token': options.token, ...headers };
    const response = new ServerResponse(input);
    let body = '';
    response.end = function (chunk?: unknown) { body = typeof chunk === 'string' ? chunk : ''; return this; };
    handler(input, response);
    socket.destroy();
    return { status: response.statusCode, cache: response.getHeader('cache-control'),
      body: body ? JSON.parse(body) : null };
  }
  const get = (query: string) => request(`/api/search?${query}`);
  const found = get('q=old-kit-0042&kind=alias');
  assert.equal(found.status, 200);
  assert.equal(found.cache, 'no-store');
  assert.equal(found.body.total, 1);
  assert.equal(found.body.results[0].body, 'old-kit-0042');
  assert.equal(found.body.results[0].confidence, 'confirmed');
  assert.equal(get('q=old&provider=claude').status, 200);
  for (const query of ['kind=invalid', 'provider=other', 'limit=-1', 'limit=501', 'offset=1.1', 'from=bad', 'from=2027-01-01&to=2026-01-01', 'q=a&q=b', 'unknown=x']) assert.equal(get(query).status, 400, query);
  assert.equal(request('/api/search', { 'x-agent-graph-token': '' }).status, 403);
  assert.equal(request('/api/search', { origin: 'https://outside.test' }).status, 403);
  assert.equal(request('/api/search', {}, 'POST').status, 405);
  ledger.purgePayloads('2100-01-01');
  const removed = get('q=alias%3Aa');
  assert.equal(removed.body.results[0].body, null);
  assert.equal(removed.body.results[0].reason, 'retention');
  const prepare = db.prepare.bind(db);
  db.prepare = () => { throw new TypeError('Internal database detail'); };
  assert.deepEqual(get('q=alias').body, { error: 'Search unavailable' });
  assert.equal(get('q=alias').status, 500);
  db.prepare = prepare;
});

test('query parser preserves all filters and pagination', () => {
  assert.deepEqual(parseSearchQuery(new URLSearchParams('q=42&project=repo&provider=codex&from=2026-01-01&to=2026-02-01&kind=message&limit=10&offset=20')), {
    query: '42', project: 'repo', provider: 'codex', from: '2026-01-01', to: '2026-02-01', kind: 'message', limit: 10, offset: 20,
  });
});
