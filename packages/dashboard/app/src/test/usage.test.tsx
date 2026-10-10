import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { UsageBar } from '../components/usage/UsageBar.tsx';
import { formatReset, getUsageColor, type ProviderUsage, MANUAL_MS, POLL_MS, RETRY_MS } from '../components/usage/model.ts';
const START = Date.parse('2026-10-11T00:00:00Z');
const reset = new Date(START + (4 * 60 + 2) * 60_000).toISOString();
const providers: ProviderUsage[] = [
  { id: 'claude', fetchedAt: new Date(START).toISOString(), state: 'ok', windows: [{ key: 'session', label: 'Session', usedPercent: 3, resetsAt: reset }, { key: 'week', label: 'Week', usedPercent: 31, resetsAt: reset }] },
  { id: 'codex', fetchedAt: new Date(START).toISOString(), state: 'ok', windows: [{ key: 'primary', label: '5h', usedPercent: 80, resetsAt: reset }] },
  { id: 'antigravity', fetchedAt: new Date(START).toISOString(), state: 'ok', windows: [{ key: 'gemini', label: 'wk', group: 'Gemini Models', usedPercent: 95, resetsAt: reset }, { key: 'claude', label: '5h', group: 'Claude and GPT models', usedPercent: 25, resetsAt: reset }] },
];
function createClient(rows = providers) { return { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'usage', ok: true, result: { providers: rows } })) }; }
async function settle() { await act(async () => { await Promise.resolve(); }); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('shows the most constrained windows, official marks and boundary colors', async () => {
  render(<UsageBar client={createClient()} language="ja"/>); await settle();
  expect(screen.getByText('31% 使用済み')).toBeTruthy(); expect(screen.queryByText('3% 使用済み')).toBeNull();
  expect(screen.getByText('80% 使用済み').closest('.usage-summary-item')?.className).toContain('usage-warning');
  expect(screen.getByText('95% 使用済み').closest('.usage-summary-item')?.className).toContain('usage-danger');
  expect(document.querySelectorAll('.usage-bar .request-avatar').length).toBe(3);
  expect(document.querySelector('.usage-bar .provider-codex img')).toBeNull();
  expect([79, 80, 94, 95].map(getUsageColor)).toEqual(['normal', 'warning', 'warning', 'danger']);
});
it('opens details upwards with provider windows, reset times and Antigravity groups; Escape closes it', async () => {
  render(<UsageBar client={createClient()} language="ja"/>); await settle();
  const toggle = screen.getByRole('button', { name: '使用量の詳細' }); fireEvent.click(toggle);
  const dialog = screen.getByRole('dialog', { name: '使用量の詳細' });
  expect(within(dialog).getAllByText('4 時間 2 分で戻る').length).toBeGreaterThan(0);
  expect(within(dialog).getByText('Gemini モデル')).toBeTruthy(); expect(within(dialog).getByText('Claude と GPT モデル')).toBeTruthy();
  expect(within(dialog).getAllByRole('progressbar').map(row => row.getAttribute('aria-valuenow'))).toEqual(['3', '31', '80', '95', '25']);
  fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(toggle);
});
it('shows unavailable reasons and stale values in both languages', async () => {
  const client = createClient([{ ...providers[0], state: 'stale', reason: 'old_value' }, { ...providers[1], state: 'unavailable', windows: [], reason: 'source_unavailable' }, providers[2]]);
  const view = render(<UsageBar client={client} language="en"/>); await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Usage details' }));
  expect(screen.getByText('Unavailable · The provider and session record are unavailable')).toBeTruthy();
  expect(screen.getByText('Stale value · The value is over 30 minutes old')).toBeTruthy();
  view.rerender(<UsageBar client={client} language="ja"/>);
  expect(screen.getByText('取得できません · 提供元と会話の記録から取得できません')).toBeTruthy();
  expect(screen.getByText('古い値 · 30 分以上前の値です')).toBeTruthy();
});
it('polls every 15 minutes while visible and focused, and refresh is limited to 5 minutes', async () => {
  const client = createClient(); render(<UsageBar client={client} language="en"/>); await settle();
  const button = screen.getByRole('button', { name: 'Refresh usage' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(MANUAL_MS); }); expect(button.disabled).toBe(false);
  fireEvent.click(button); await settle(); expect(client.command).toHaveBeenLastCalledWith('usage.read', { force: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS - 1); }); expect(client.command).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(client.command).toHaveBeenCalledTimes(3);
  vi.mocked(document.hasFocus).mockReturnValue(false); fireEvent(window, new Event('blur'));
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); }); expect(client.command).toHaveBeenCalledTimes(3);
  vi.mocked(document.hasFocus).mockReturnValue(true); fireEvent(window, new Event('focus')); await settle(); expect(client.command).toHaveBeenCalledTimes(4);
});
it('backs off after failures and does not fetch when the sidebar is hidden', async () => {
  const client = createClient([{ ...providers[0], windows: [], state: 'unavailable' }]);
  const view = render(<UsageBar client={client} language="en"/>); await settle();
  await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); }); expect(client.command).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); }); expect(client.command).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); }); expect(client.command).toHaveBeenCalledTimes(3);
  view.rerender(<UsageBar client={client} language="en" visible={false}/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); }); expect(client.command).toHaveBeenCalledTimes(3);
});
it('formats elapsed and unknown reset times', () => {
  expect(formatReset(reset, START, 'en')).toBe('Resets in 4h 2m');
  expect(formatReset(reset, START + POLL_MS * 30, 'ja')).toBe('0 分で戻る');
  expect(formatReset(null, START, 'ja')).toBe('戻る時刻は不明');
});
