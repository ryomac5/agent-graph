const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function readValue(element: HTMLElement, original = false): string {
  if (element instanceof HTMLInputElement) {
    if (['checkbox', 'radio'].includes(element.type)) return String(original ? element.defaultChecked : element.checked);
    return original ? element.defaultValue : element.value;
  }
  if (element instanceof HTMLTextAreaElement) return original ? element.defaultValue : element.value;
  if (element instanceof HTMLSelectElement) return original
    ? [...element.options].filter(option => option.defaultSelected).map(option => option.value).join('\n')
    : [...element.selectedOptions].map(option => option.value).join('\n');
  return element.textContent ?? '';
}

export function trackReloadInputs(document: Document) {
  const originals = new Map<HTMLElement, string>();
  const remember = (event: Event) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(EDITABLE) : null;
    if (!element || originals.has(element)) return;
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
