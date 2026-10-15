import { useLayoutEffect, useRef, useState } from 'react';

const DRAFT_PREFIX = 'agent-graph-conversation-draft:';
function readDraft(key: string): string {
  try { return sessionStorage.getItem(DRAFT_PREFIX + key) ?? ''; }
  catch { return ''; }
}
function saveDraft(key: string, text: string) {
  try {
    if (text) sessionStorage.setItem(DRAFT_PREFIX + key, text);
    else sessionStorage.removeItem(DRAFT_PREFIX + key);
  } catch { /* 保存できなくても入力と送信は続ける。 */ }
}
export function useConversationDraft(key: string, seriesIds: readonly string[] = []) {
  // 分岐前の書きかけを現在の操作先へ移し、送信済みの文を古いキーに残さない。
  if (!readDraft(key)) {
    const previous = seriesIds.find(id => id !== key && readDraft(id));
    if (previous) { saveDraft(key, readDraft(previous)); saveDraft(previous, ''); }
  }
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [draft, setDraft] = useState(() => ({ key, text: readDraft(key) }));
  const input = draft.key === key ? draft.text : readDraft(key);
  useLayoutEffect(() => { setDraft(previous => previous.key === key ? previous : { key, text: readDraft(key) }); }, [key]);
  function setInput(value: string | ((previous: string) => string)) {
    const text = typeof value === 'function' ? value(input) : value;
    // 読み直しが effect より先に起きても書きかけを残す。
    saveDraft(key, text);
    setDraft({ key, text });
  }
  function clearSentDraft(sentKey: string, sent: string) {
    if (readDraft(sentKey) === sent) saveDraft(sentKey, '');
    if (mounted.current) setDraft(previous => previous.key === sentKey && previous.text === sent ? { key: sentKey, text: '' } : previous);
  }
  return [input, setInput, clearSentDraft] as const;
}
