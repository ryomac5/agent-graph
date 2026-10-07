export const DEFAULT_KEYS = { command: 'Cmd+K', home: 'g h', workspace: 'g w', inbox: 'g i', tree: 'g t', changes: 'g c', next: 'j', previous: 'k', allow: 'a', deny: 'd', interrupt: 'Esc', help: '?' };
export type KeyAction = keyof typeof DEFAULT_KEYS;
export type KeyBindings = Record<KeyAction, string>;
export const KEY_LABELS: Record<KeyAction, string> = { command: 'Search and commands', home: 'Go to Overview', workspace: 'Go to workspace', inbox: 'Go to approval inbox', tree: 'Go to delegation tree', changes: 'Go to Changes', next: 'Next row', previous: 'Previous row', allow: 'Allow approval', deny: 'Deny approval', interrupt: 'Interrupt run', help: 'Keyboard shortcuts' };
export const SEQUENCE_TIMEOUT_MS = 1000;
function normalizeStroke(value: string): string {
  const parts = value.toLowerCase().split('+').map(part => part.trim());
  const key = parts.pop()!.replace(/^esc$/, 'escape');
  const modifiers = parts.map(part => ({ cmd: 'meta', command: 'meta', control: 'ctrl', option: 'alt' })[part] ?? part);
  if (new Set(modifiers).size !== modifiers.length) throw new Error('Invalid key binding');
  return [...modifiers.filter(part => key !== '?' || part !== 'shift').sort(), key].join('+');
}
export function normalizeBinding(value: string): string { return value.trim().split(/\s+/).map(normalizeStroke).join(' '); }
export function validateBindings(value: Record<string, string>): KeyBindings {
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_KEYS, key)) || Object.values(value).some(binding => typeof binding !== 'string')) throw new Error('Invalid key binding');
  const bindings = { ...DEFAULT_KEYS, ...value };
  const seen: string[] = [];
  for (const binding of Object.values(bindings)) {
    const normalized = normalizeBinding(binding);
    if (!normalized || normalized.split(' ').some(stroke => !/^(?:(?:alt|ctrl|meta|shift)\+)*(?:[^+\s]|escape|enter|tab|space|backspace|delete|home|end|pageup|pagedown|arrowup|arrowdown|arrowleft|arrowright|f\d{1,2})$/.test(stroke))) throw new Error('Invalid key binding');
    if (seen.some(previous => previous === normalized || previous.startsWith(`${normalized} `) || normalized.startsWith(`${previous} `))) throw new Error('Duplicate key binding');
    seen.push(normalized);
  }
  return bindings;
}
export function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}
export function createKeyHandler(bindings: KeyBindings, execute: (action: KeyAction) => void) {
  const entries = (Object.entries(bindings) as [KeyAction, string][]).map(([action, binding]) => [action, normalizeBinding(binding)] as const);
  let sequence = '';
  let last = 0;
  return (event: KeyboardEvent): boolean => {
    if (event.repeat || event.isComposing || event.key === 'Dead') { sequence = ''; return false; }
    const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
    if (['meta', 'control', 'alt', 'shift'].includes(key)) return false;
    const stroke = [...(event.altKey ? ['alt'] : []), ...(event.ctrlKey ? ['ctrl'] : []), ...(event.metaKey ? ['meta'] : []), ...(event.shiftKey && key !== '?' ? ['shift'] : []), key].join('+');
    if (isTextInput(event.target) && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) { sequence = ''; return false; }
    const now = Date.now();
    const candidate = sequence && now - last < SEQUENCE_TIMEOUT_MS ? `${sequence} ${stroke}` : stroke;
    const match = entries.find(([, binding]) => binding === candidate) ?? entries.find(([, binding]) => binding === stroke);
    sequence = ''; last = now;
    if (match) { execute(match[0]); return true; }
    if (entries.some(([, binding]) => binding.startsWith(`${candidate} `))) { sequence = candidate; return true; }
    if (entries.some(([, binding]) => binding.startsWith(`${stroke} `))) { sequence = stroke; return true; }
    return false;
  };
}
