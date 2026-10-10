import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ProviderMark } from '../components/RootViews.tsx';
afterEach(cleanup);
it.each([['claude', 'claude', 'Claude'], ['codex', 'chatgpt', 'Codex'], ['antigravity', 'antigravity', 'Antigravity'], ['gemini', 'antigravity', 'Antigravity']])('loads %s from the local brand endpoint and falls back after failure', (provider, brand, name) => {
  const view = render(<ProviderMark provider={provider}/>);
  const image = view.container.querySelector('img')!;
  expect(image.getAttribute('src')).toBe(`/brand/${brand}.png`);
  expect(view.container.querySelector('span')?.title).toBe(name);
  fireEvent.error(image);
  expect(view.container.querySelector('img')).toBeNull();
  expect(view.container.querySelector('svg')).toBeTruthy();
});
it('keeps the existing mark for unknown providers and loads a new provider after a failure', () => {
  const view = render(<ProviderMark provider="other"/>);
  expect(view.container.querySelector('img')).toBeNull();
  view.rerender(<ProviderMark provider="claude"/>);
  fireEvent.error(view.container.querySelector('img')!);
  view.rerender(<ProviderMark provider="codex"/>);
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/brand/chatgpt.png');
});

it('uses the same official mark in conversation delegation cards', async () => {
  const { DelegationCard } = await import('../components/conversation/DelegationCard.tsx');
  const view = render(<DelegationCard tool={{ name: 'spawn_agent', input: { provider: 'codex', description: 'Review' } }} language="en"/>);
  expect(view.container.querySelector('img')?.getAttribute('src')).toBe('/brand/chatgpt.png');
  fireEvent.error(view.container.querySelector('img')!);
  expect(view.container.querySelector('svg')).toBeTruthy();
});
