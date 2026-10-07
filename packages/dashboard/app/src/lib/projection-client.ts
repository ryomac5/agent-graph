import type { Row } from './store.ts';
import { readBody } from './message-body.ts';

export const MESSAGE_PAGE_SIZE = 200;
export interface ConversationPageData { generation: number; projection: Record<string, Row[]>; next: string | null }
export function compareMessages(a: Row, b: Row): number {
  return String(a.source_ts ?? '').localeCompare(String(b.source_ts ?? '')) || String(a.id).localeCompare(String(b.id));
}
export async function fetchProjection<T>(path: string, signal?: AbortSignal, base = window.location.origin, token?: string): Promise<T> {
  const response = await fetch(new URL(path, base), { signal, headers: {
    'x-agent-graph-token': token ?? document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content ?? '',
  } });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  return response.json() as Promise<T>;
}
// API は ID 順のページだけを配る。全本文を保持せず、時刻順の必要な窓だけを残す。
export async function loadConversationWindow(id: string, signal: AbortSignal, before?: Row, messageId?: string,
  fetchPage = (path: string) => fetchProjection<ConversationPageData>(path, signal)): Promise<{
    generation: number | undefined; projection: { messages: Row[]; message_memberships: Row[] };
    hasOlder: boolean; firstRequestExcerpt: string;
  }> {
  let after = '';
  let messages: Row[] = [];
  let memberships: Row[] = [];
  let hasOlder = false;
  let generation: number | undefined;
  let anchor: Row | undefined;
  let firstRequest: Row | undefined;
  // ホストが利用者の発言の前に差し込む AGENTS.md や skills の本文は、依頼の抜粋にしない。core の extractProvisionalName と同じ境界。
  const isInjected = (text: string) => /^(?:<[A-Za-z_][^>]*>|#{1,6}\s*(?:AGENTS|CLAUDE|README)\b|Review a delegated task\.|You are (?:an? |the ))/u.test(text);
  do {
    const page = await fetchPage(`/conversation?id=${encodeURIComponent(id)}&after=${encodeURIComponent(after)}`);
    signal.throwIfAborted();
    if (generation !== undefined && page.generation !== generation) throw new Error('Conversation changed. Please retry.');
    generation = page.generation;
    const incoming = page.projection.messages ?? [];
    for (const row of incoming) if (row.role === 'user' && readBody(row.body).trim() && !isInjected(readBody(row.body).trim())
      && (!firstRequest || compareMessages(row, firstRequest) < 0)) firstRequest = row;
    anchor ??= incoming.find(row => row.id === messageId);
    messages = [...new Map([...messages, ...incoming.filter(row => !before || compareMessages(row, before) < 0)].map(row => [String(row.id), row])).values()]
      .sort(compareMessages);
    if (messages.length > MESSAGE_PAGE_SIZE) { hasOlder = true; messages = messages.slice(-MESSAGE_PAGE_SIZE); }
    const selected = new Set(messages.map(row => row.id));
    memberships = [...memberships, ...(page.projection.message_memberships ?? [])].filter(row => selected.has(row.message_id));
    const next = page.next ?? '';
    if (next && next === after) throw new Error('Unable to advance conversation history');
    after = next;
  } while (after);
  if (anchor && !messages.some(row => row.id === anchor!.id)) {
    const context = await loadConversationWindow(id, signal, anchor, undefined, fetchPage);
    if (context.generation !== generation) throw new Error('Conversation changed. Please retry.');
    const preceding = context.projection.messages.slice(-(MESSAGE_PAGE_SIZE - 1));
    const selected = new Set(preceding.map(row => row.id));
    messages = [...preceding, anchor];
    memberships = [...context.projection.message_memberships.filter(row => selected.has(row.message_id)),
      { id: `search:${anchor.id}`, conversation_id: id, message_id: anchor.id, active: 1 }];
    hasOlder = context.hasOlder || context.projection.messages.length > preceding.length;
  }
  return { generation, projection: { messages, message_memberships: memberships }, hasOlder,
    firstRequestExcerpt: firstRequest ? readBody(firstRequest.body).trim().split(/\n|(?<=[。.!?？！])/u)[0].slice(0, 120) : '' };
}
