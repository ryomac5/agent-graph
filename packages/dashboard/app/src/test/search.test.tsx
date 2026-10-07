import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SearchPage } from '../pages/search/SearchPage.tsx';
import { createSearchClient, SEARCH_KINDS, type SearchResponse, type SearchQuery } from '../pages/search/model.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function createResult(): SearchResponse {
  return { mode: 'fts5', total: 6, unsupported: [{ subject: 'observation:o', reason: 'Unknown format version' }],
    results: SEARCH_KINDS.map((kind, index) => ({ id: `result-${index}`, fact_id: 'fact', subject: `${kind}:needle`, kind,
      body: `needle ${kind}`, reason: null, conversation_id: '["codex","c"]', run_id: 'run-1',
      message_id: kind === 'message' || kind === 'tool_output' ? '["codex","m"]' : null,
      project: 'repo', provider: 'codex', source_ts: '2026-01-01T00:00:00Z', confidence: 'confirmed',
    })) };
}

it('groups all kinds and shows provenance, unsupported formats and a link to the exact message', async () => {
  const search = vi.fn(async () => createResult());
  render(<MemoryRouter><SearchPage client={{ search }}/></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Search all conversations'), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('6 results');
  for (const name of ['Messages', 'Tool output', 'Diffs', 'Findings', 'Task names', 'Aliases']) expect(screen.getByRole('region', { name })).toBeTruthy();
  const section = screen.getByRole('region', { name: 'Messages' });
  expect(within(section).getByText('confirmed')).toBeTruthy();
  expect(within(section).getByText('run-1')).toBeTruthy();
  expect(within(section).getByText('2026-01-01T00:00:00Z')).toBeTruthy();
  expect(within(section).getByRole('link').getAttribute('href')).toBe('/c/%5B%22codex%22%2C%22c%22%5D#message-%5B%22codex%22%2C%22m%22%5D');
  expect(screen.getByText('Unsupported history formats cannot be searched.')).toBeTruthy();
  expect(screen.getByText(/Unknown format version/)).toBeTruthy();
});

it('sends project, provider, period and kind filters and explains removed bodies and fallback', async () => {
  const response = createResult(); response.mode = 'substring';
  response.results = [{ ...response.results[0], body: null, reason: 'retention' }]; response.total = 1;
  const search = vi.fn(async (_query: SearchQuery) => response);
  render(<MemoryRouter><SearchPage client={{ search }}/></MemoryRouter>);
  for (const [label, value] of [['Project', 'repo'], ['Provider', 'codex'], ['From', '2026-01-01T00:00'], ['To', '2026-02-01T00:00'], ['Kind', 'message']]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('Body removed by retention policy.');
  expect(screen.getByText('Substring search (FTS5 unavailable)')).toBeTruthy();
  expect(screen.queryByText('needle message')).toBeNull();
  expect(search.mock.calls[0][0]).toMatchObject({ project: 'repo', provider: 'codex', kind: 'message', from: '2026-01-01T00:00', to: '2026-02-01T00:00', offset: 0 });
});

it('handles empty results, errors and Japanese labels', async () => {
  const search = vi.fn().mockResolvedValueOnce({ mode: 'fts5', results: [], total: 0, unsupported: [] }).mockRejectedValueOnce(new Error('Search unavailable'));
  render(<MemoryRouter><SearchPage client={{ search }} language="ja"/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '検索' }));
  await screen.findByText('結果なし');
  fireEvent.click(screen.getByRole('button', { name: '検索' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Search unavailable');
});

it('ignores stale responses and appends the next page using the submitted filters', async () => {
  let resolveFirst: (response: SearchResponse) => void = () => {};
  const response = createResult(); response.total = 7;
  const search = vi.fn().mockImplementationOnce(() => new Promise<SearchResponse>(resolve => { resolveFirst = resolve; }))
    .mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response, results: [{ ...response.results[0], id: 'next-page' }] });
  render(<MemoryRouter><SearchPage client={{ search }}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.change(screen.getByLabelText('Search all conversations'), { target: { value: 'second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('7 results');
  resolveFirst({ mode: 'fts5', total: 0, results: [], unsupported: [] });
  await waitFor(() => expect(screen.queryByText('No results')).toBeNull());
  fireEvent.change(screen.getByLabelText('Search all conversations'), { target: { value: 'unsent' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  expect(search.mock.calls[2][0]).toMatchObject({ query: 'second', offset: 6 });
});

it('uses an authenticated API client without putting the token in the URL', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => createResult() }));
  vi.stubGlobal('fetch', fetcher);
  const client = createSearchClient({ token: 'private-token' });
  const controller = new AbortController();
  const from = '2026-01-01T09:00';
  const to = '2026-02-01T09:00';
  await client.search({ query: 'kit-0042', project: 'repo', kind: 'alias', from, to }, controller.signal);
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/api/search'); expect(url.searchParams.get('q')).toBe('kit-0042');
  expect(url.searchParams.get('from')).toBe(new Date(from).toISOString());
  expect(url.searchParams.get('to')).toBe(new Date(to).toISOString());
  expect(url.href).not.toContain('private-token');
  expect(options.headers).toEqual({ 'x-agent-graph-token': 'private-token' });
  expect(options.signal).toBe(controller.signal);
});
