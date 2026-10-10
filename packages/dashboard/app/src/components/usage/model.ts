import type { Language } from '../../lib/i18n.ts';
export interface UsageWindow { key: string; label: string; usedPercent: number; resetsAt: string | null; group?: string }
export interface ProviderUsage { id: 'claude' | 'codex' | 'antigravity'; windows: UsageWindow[]; fetchedAt: string | null; state: 'ok' | 'stale' | 'unavailable'; reason?: string }
export const PROVIDERS = ['claude', 'codex', 'antigravity'] as const;
export const NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
export const POLL_MS = 15 * 60_000;
export const MANUAL_MS = 5 * 60_000;
export const RETRY_MS = 30_000;
export const STALE_MS = 30 * 60_000;
export function getMostUsed(windows: UsageWindow[]): UsageWindow | undefined {
  return windows.reduce<UsageWindow | undefined>((most, row) => !most || row.usedPercent > most.usedPercent ? row : most, undefined);
}
export function getUsageColor(percent: number): string { return percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'normal'; }
export function formatReset(reset: string | null, now: number, language: Language): string {
  if (!reset || !Number.isFinite(Date.parse(reset))) return language === 'ja' ? '戻る時刻は不明' : 'Reset time unknown';
  const minutes = Math.max(0, Math.ceil((Date.parse(reset) - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  return language === 'ja' ? `${hours ? `${hours} 時間 ` : ''}${minutes % 60} 分で戻る` : `Resets in ${hours ? `${hours}h ` : ''}${minutes % 60}m`;
}
const REASONS: Record<string, [string, string]> = {
  old_value: ['The value is over 30 minutes old', '30 分以上前の値です'],
  record_fallback: ['Using the latest session record', '最新の会話の記録を表示しています'],
  turns_detected: ['Usage check started a turn; further checks stopped', '会話が始まったため、再取得を停止しました'],
  unsupported_version: ['Antigravity 1.1.11 or later is required', 'Antigravity 1.1.11 以降が必要です'],
  invalid_data: ['The usage response could not be read', '使用量の応答を読み取れません'],
  no_windows: ['No usage windows were returned', '使用量の枠がありません'],
  timeout: ['The usage check timed out', '取得が時間切れになりました'],
  command_unavailable: ['The command is unavailable', 'コマンドが見つかりません'],
  command_failed: ['The command failed', 'コマンドが失敗しました'],
  file_unavailable: ['The usage file could not be read', '使用量のファイルを読み取れません'],
  source_unavailable: ['The provider and session record are unavailable', '提供元と会話の記録から取得できません'],
  disconnected: ['The API is unavailable', 'API に接続できません'],
};
export function formatReason(reason: string | undefined, language: Language): string {
  return (REASONS[reason ?? ''] ?? REASONS.source_unavailable)[language === 'ja' ? 1 : 0];
}
export function formatWindow(label: string, language: Language): string {
  if (language === 'en') return label;
  return ({ Session: '今回', Week: '週', '5h': '5 時間', wk: '週' } as Record<string, string>)[label] ?? label.replace(/^Week /, '週 ');
}
