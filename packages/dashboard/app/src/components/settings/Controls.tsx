import { useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from '../../lib/escape-layers.ts';

export function Segments({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange(value: string): void }) {
  return <div className="settings-segments" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}
export function SettingMenu({ label, value, options, onChange, displayLabel }: { label: string; value: string; options: { value: string; label: string }[]; onChange(value: string): void; displayLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEscapeLayer(open, () => { setOpen(false); trigger.current?.focus(); });
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="settings-menu" ref={ref} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    if (open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); const rows = [...ref.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')];
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[(index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  }}><button ref={trigger} type="button" className="btn btn-ghost" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>{displayLabel ?? options.find(option => option.value === value)?.label ?? value}<span aria-hidden="true">▾</span></button>
    {open && <div role="listbox" aria-label={label} className="settings-menu-options">{options.map(option => <button type="button" role="option" aria-selected={value === option.value} key={option.value} onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus(); }}>{option.label}</button>)}</div>}
  </div>;
}
