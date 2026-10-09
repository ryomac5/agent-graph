import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { createStore } from '../lib/store.ts';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ generation: 0,
    projection: { messages: [], message_memberships: [] }, next: null }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['en', 'ja'] as const)('opens changed files and diffs in %s and hides the button for zero files', async language => {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 0, projection: {
    conversations: [{ id: 'c', name: 'Changes', provider: 'claude', origin: 'managed' }],
    runs: [{ id: 'r', conversation_id: 'c', generation: 1, state: 'idle', launch: { cwd: '/workspace/demo' } }],
    messages: [{ id: 'edit', role: 'assistant', source_ts: '2026-10-07T00:00:01Z', body: [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/demo/src/a.ts', old_string: 'before', new_string: 'after' } },
    ] }],
    message_memberships: [{ id: 'link', message_id: 'edit', conversation_id: 'c', active: true }],
  } });
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: [] })) };
  render(<MemoryRouter><ConversationPage conversationId="c" target={target} client={client} language={language}/></MemoryRouter>);
  const label = language === 'ja' ? '変更したファイル' : 'Files changed';
  vi.stubGlobal('innerWidth', 390);
  const menu = screen.getByRole('button', { name: language === 'ja' ? '会話のメニュー' : 'Conversation menu' });
  fireEvent.click(menu);
  expect(menu.getAttribute('aria-expanded')).toBe('true');
  const button = screen.getByRole('button', { name: `${label} 1` });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('region', { name: label })).toBeNull();
  fireEvent.click(button);
  expect(menu.getAttribute('aria-expanded')).toBe('false');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  const region = screen.getByRole('region', { name: label });
  const summary = within(region).getByText('src/a.ts').closest('summary')!;
  expect(summary.textContent).toContain('+1−1');
  expect(summary.closest('details')!.open).toBe(false);
  fireEvent.click(summary);
  expect(summary.closest('details')!.open).toBe(true);
  expect(within(region).getByRole('table', { name: language === 'ja' ? 'src/a.ts 差分' : 'src/a.ts Diff' })).toBeTruthy();
  expect(region.querySelector('.diff-remove .diff-code')!.textContent).toBe('before');
  expect(region.querySelector('.diff-add .diff-code')!.textContent).toBe('after');
  fireEvent.click(button);
  expect(screen.queryByRole('region', { name: label })).toBeNull();
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: {
    messages: { upsert: [{ id: 'edit', role: 'assistant', body: 'No changes' }], remove: [] },
  } }));
  expect(screen.queryByRole('button', { name: new RegExp(label) })).toBeNull();
  await act(async () => {});
});
