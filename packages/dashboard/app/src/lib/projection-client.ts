import { compareEventOrder } from '../../../../core/src/ledger/event-order.ts';
import type { Row, ScreenStore } from './store.ts';
import { changesFiles } from './conversation-changes.ts';

export const MESSAGE_PAGE_SIZE = 200;
export type MessageCursor = { source_ts: string; source_event_id: string; id: string };
export interface ConversationPageData { generation: number; projection: Record<string, Row[]>; next: string | null; hasOlder?: boolean; olderCursor?: MessageCursor | null }
export function compareMessages(a: Row, b: Row): number {
  // 同じ時刻の発言は core と同じ順序で並べる。旧い Codex の行の位置は数として比べる。
  return String(a.source_ts ?? '').localeCompare(String(b.source_ts ?? ''))
    || compareEventOrder(String(a.source_event_id ?? ''), String(b.source_event_id ?? '')) || compareEventOrder(String(a.id), String(b.id));
}
export async function fetchProjection<T>(path: string, signal?: AbortSignal, base = window.location.origin, token?: string): Promise<T> {
  const response = await fetch(new URL(path, base), { signal, headers: {
    'x-agent-graph-token': token ?? document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content ?? '',
  } });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return response.json() as Promise<T>;
}
// 初回と巻き戻しは時刻順の窓を一つだけ取得する。
export async function loadConversationWindow(id: string, signal: AbortSignal, before?: Row, messageId?: string,
  fetchPage = (path: string) => fetchProjection<ConversationPageData>(path, signal)) {
  const params = new URLSearchParams({ id, ...(before ? { before: JSON.stringify({
    source_ts: String(before.source_ts ?? ''), source_event_id: String(before.source_event_id ?? ''), id: String(before.id),
  }) } : messageId ? { message: messageId } : { latest: '1' }) });
  const page = await fetchPage('/conversation?' + params);
  signal.throwIfAborted();
  return { generation: page.generation, projection: { messages: (page.projection.messages ?? []).toSorted(compareMessages).slice(-MESSAGE_PAGE_SIZE),
    message_memberships: page.projection.message_memberships ?? [], edit_messages: [] as Row[] },
    hasOlder: page.hasOlder ?? false, olderCursor: page.olderCursor ?? page.projection.messages?.toSorted(compareMessages)[0],
    conversation: page.projection.conversations?.[0] };
}

interface PrefetchedWindow {
  id: string; messageId?: string; controller: AbortController; readers: number;
  page: Promise<Awaited<ReturnType<typeof loadConversationWindow>> | undefined>;
}
const prefetchedWindows = new WeakMap<ScreenStore, Map<string, PrefetchedWindow>>();
/** snapshot による作業場の作り直しをまたいで、先行取得した窓を渡す。 */
export function prefetchConversationWindow(target: ScreenStore, id: string, messageId?: string, fetchPage?: (path: string, signal: AbortSignal) => Promise<ConversationPageData>) {
  let windows = prefetchedWindows.get(target);
  if (!windows) { windows = new Map(); prefetchedWindows.set(target, windows); }
  const key = JSON.stringify([id, messageId]);
  let window = windows.get(key);
  if (!window) {
    const controller = new AbortController();
    window = { id, messageId, controller, readers: 0, page: loadConversationWindow(id, controller.signal, undefined, messageId,
      fetchPage ? path => fetchPage(path, controller.signal) : undefined).catch(() => undefined) };
    windows.set(key, window);
  }
  window.readers++;
  const current = window;
  return () => {
    current.readers--;
    // 同じ React commit で差し替わる作業場には、取得中の窓を先に渡す。
    queueMicrotask(() => {
      if (current.readers === 0 && windows.get(key) === current) { windows.delete(key); current.controller.abort(); }
    });
  };
}
export function takePrefetchedConversationWindow(target: ScreenStore, id: string, messageId: string | undefined, signal: AbortSignal) {
  const windows = prefetchedWindows.get(target);
  const identities = target.getSnapshot().identities;
  for (const [key, window] of windows ?? []) {
    if ((identities?.conversations[window.id] ?? window.id) !== id || window.messageId !== messageId) continue;
    windows!.delete(key);
    const abort = () => window.controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return window.page.finally(() => signal.removeEventListener('abort', abort));
  }
}

// 変更ファイルの要求は本文の表示を待たせない。
export async function loadConversationEdits(id: string, signal: AbortSignal,
  fetchPage = (path: string) => fetchProjection<ConversationPageData>(path, signal)): Promise<Row[]> {
  const edits: Row[] = [];
  let after = '';
  do {
    const page = await fetchPage('/conversation?' + new URLSearchParams({ id, edits: '1', after }));
    signal.throwIfAborted();
    edits.push(...(page.projection.messages ?? []).filter(changesFiles));
    if (page.next === after) throw new Error('Unable to advance conversation changes');
    after = page.next ?? '';
  } while (after);
  return edits;
}
