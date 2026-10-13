const EDITABLE = 'input, textarea';
const TEXT_INPUT_TYPES = new Set(['text', 'email', 'url', 'number', 'tel', 'password']);

function readValue(element: HTMLInputElement | HTMLTextAreaElement, original = false): string {
  return original ? element.defaultValue : element.value;
}

export function trackReloadInputs(document: Document) {
  const originals = new Map<HTMLInputElement | HTMLTextAreaElement, string>();
  const remember = (event: Event) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLInputElement | HTMLTextAreaElement>(EDITABLE) : null;
    if (!element || element.closest('[data-reload-ignore]') || originals.has(element)) return;
    if (element instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(element.type)) return;
    originals.set(element, readValue(element, ['input', 'change'].includes(event.type)));
  };
  // React が controlled の defaultValue を更新する前に、編集前の値を取る。
  const events = ['focusin', 'beforeinput', 'pointerdown', 'keydown', 'input', 'change'];
  for (const event of events) document.addEventListener(event, remember, true);
  return {
    isBlocked() {
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
        let visible = true;
        for (let element: HTMLElement | null = dialog; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (element.hidden || element.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') { visible = false; break; }
        }
        if (visible) return true;
      }
      for (const [element, original] of originals) {
        if (!element.isConnected) { originals.delete(element); continue; }
        if (element.closest('[data-reload-ignore]')) { originals.delete(element); continue; }
        const draftKey = element.dataset.conversationDraft;
        if (draftKey !== undefined) {
          try { if ((sessionStorage.getItem('agent-graph-conversation-draft:' + draftKey) ?? '') === readValue(element)) continue; }
          catch { /* 保存を確かめられない本文は、通常の入力と同じく保護する。 */ }
        }
        if (readValue(element) !== original) return true;
      }
      return false;
    },
    dispose() { for (const event of events) document.removeEventListener(event, remember, true); originals.clear(); },
  };
}
