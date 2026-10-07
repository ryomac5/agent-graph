import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_KEYS, KEY_LABELS, validateBindings, type KeyBindings } from '../../lib/keys.ts';
import type { SettingsClient, SettingsSnapshot } from '../../lib/settings.ts';
export interface Command { id: string; name: string; run(): void; disabled?: boolean }
const KEY_REFRESH_MS = 1500;
export function CommandDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>('input, textarea, select') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="command-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="command-dialog" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const controls = [...ref.current!.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0 || !event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0]?.focus(); }
      }
    }}><header className="button-row"><h2>{title}</h2><span className="spacer"/><button className="btn btn-ghost" onClick={onClose}>Close</button></header>{children}</div>
  </div>;
}
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const matches = commands.filter(command => query.toLowerCase().trim().split(/\s+/).every(word => command.name.toLowerCase().includes(word)));
  function execute(command: Command) { if (!command.disabled) { onClose(); command.run(); } }
  const enabled = matches.filter(command => !command.disabled);
  const selected = enabled[Math.min(index, Math.max(0, enabled.length - 1))];
  useEffect(() => {
    if (selected) document.getElementById(`command-${selected.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return <CommandDialog title="Search and commands" onClose={onClose}>
    <input aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="command-results" aria-activedescendant={selected ? `command-${selected.id}` : undefined} value={query}
      onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(previous => enabled.length ? (previous + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length : 0); }
        if (event.key === 'Enter' && selected) { event.preventDefault(); execute(selected); }
      }}/>
    <ul id="command-results" role="listbox" aria-label="Commands">{matches.map(command => <li key={command.id} id={`command-${command.id}`} role="option" aria-selected={selected === command} aria-disabled={command.disabled}><button className="btn btn-ghost" disabled={command.disabled} onClick={() => execute(command)}>{command.name}</button></li>)}</ul>
    {!matches.length && <p role="status">No commands found</p>}
  </CommandDialog>;
}
export function useKeySettings(client: SettingsClient) {
  const [bindings, updateBindings] = useState<KeyBindings>(DEFAULT_KEYS);
  const revision = useRef(0);
  const setBindings = useCallback((value: KeyBindings) => { revision.current += 1; updateBindings(value); }, []);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      const startedRevision = revision.current;
      try {
        const ack = await client.command('settings.read');
        const snapshot = ack.result as SettingsSnapshot | undefined;
        if (!disposed && startedRevision === revision.current && ack.ok && snapshot?.config?.keys) {
          const next = validateBindings(snapshot.config.keys);
          updateBindings(previous => Object.keys(DEFAULT_KEYS).every(key => previous[key as keyof KeyBindings] === next[key as keyof KeyBindings]) ? previous : next);
        }
      } catch { /* 最後に確認できた割り当てを保つ。 */ }
      finally { pending = false; }
    }
    void refresh();
    const timer = setInterval(refresh, KEY_REFRESH_MS);
    return () => { disposed = true; clearInterval(timer); };
  }, [client]);
  return { bindings, setBindings };
}
export function KeyboardSettings({ bindings, client, onSave }: { bindings: KeyBindings; client: SettingsClient; onSave(value: KeyBindings): void }) {
  const [draft, setDraft] = useState(bindings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { if (!dirty) setDraft(bindings); }, [bindings, dirty]);
  async function save() {
    setBusy(true); setMessage('');
    try {
      const keys = validateBindings(draft);
      const ack = await client.command('settings.write', { store: 'config', patch: { keys } });
      if (!ack.ok) throw new Error(ack.error ?? 'Settings operation failed');
      onSave(keys); setDirty(false); setMessage('Saved');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section aria-label="Keyboard shortcuts" className="settings-card"><h2>Keyboard shortcuts</h2><p>config.toml [keys] · Applies immediately. Duplicate bindings are rejected.</p>
    {Object.entries(draft).map(([key, value]) => <label key={key}><span>{KEY_LABELS[key as keyof KeyBindings]}</span><input aria-label={`keys · ${key}`} value={value} disabled={busy} onChange={event => { setDirty(true); setDraft(previous => ({ ...previous, [key]: event.target.value })); }}/></label>)}
    <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save keyboard shortcuts</button>{message && <p role={message === 'Saved' ? 'status' : 'alert'}>{message}</p>}
  </section>;
}
