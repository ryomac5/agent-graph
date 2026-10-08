import { useEffect, useRef, useState } from 'react';
import { AppLink } from '../AppLink.tsx';
import { Icon, type IconName } from '../Icon.tsx';
import { approvalOutcome, formatClock } from '../../lib/format.ts';
import { OUTCOME_LABELS, OutcomeIcon } from '../ApprovalRequest.tsx';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { store, useScreenStore, type ScreenStore, type ScreenState } from '../../lib/store.ts';
import { ApprovalActions } from '../../pages/inbox/Inbox.tsx';
import { getInbox, isPending, type CommandClient } from '../../pages/inbox/model.ts';
import { collectNotifications, loadPreferences, NOTIFICATION_KINDS, notificationLabel, notificationDetail, PREFERENCES_KEY,
  type Notice, type NotificationMode } from './model.ts';

const NOTICE_LIMIT = 100;
export interface NotificationsProps { client: CommandClient; target?: ScreenStore; initiallyOpen?: boolean; compact?: boolean; language?: Language }
export function Notifications({ client, target = store, initiallyOpen = true, compact = false, language = 'en' }: NotificationsProps) {
  const state = useScreenStore(target);
  const text = (en: string, ja: string) => language === 'ja' ? ja : en;
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
    const updates = collectNotifications(previous.current, state, language);
    previous.current = state;
    const visible: Notice[] = [];
    for (const update of updates) {
      const notice = { ...update, id: `${update.id}:${++occurrence.current}` };
      const mode = preferences[notice.kind];
      if (mode === 'silent') continue;
      visible.push(notice);
      if (mode === 'browser' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const notification = new Notification(notificationLabel(notice.kind, language), { body: notificationDetail(notice, state, language), tag: notice.id, silent: true });
          browserNotices.current.add(notification);
          notification.onclose = () => browserNotices.current.delete(notification);
          notification.onclick = () => { setOpen(true); setFocused(notice.id); notification.close(); };
        } catch { setError(text('Browser notification unavailable; notification shown here.', 'ブラウザー通知を表示できないため画面内に表示します')); }
      }
    }
    if (visible.length) setNotices(items => [...visible.reverse(), ...items].slice(0, NOTICE_LIMIT));
  }, [state, preferences, language]);
  useEffect(() => { if (open && focused) panel.current?.focus(); }, [open, focused]);
  useEffect(() => () => { for (const notification of browserNotices.current) notification.close(); }, []);
  async function changePreference(kind: typeof NOTIFICATION_KINDS[number], mode: NotificationMode) {
    setError('');
    const updated = { ...preferences, [kind]: mode };
    setPreferences(updated);
    try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(updated)); }
    catch { setError(text('Notification settings could not be saved.', '通知の設定を保存できません')); }
    if (mode === 'browser') {
      if (typeof Notification === 'undefined') { setError(text('Browser notifications are unavailable.', 'ブラウザー通知を利用できません')); return; }
      try {
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
        if (permission !== 'granted') setError(text('Browser notifications are blocked; notifications will appear here.', 'ブラウザー通知が許可されていないため画面内に表示します'));
      } catch { setError(text('Browser notification permission could not be requested.', '通知の許可を要求できません')); }
    }
  }
  const KIND_ICONS: Record<string, IconName> = { approval: 'alert', input: 'message', failed: 'alert', completed: 'check' };
  return <div className={compact ? 'notifications compact' : 'notifications'}>
    <button className={compact ? 'bell btn btn-ghost btn-sm' : 'btn btn-secondary btn-sm'} aria-label={dictionaries[language].notifications} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name="bell" size={16}/>
      {compact ? notices.length > 0 && <span className="bell-count numeric">{notices.length}</span> : `${dictionaries[language].notifications} (${notices.length})`}</button>
    {!compact && <AppLink className="btn btn-ghost btn-sm" to="/inbox">{text('Approvals', '承認待ち')}: {getInbox(state).pending.length}</AppLink>}
    {open && <section className={compact ? 'notification-panel popover' : 'notification-panel'} ref={panel} tabIndex={-1} aria-label={dictionaries[language].notifications} aria-live="polite">
      <header className="panel-header"><h2>{dictionaries[language].notifications}</h2>
        {notices.length > 0 && <button className="btn btn-link btn-sm" onClick={() => setNotices([])}>{text('Clear', 'すべて消す')}</button>}</header>
      <details className="disclosure settings-disclosure"><summary><Icon name="chevronRight" size={12} className="caret"/>{text('Settings', '設定')}</summary>
        <div className="settings-grid">{NOTIFICATION_KINDS.map(kind => <label key={kind}>
        <span>{notificationLabel(kind, language)}</span><select className="select-sm" value={preferences[kind]} onChange={event => void changePreference(kind, event.target.value as NotificationMode)}>
          <option value="in_app">{text('In app', '画面内')}</option><option value="browser">{text('Browser', 'ブラウザー')}</option><option value="silent">{text('Silent', '通知しない')}</option>
        </select></label>)}</div></details>
      {error && <p role="alert" className="status-line danger">{error}</p>}
      {notices.length === 0 && <p className="panel-empty"><Icon name="bell" size={16}/>{text('No notifications yet', '通知はありません')}</p>}
      <ol className="notice-list">{notices.map(notice => {
        const approval = state.projection.approvals?.find(row => row.id === notice.approvalId);
        return <li key={notice.id} data-kind={notice.kind} className={`notice notice-${notice.kind}`}>
          <div className="notice-head"><Icon name={KIND_ICONS[notice.kind] ?? 'bell'} size={14} className="notice-icon"/><h3>{notificationLabel(notice.kind, language)}</h3>
            {notice.time && <time dateTime={notice.time} title={notice.time}>{formatClock(notice.time, language)}</time>}
            <button className="icon-button" aria-label={`${text('Dismiss', '消す')} ${notificationLabel(notice.kind, language)}`} title={text('Dismiss', '消す')} onClick={() => setNotices(items => items.filter(item => item.id !== notice.id))}><Icon name="x" size={14}/></button></div>
          <p className="notice-detail">{notificationDetail(notice, state, language)}</p>
          {notice.conversationId && <AppLink className="btn btn-link btn-sm" to={`/c/${encodeURIComponent(notice.conversationId)}`}>{text('Conversation', '会話')}</AppLink>}
          {approval && <>
            {isPending(approval) ? <ApprovalActions row={approval} client={client} language={language}/>
              : <p className="status-line approval-outcome" data-outcome={approvalOutcome(approval)}><OutcomeIcon outcome={approvalOutcome(approval)}/>{language === 'ja' ? ({ pending: '承認待ち', answered: '送信しました', allowed: '許可済み', denied: '拒否済み', expired: '期限切れ', stale: '無効', resolved: '解決済み' })[approvalOutcome(approval)] : `Approval ${OUTCOME_LABELS[approvalOutcome(approval)].toLowerCase()}`}</p>}</>}
        </li>;
      })}</ol>
    </section>}
  </div>;
}
export default Notifications;
