import { afterEach, expect, it, vi } from 'vitest';
import { installStyleNonce, readStyleNonce } from '../lib/style-nonce.ts';

afterEach(() => {
  vi.restoreAllMocks();
  document.querySelector('meta[name="agent-graph-style-nonce"]')?.remove();
});

it('leaves element creation unchanged without a nonce in development', () => {
  const createElement = document.createElement;
  installStyleNonce();
  expect(readStyleNonce()).toBe('');
  expect(document.createElement).toBe(createElement);
  expect(document.createElement('style').nonce).toBe('');
});

it('sets the meta nonce on style elements before insertion and preserves other elements and options', () => {
  const meta = document.createElement('meta');
  meta.name = 'agent-graph-style-nonce'; meta.content = 'test-style-nonce';
  document.head.append(meta);
  const createElement = vi.spyOn(document, 'createElement');
  installStyleNonce();
  expect(readStyleNonce()).toBe(meta.content);
  expect(document.createElement('style').nonce).toBe(meta.content);
  expect(document.createElement('STYLE').nonce).toBe(meta.content);
  expect(document.createElement('div').hasAttribute('nonce')).toBe(false);
  const options = { is: 'custom-button' };
  document.createElement('button', options);
  expect(createElement).toHaveBeenLastCalledWith('button', options);
});
