import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { GraphPage } from '../pages/graph/GraphPage.tsx';
import { createStore } from '../lib/store.ts';
const now = Date.parse('2026-10-11T12:00:00Z');
export function fixture() {
  const target = createStore();
  const children = ['work', 'review', 'docs', 'approval', 'research', 'plan', 'other', ...Array.from({ length: 45 }, (_, i) => `old-${i}`)];
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [{ id: 'root', name: 'Build the console', project: 'repo', state: 'idle', conversation_ids: ['root'], total_children: children.length, running_children: 2 }],
    conversations: ['root', ...children].map(id => ({ id, provider: id === 'root' || id === 'docs' ? 'claude' : 'codex' })),
    runs: ['root', ...children].map(id => ({ id: `run-${id}`, conversation_id: id, generation: 1, state: ['work', 'review'].includes(id) ? 'running' : id === 'approval' ? 'waiting_approval' : id === 'root' ? 'idle' : 'ended', started_ts: id.startsWith('old') ? '2026-10-09T09:00:00Z' : '2026-10-11T11:00:00Z', ended_ts: id.startsWith('old') ? '2026-10-09T10:00:00Z' : '2026-10-11T11:30:00Z', model: id === 'docs' ? 'claude-opus-5-5' : '' })),
    relations: children.map(id => ({ id: `rel-${id}`, type: 'delegated', from_id: id === 'review' ? 'work' : 'root', to_id: id, active: 1, evidence: { role: id === 'docs' ? 'write' : id === 'research' ? 'Explore' : id === 'plan' ? 'Plan' : id === 'review' ? 'reviewer' : id === 'other' ? 'unknown-role' : 'implement', description: `Request ${id}` } })),
    messages: [{ id: 'tool', role: 'assistant', source_ts: '2026-10-11T11:59:00Z', body: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/roles.ts' } }] }],
    message_memberships: [{ message_id: 'tool', conversation_id: 'work', active: 1 }],
    approvals: [{ id: 'approval-a', run_id: 'run-approval', state: 'requested', request: { command: 'pnpm test' }, available_decisions: ['allow', 'deny'] }],
  } }); target.setConnection('connected'); return target;
}
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function renderGraph(embedded = false, language: 'en' | 'ja' = 'en', entry = '/p/repo/graph?root=root', client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'a', ok: true })) }) {
  const target = fixture();
  render(<MemoryRouter initialEntries={[entry]}><GraphPage project="repo" target={target} client={client} embedded={embedded} language={language}/><Location/></MemoryRouter>);
  return { target, client };
}
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(now));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(['en', 'ja'] as const)('shows all role shapes and words, running work and ancestor lines in %s', language => {
  renderGraph(true, language);
  for (const [role, icon] of Object.entries({ main: 'message', research: 'search', advisor: 'plan', implement: 'tool', review: 'check', document: 'file' })) {
    expect(document.querySelector(`[data-role="${role}"]`)?.getAttribute('data-icon')).toBe(icon);
  }
  const row = document.querySelector('[data-node-id="work"]')!;
  expect(row.classList.contains('is-running')).toBe(true);
  expect(row.getAttribute('style')).toContain('52px');
  expect(row.querySelector('.graph-current-work')?.textContent).toBe(language === 'ja' ? 'roles.ts を編集中'.replace('ts ', 'ts') : 'Editing roles.ts');
  expect(document.querySelector('[data-child=work]')?.classList.contains('is-running')).toBe(true);
  expect(screen.getByText(language === 'ja' ? '下で 2 件が実行中' : '2 running below')).toBeTruthy();
  expect(screen.queryByText('待機中')).toBeNull();
  expect(screen.getByText(language === 'ja' ? '文書 · Opus 5.5' : 'Document · Opus 5.5')).toBeTruthy();
});
it('counts hidden roles, filters without losing ancestors, and toggles back', () => {
  renderGraph();
  expect(screen.getByRole('button', { name: 'Implement 48' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Review 1' }));
  expect([...document.querySelectorAll('[data-node-id]')].map(row => row.getAttribute('data-node-id'))).toEqual(['root', 'work', 'review']);
  fireEvent.click(screen.getByRole('button', { name: 'Review 1' }));
  expect(document.querySelector('[data-node-id="earlier:root"]')).toBeTruthy();
});
it('pages folded children and retains expansion in the URL through remounting', () => {
  renderGraph(); fireEvent.click(screen.getByRole('treeitem', { name: /Earlier 45/ }));
  expect(document.querySelectorAll('[data-node-id^="old-"]')).toHaveLength(20);
  expect(screen.getByText('Show 20 more')).toBeTruthy();
  fireEvent.click(screen.getByRole('treeitem', { name: /Show 20 more/ }));
  expect(document.querySelectorAll('[data-node-id^="old-"]')).toHaveLength(40);
  const entry = screen.getByTestId('location').textContent!;
  expect(entry).toContain('expanded=earlier%3Aroot%4040');
  cleanup(); renderGraph(false, 'en', entry);
  expect(document.querySelectorAll('[data-node-id^="old-"]')).toHaveLength(40);
  fireEvent.keyDown(screen.getByRole('treeitem', { name: /Earlier 45/ }), { key: 'ArrowLeft' });
  expect(document.querySelectorAll('[data-node-id^="old-"]')).toHaveLength(0);
});
it('uses range buttons, segmented bars, ordinary scrolling and a floating detail', () => {
  renderGraph();
  expect(screen.getByRole('button', { name: '6h' }).getAttribute('aria-pressed')).toBe('true');
  for (const range of ['1h', '6h', '24h', 'All']) { fireEvent.click(screen.getByRole('button', { name: range })); expect(screen.getByRole('button', { name: range }).getAttribute('aria-pressed')).toBe('true'); }
  expect(document.querySelector('.graph-time-bar.tone-running')).toBeTruthy();
  const scroll = document.querySelector('.graph-scroll')!; const event = new WheelEvent('wheel', { cancelable: true }); fireEvent(scroll, event); expect(event.defaultPrevented).toBe(false);
  fireEvent.click(screen.getByRole('treeitem', { name: /Request work/ }));
  expect(screen.getByRole('complementary', { name: 'Request' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open conversation' }).getAttribute('href')).toContain('child=work');
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  expect(screen.queryByRole('complementary', { name: 'Request' })).toBeNull();
});
it.each(['Allow', 'Deny'])('answers %s once from the inline approval row', async action => {
  const { client } = renderGraph(true);
  const button = screen.getByRole('button', { name: action }); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(client.command).toHaveBeenCalledExactlyOnceWith('answer', { approvalId: 'approval-a', decision: action.toLowerCase() }));
  expect(button.hasAttribute('disabled')).toBe(true);
});
it('recovers failed approvals and disables decisions when disconnected', async () => {
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'a', ok: false, error: 'Unavailable' })) };
  const { target } = renderGraph(true, 'en', undefined, client);
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Unavailable');
  expect(screen.getByRole('button', { name: 'Allow' }).hasAttribute('disabled')).toBe(false);
  target.setConnection('reconnecting');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Allow' }).hasAttribute('disabled')).toBe(true));
});
it('preserves conversation URLs in the panel and moves between rows with arrows', () => {
  renderGraph(true);
  const root = screen.getByRole('treeitem', { name: /Build the console/ });
  fireEvent.keyDown(root, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: /Request work/ }));
  expect(document.activeElement?.getAttribute('href')).toBe('/p/repo?root=root&child=work');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }); expect(document.activeElement).toBe(root);
});

it('extends running bars to Now every ten seconds and persists automatic expansion for URL selection', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(now);
    renderGraph(false, 'en', '/p/repo/graph?root=root&child=old-44');
    expect(screen.getByRole('treeitem', { name: /Request old-44/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('location').textContent).toContain('expanded=');
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    const readBar = () => document.querySelector<HTMLElement>('[data-node-id=work] .graph-time-bar')!.title;
    const before = readBar();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(readBar()).not.toBe(before);
  } finally { vi.useRealTimers(); }
});
