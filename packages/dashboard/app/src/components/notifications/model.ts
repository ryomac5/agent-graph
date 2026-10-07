import type { ScreenState, Row } from '../../lib/store.ts';
import { getConversation, isPending, readText } from '../../pages/inbox/model.ts';

export const NOTIFICATION_KINDS = ['approval', 'input', 'failed', 'completed', 'review_invalidated', 'daemon_fault', 'unknown'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationMode = 'in_app' | 'browser' | 'silent';
export type NotificationPreferences = Record<NotificationKind, NotificationMode>;
export const PREFERENCES_KEY = 'agent-graph-notifications';
export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  approval: 'Approval pending', input: 'Input pending', failed: 'Run failed', completed: 'Run completed',
  review_invalidated: 'Review invalidated', daemon_fault: 'Daemon fault', unknown: 'Run unknown',
};
export interface Notice {
  id: string; kind: NotificationKind; title: string; detail: string;
  conversationId?: string; approvalId?: string; time: string;
}
export function loadPreferences(storage?: Pick<Storage, 'getItem'>): NotificationPreferences {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PREFERENCES_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch { /* ブラウザの設定が壊れていても既定値で表示する。 */ }
  return Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind,
    ['in_app', 'browser', 'silent'].includes(String(saved[kind])) ? saved[kind] : 'in_app'])) as NotificationPreferences;
}
export function collectNotifications(previous: ScreenState | undefined, next: ScreenState): Notice[] {
  const notices: Notice[] = [];
  function add(kind: NotificationKind, row: Row, detail: string, approvalId?: string) {
    notices.push({ id: JSON.stringify([kind, row.id, next.generation, next.seq]), kind,
      title: NOTIFICATION_LABELS[kind], detail, approvalId, conversationId: getConversation(row, next),
      time: readText(row.last_evidence_ts ?? row.source_ts ?? row.created_ts) });
  }
  for (const row of next.projection.approvals ?? []) {
    const before = previous?.projection.approvals?.find(entry => entry.id === row.id);
    if (isPending(row) && (!before || !isPending(before))) add('approval', row, readText(row.request), String(row.id));
    if (row.state === 'stale' && before?.state !== 'stale') add('review_invalidated', row, readText(row.reason));
  }
  for (const row of next.projection.runs ?? []) {
    const before = previous?.projection.runs?.find(entry => entry.id === row.id);
    if (before?.state === row.state) continue;
    if (row.state === 'waiting_input') add('input', row, readText(row.reason) || 'Waiting for your input.');
    if (row.state === 'unknown') add('unknown', row, `${readText(row.last_evidence)} · ${readText(row.last_evidence_ts)} · ${readText(row.reason)}`);
    // 初回の履歴取得を、新しく終了した実行として通知しない。
    const hasHistory = previous && Object.keys(previous.projection).length > 0;
    if (hasHistory && row.state === 'failed') add('failed', row, readText(row.cause));
    if (hasHistory && row.state === 'ended') add('completed', row, readText(row.end_evidence));
  }
  if ((next.connection === 'runner_unavailable' || next.connection === 'reconnecting') && previous?.connection !== next.connection) {
    add('daemon_fault', { id: next.connection }, next.connection === 'runner_unavailable' ? 'Runner unavailable' : 'API connection lost; reconnecting');
  }
  return notices;
}
