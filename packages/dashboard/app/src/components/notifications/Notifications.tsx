import { useEffect, useRef, useState } from 'react';
import { AppLink } from '../AppLink.tsx';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { store, useScreenStore, type ScreenStore, type ScreenState } from '../../lib/store.ts';
import { ApprovalActions, ApprovalDetails } from '../../pages/inbox/Inbox.tsx';
import { getInbox, isPending, type CommandClient } from '../../pages/inbox/model.ts';
import { collectNotifications, loadPreferences, NOTIFICATION_KINDS, NOTIFICATION_LABELS, PREFERENCES_KEY,
  type Notice, type NotificationMode } from './model.ts';

const NOTICE_LIMIT = 100;
export interface NotificationsProps { client: CommandClient; target?: ScreenStore; initiallyOpen?: boolean; compact?: boolean; language?: Language }
export function Notifications({ client, target = store, initiallyOpen = true, compact = false, language = 'en' }: NotificationsProps) {
  const state = useScreenStore(target);
  const previous = useRef<ScreenState | undefined>(undefined);
  const occurrence = useRef(0);
  const browserNotices = useRef(new Set<Notification>());
  const [preferences, setPreferences] = useState(() => loadPreferences(typeof localStorage === 'undefined' ? undefined : localStorage));
  const [notices, setNotices] = useState<Notice[]>([]);
  const [open, setOpen] = useState(initiallyOpen);
  const [error, setError] = useState('');
  const [focused, setFocused] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const updates = collectNotifications(previous.current, state);
    previous.current = state;
    const visible: Notice[] = [];
    for (const update of updates) {
      const notice = { ...update, id: `${update.id}:${++occurrence.current}` };
      const mode = preferences[notice.kind];
      if (mode === 'silent') continue;
      visible.push(notice);
      if (mode === 'browser' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const notification = new Notification(notice.title, { body: notice.detail, tag: notice.id, silent: true });
          browserNotices.current.add(notification);
          notification.onclose = () => browserNotices.current.delete(notification);
          notification.onclick = () => { setOpen(true); setFocused(notice.id); notification.close(); };
        } catch { setError('Browser notification unavailable; notification shown here.'); }
      }
    }
    if (visible.length) setNotices(items => [...visible.reverse(), ...items].slice(0, NOTICE_LIMIT));
  }, [state, preferences]);
  useEffect(() => { if (open && focused) panel.current?.focus(); }, [open, focused]);
  useEffect(() => () => { for (const notification of browserNotices.current) notification.close(); }, []);
  async function changePreference(kind: typeof NOTIFICATION_KINDS[number], mode: NotificationMode) {
    setError('');
    const updated = { ...preferences, [kind]: mode };
    setPreferences(updated);
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated)); }
    catch { setError('Notification settings could not be saved.'); }
    if (mode === 'browser') {
      if (typeof Notification === 'undefined') { setError('Browser notifications are unavailable.'); return; }
      try {
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (permission !== 'granted') setError('Browser notifications are blocked; notifications will appear here.');
      } catch { setError('Browser notification permission could not be requested.'); }
    }
  }
  return <div className="notifications">
    <button className={compact ? 'bell' : undefined} aria-label={dictionaries[language].notifications} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {compact && <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>}
      {compact ? notices.length : `${dictionaries[language].notifications} (${notices.length})`}</button>
    {!compact && <AppLink to="/inbox">Pending approvals: {getInbox(state).pending.length}</AppLink>}
    {open && <section className={compact ? 'notification-panel' : undefined} ref={panel} tabIndex={-1} aria-label={dictionaries[language].notifications} aria-live="polite">
      <h2>{dictionaries[language].notifications}</h2>
      <details><summary>Notification settings</summary>{NOTIFICATION_KINDS.map(kind => <label key={kind} style={{ display: 'block' }}>
        {NOTIFICATION_LABELS[kind]}<select value={preferences[kind]} onChange={event => void changePreference(kind, event.target.value as NotificationMode)}>
          <option value="in_app">In app</option><option value="browser">Browser</option><option value="silent">Silent</option>
        </select></label>)}</details>
      {error && <p role="alert">{error}</p>}
      {notices.length === 0 && <p>No notifications yet</p>}
      <ol>{notices.map(notice => {
        const approval = state.projection.approvals?.find(row => row.id === notice.approvalId);
        return <li key={notice.id} data-kind={notice.kind} style={notice.kind === 'unknown' ? { border: '1px dashed gray' } : undefined}>
          <h3>{notice.title}</h3><pre style={{ whiteSpace: 'pre-wrap' }}>{notice.detail}</pre>
          {notice.time && <time dateTime={notice.time}>{notice.time}</time>}
          {notice.conversationId && <AppLink to={`/c/${encodeURIComponent(notice.conversationId)}`}>Evidence</AppLink>}
          {approval && <><ApprovalDetails row={approval} state={state}/>
            {isPending(approval) ? <ApprovalActions row={approval} client={client}/>
              : <p>Approval {String(approval.state)}</p>}</>}
          <button aria-label={`Dismiss ${notice.title}`} onClick={() => setNotices(items => items.filter(item => item.id !== notice.id))}>Dismiss</button>
        </li>;
      })}</ol>
    </section>}
  </div>;
}
export default Notifications;
