import { useEffect, useRef } from 'react';
import { readTitle } from './format.ts';
import { loadConversationWindow } from './projection-client.ts';
import type { ScreenState, ScreenStore } from './store.ts';
import type { Activity } from '../components/activity.ts';
import type { ConversationClient } from '../pages/conversation/ConversationPage.tsx';

export function useProvisionalNames(state: ScreenState, target: ScreenStore, visible: Activity[], client?: ConversationClient) {
  const tasks = new Map((state.projection.tasks ?? []).map(row => [row.id, row]));
  const conversations = new Map((state.projection.conversations ?? []).map(row => [row.id, row]));
  const ids = visible.flatMap(item => {
    const conversation = conversations.get(item.conversationId);
    return item.conversationId && !readTitle(tasks.get(conversation?.task_id)?.name) && !readTitle(conversation?.name)
      && !conversation?.first_request_excerpt && !item.messages.some(row => row.role === 'user') ? [item.conversationId] : [];
  });
  const key = JSON.stringify([...new Set(ids)]);
  // 一度取りに行った会話は、一覧が変わっても取り直さない。失敗は会話を開いたときに出す。
  const attempted = useRef({ generation: state.generation, ids: new Set<string>() });
  if (attempted.current.generation !== state.generation) attempted.current = { generation: state.generation, ids: new Set() };
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      for (const id of JSON.parse(key) as string[]) {
        if (attempted.current.ids.has(id)) continue;
        attempted.current.ids.add(id);
        try {
          const page = await loadConversationWindow(id, controller.signal, undefined, undefined,
            client?.fetchConversation ? path => client.fetchConversation!(path, controller.signal) : undefined);
          if (controller.signal.aborted || page.generation !== target.getSnapshot().generation) { attempted.current.ids.delete(id); return; }
          target.recordFirstRequest(id, page.firstRequestExcerpt);
        } catch {
          // 名前を取得できない会話も一覧に残す。会話を開いた際に再取得とエラー表示を行う。
          if (controller.signal.aborted) { attempted.current.ids.delete(id); return; }
        }
      }
    })();
    return () => controller.abort();
  }, [key, state.generation, target, client]);
}
