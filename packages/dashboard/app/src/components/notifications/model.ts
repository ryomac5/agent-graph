import type { ScreenState, Row } from '../../lib/store.ts';
import { getConversation, isPending, readText } from '../../pages/inbox/model.ts';
import { conversationName } from '../../lib/format.ts';
import { selectRoots } from '../../lib/roots.ts';
import type { Language } from '../../lib/i18n.ts';

export const NOTIFICATION_KINDS = ['approval', 'input', 'failed', 'completed'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];
export type NotificationMode = 'in_app' | 'browser' | 'silent';
export type NotificationPreferences = Record<NotificationKind, NotificationMode>;
export const PREFERENCES_KEY = 'agent-graph-notifications';
export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  approval: 'Approval pending', input: 'Input pending', failed: 'Run failed', completed: 'Run completed',
};
export const NOTIFICATION_LABELS_JA: Record<NotificationKind, string> = {
  approval: '承認待ち', input: '返答待ち', failed: '失敗', completed: '完了',
};
export function notificationLabel(kind: NotificationKind, language: Language): string {
  return (language === 'ja' ? NOTIFICATION_LABELS_JA : NOTIFICATION_LABELS)[kind];
}
export function notificationDetail(notice: Notice, state: ScreenState, language: Language): string {
  const name = selectRoots(state).find(root => root.conversation_ids.includes(notice.conversationId ?? ''))?.name
    || conversationName(state, notice.conversationId ?? '') || (language === 'ja' ? '会話' : 'Conversation');
  const events = language === 'ja' ? { approval: '承認を待っています', input: '返答を待っています', failed: '失敗しました', completed: '完了しました' }
    : { approval: 'is waiting for approval', input: 'is waiting for a reply', failed: 'failed', completed: 'completed' };
  return language === 'ja' ? name + 'は' + events[notice.kind] + '。' : name + ' ' + events[notice.kind] + '.';
}
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
const RECENT_MS = 2 * 60_000;
export function collectNotifications(previous: ScreenState | undefined, next: ScreenState, language: Language = 'en', now = Date.now()): Notice[] {
  const notices: Notice[] = [];
  function add(kind: NotificationKind, row: Row, approvalId?: string) {
    const notice: Notice = { id: JSON.stringify([kind, row.id, next.generation, next.seq]), kind,
      title: NOTIFICATION_LABELS[kind], detail: '', approvalId, conversationId: getConversation(row, next),
      time: readText(row.requested_ts ?? row.ended_ts ?? row.last_evidence_ts ?? row.source_ts ?? row.created_ts) };
    notice.title = notificationLabel(kind, language); notice.detail = notificationDetail(notice, next, language);
    notices.push(notice);
  }
  for (const row of next.projection.approvals ?? []) {
    const before = previous?.projection.approvals?.find(entry => entry.id === row.id);
    if (isPending(row) && (!before || !isPending(before))) add('approval', row, String(row.id));
  }
  for (const row of next.projection.runs ?? []) {
    const before = previous?.projection.runs?.find(entry => entry.id === row.id);
    if (before?.state === row.state) continue;
    // 一覧を後から読み足した古い行は、いま起きた変化ではない。前から知っている行か、直前に動いた行だけを通知する。
    const changed = Date.parse(readText(row.last_evidence_ts ?? row.ended_ts ?? row.started_ts));
    if (!before && !(Number.isFinite(changed) && now - changed < RECENT_MS)) continue;
    if (row.state === 'waiting_input') add('input', row);
    if (row.state === 'waiting_approval' && !(next.projection.approvals ?? []).some(a => a.run_id === row.id && isPending(a))) add('approval', row);
    // 初回の履歴取得を、新しく終了した実行として通知しない。
    const hasHistory = previous && Object.keys(previous.projection).length > 0;
    if (hasHistory && row.state === 'failed') add('failed', row);
    if (hasHistory && row.state === 'ended') add('completed', row);
  }
  return notices;
}
