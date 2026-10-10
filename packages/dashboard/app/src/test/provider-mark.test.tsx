import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { ProviderMark } from '../components/RootViews.tsx';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([['claude', 'claude.svg', 'Claude'], ['antigravity', 'antigravity.png', 'Antigravity'], ['gemini', 'antigravity.png', 'Antigravity']])('loads %s locally and falls back after failure', (provider, brand, name) => {
  const view = render(<ProviderMark provider={provider}/>);
  const image = view.container.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(`/brand/${brand}`);
  expect(view.container.querySelector('span')?.title).toBe(name);
  fireEvent.error(image);
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('.icon')).toBeTruthy();
});
it('uses the current mark when OpenAI retrieval fails', async () => {
  const fetcher = vi.fn(async () => ({ ok: false })); vi.stubGlobal('fetch', fetcher);
  const view = render(<ProviderMark provider="codex"/>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/brand/openai.svg'));
  expect(view.container.querySelector('img')).toBeNull(); expect(view.container.querySelector('.icon')).toBeTruthy();
});
it('uses the current mark for malformed OpenAI shapes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<svg><path d="bad"/></svg>' })));
  const view = render(<ProviderMark provider="codex"/>);
  await waitFor(() => expect(view.container.querySelector('.icon')).toBeTruthy());
});
it('renders retrieved OpenAI paths inline with currentColor, excludes unsafe attributes and shares requests', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, text: async () => '<svg viewBox="0 0 24 24" fill-rule="evenodd" onload="bad()"><script>bad()</script><path d="M0 0L1 1Z" onclick="bad()"/></svg>' })); vi.stubGlobal('fetch', fetcher);
  const view = render(<><ProviderMark provider="codex"/><ProviderMark provider="codex"/></>);
  await waitFor(() => expect(view.container.querySelectorAll('svg[fill="currentColor"]')).toHaveLength(2));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.innerHTML).not.toMatch(/onload|onclick|script/);
  const { DelegationCard } = await import('../components/conversation/DelegationCard.tsx');
  const card = render(<DelegationCard tool={{ name: 'spawn_agent', input: { provider: 'codex', description: 'Review' } }} language="en"/>);
  await waitFor(() => expect(card.container.querySelector('svg[fill="currentColor"]')).toBeTruthy());
});
