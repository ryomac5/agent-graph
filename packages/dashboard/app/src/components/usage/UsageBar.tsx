import { useEffect, useLayoutEffect, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationClient } from '../../pages/conversation/ConversationPage.tsx';
import type { Language } from '../../lib/i18n.ts';
import { ProviderMark } from '../RootViews.tsx';
import { Icon } from '../Icon.tsx';
import { PROVIDERS, NAMES, POLL_MS, MANUAL_MS, RETRY_MS, STALE_MS, getMostUsed, getUsageColor, formatReason, formatReset, formatWindow, type ProviderUsage } from './model.ts';
import './usage.css';

const PANEL_WIDTH = 340;
const PANEL_MARGIN = 8;

export function UsageBar({ client, language, visible = true, connected = true }: { client: ConversationClient; language: Language; visible?: boolean; connected?: boolean }) {
  const [providers, setProviders] = useState<ProviderUsage[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [manualAfter, setManualAfter] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: PANEL_MARGIN, bottom: PANEL_MARGIN, width: PANEL_WIDTH, maxHeight: 0 });
  const toggle = useRef<HTMLButtonElement>(null);
  const refresh = useRef<(force: boolean) => void>(() => {});
  const panelId = useId();
  const ja = language === 'ja';
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let next = 0;
    let failures = 0;
    let lastAttempt = -Infinity;
    let timer: ReturnType<typeof setTimeout>;
    const active = () => visible && connected && document.visibilityState === 'visible' && document.hasFocus();
    const schedule = () => { clearTimeout(timer); if (!disposed && active()) timer = setTimeout(() => void read(false), Math.max(0, next - Date.now())); };
    const read = async (force: boolean) => {
      if (!active() || pending || force && Date.now() - lastAttempt < MANUAL_MS) return;
      if (!force && Date.now() < next) { schedule(); return; }
      pending = true; lastAttempt = Date.now(); setBusy(true); setManualAfter(lastAttempt + MANUAL_MS);
      try {
        const ack = await client.command('usage.read', { force });
        if (disposed) return;
        const result = ack.result as { providers?: ProviderUsage[] } | undefined;
        if (!ack.ok || !Array.isArray(result?.providers)) throw new Error('disconnected');
        setProviders(result.providers);
        failures = result.providers.some(row => row.state === 'unavailable' || row.state === 'stale' && row.reason !== 'old_value') ? failures + 1 : 0;
      } catch {
        if (disposed) return;
        failures++;
        setProviders(previous => PROVIDERS.map(id => {
          const prior = previous.find(row => row.id === id);
          return { id, windows: prior?.windows ?? [], fetchedAt: prior?.fetchedAt ?? null, state: prior?.windows.length ? 'stale' : 'unavailable', reason: 'disconnected' };
        }));
      } finally {
        pending = false;
        if (!disposed) { setBusy(false); next = Date.now() + (failures ? Math.min(RETRY_MS * 2 ** Math.min(failures - 1, 10), POLL_MS) : POLL_MS); schedule(); }
      }
    };
    refresh.current = force => { void read(force); };
    const wake = () => { if (active()) void read(false); else clearTimeout(timer); };
    window.addEventListener('focus', wake); window.addEventListener('blur', wake); document.addEventListener('visibilitychange', wake);
    wake();
    return () => { disposed = true; clearTimeout(timer); window.removeEventListener('focus', wake); window.removeEventListener('blur', wake); document.removeEventListener('visibilitychange', wake); };
  }, [client, visible, connected]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(PANEL_WIDTH, Math.max(0, window.innerWidth - PANEL_MARGIN * 2));
      const edge = Math.min(window.innerHeight - PANEL_MARGIN, Math.max(PANEL_MARGIN, anchor.top - PANEL_MARGIN));
      setPosition({ left: Math.max(PANEL_MARGIN, Math.min(anchor.left + PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN)), bottom: window.innerHeight - edge, width, maxHeight: Math.max(0, edge - PANEL_MARGIN) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (root.current) observer.observe(root.current);
    window.addEventListener('resize', place); document.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const shown = PROVIDERS.map(id => {
    const row = providers.find(row => row.id === id) ?? { id, windows: [], fetchedAt: null, state: 'unavailable' as const, reason: 'disconnected' };
    return row.state === 'ok' && row.fetchedAt && now - Date.parse(row.fetchedAt) > STALE_MS ? { ...row, state: 'stale' as const, reason: 'old_value' } : row;
  });
  const used = (percent: number) => ja ? `${percent}% 使用済み` : `${percent}% used`;
  return <div className="usage-root" ref={root}>
    {open && createPortal(<section ref={panel} style={position} className="usage-panel" id={panelId} role="dialog" aria-label={ja ? '使用量の詳細' : 'Usage details'}>
      <header><span>{ja ? '使用量' : 'Usage'}</span><button className="icon-button" aria-label={ja ? '閉じる' : 'Close'} onClick={() => { setOpen(false); toggle.current?.focus(); }}><Icon name="x"/></button></header>
      {shown.map(provider => {
        const groups = [...new Set(provider.windows.map(row => row.group ?? ''))];
        return <section className="usage-provider" key={provider.id}>
          <div className="usage-provider-heading"><ProviderMark provider={provider.id}/><span>{NAMES[provider.id]}</span></div>
          {provider.state === 'unavailable' ? <p className="usage-reason">{ja ? '取得できません' : 'Unavailable'} · {formatReason(provider.reason, language)}</p> : <>
            {provider.state === 'stale' && <p className="usage-reason">{ja ? '古い値' : 'Stale value'} · {formatReason(provider.reason, language)}</p>}
            {groups.map(group => <div key={group} className="usage-group">{group && <p className="usage-group-name">{ja ? group === 'Gemini Models' ? 'Gemini モデル' : group === 'Claude and GPT models' ? 'Claude と GPT モデル' : group : group}</p>}
              {provider.windows.filter(row => (row.group ?? '') === group).map(row => <div className={`usage-window usage-${getUsageColor(row.usedPercent)}`} key={row.key}>
                <span className="usage-window-label">{formatWindow(row.label, language)}</span>
                <div role="progressbar" aria-label={`${NAMES[provider.id]} ${group} ${formatWindow(row.label, language)}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.usedPercent} className="usage-track"><span style={{ width: `${row.usedPercent}%` }}/></div>
                <span className="numeric" title={used(row.usedPercent)}>{row.usedPercent}%</span>
                <span className="usage-window-reset">{formatReset(row.resetsAt, now, language)}</span>
              </div>)}
            </div>)}
          </>}
        </section>;
      })}
    </section>, document.body)}
    <div className="usage-bar"><button ref={toggle} className="usage-summary" aria-label={ja ? '使用量の詳細' : 'Usage details'} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      {shown.map(provider => { const most = getMostUsed(provider.windows); return <span className={`usage-summary-item usage-${getUsageColor(most?.usedPercent ?? 0)}`} key={provider.id} title={`${NAMES[provider.id]}: ${provider.state === 'unavailable' ? formatReason(provider.reason, language) : `${used(most?.usedPercent ?? 0)}${provider.state === 'stale' ? ja ? ' · 古い値' : ' · Stale value' : ''}`}`}><ProviderMark provider={provider.id}/><span className="numeric">{most ? `${most.usedPercent}%` : '—'}{provider.state === 'stale' && <span className="usage-stale-dot" aria-label={ja ? '古い値' : 'Stale value'}> ·</span>}</span></span>; })}
    </button><button className="icon-button usage-refresh" aria-label={ja ? '使用量を再取得' : 'Refresh usage'} disabled={busy || now < manualAfter || !connected} onClick={() => refresh.current(true)}><Icon name="refresh"/></button></div>
  </div>;
}
