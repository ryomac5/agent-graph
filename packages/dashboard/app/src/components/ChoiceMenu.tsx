import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';

export interface MenuChoice { value: string; label: ReactNode; title?: string; detail?: string; older?: boolean; disabled?: boolean }
export function ChoiceMenu({ label, name, value, choices, onChange, disabled, width = 200, footer, note, olderLabel }: {
  label: ReactNode; name: string; value: string; choices: MenuChoice[]; onChange: (value: string) => void;
  disabled?: boolean; width?: number; footer?: ReactNode; note?: string; olderLabel?: string;
}) {
  const id = useId(); const trigger = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const [older, setOlder] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0 });
  const choiceKeys = choices.map(choice => choice.value).join("\n");
  const visible = choices.filter(choice => older || !choice.older);
  function close() { setOpen(false); setOlder(false); trigger.current?.focus(); }
  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 4 });
    const rows = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'));
    (rows.find(row => row.getAttribute('aria-checked') === 'true') ?? rows[0] ?? panel.current)?.focus();
  }, [open, width, choiceKeys]);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) { setOpen(false); setOlder(false); } }
    function dismiss() { setOpen(false); setOlder(false); }
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="btn btn-ghost btn-sm choice-trigger" aria-label={name} title={name} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => open ? close() : setOpen(true)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>{label}<Icon name="chevronDown" size={12}/></button>
    {open && createPortal(<div ref={panel} id={id} tabIndex={-1} role="menu" aria-label={name} className="choice-menu" style={{ width, left: position.left, bottom: position.bottom }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const rows = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = rows.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    }}>
      {note && <div className="choice-note">{note}</div>}
      <div className="choice-options">{visible.map(choice => <button type="button" key={choice.value} role="menuitemradio" aria-checked={value === choice.value} data-value={choice.value} disabled={choice.disabled} title={choice.title} className="choice-option" onClick={() => { onChange(choice.value); if (!footer) close(); }}>
        <span className="truncate">{choice.label}</span>{choice.detail && <span className="choice-detail">{choice.detail}</span>}
      </button>)}{olderLabel && choices.some(choice => choice.older) && <button type="button" className="choice-option choice-older" aria-expanded={older} onClick={() => setOlder(current => !current)}>{olderLabel}<Icon name={older ? 'chevronDown' : 'chevronRight'} size={12}/></button>}</div>
      {footer && <div className="choice-footer" onClick={event => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) close(); }}>{footer}</div>}
    </div>, document.body)}
  </>;
}
