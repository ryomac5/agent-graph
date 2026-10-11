import { useState } from 'react';
import type { Root } from '../lib/roots.ts';
import type { Ack } from '../lib/client.ts';
import type { Language } from '../lib/i18n.ts';

export interface RenameClient { command: (command: string, payload: unknown) => Promise<Ack> }
export function SessionName({ root, client, language = 'en', editing = false, onFinish }: {
  root: Root; client: RenameClient; language?: Language; editing?: boolean; onFinish?: () => void;
}) {
  const [active, setActive] = useState(editing);
  const [name, setName] = useState(root.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const label = language === 'ja' ? '名前を変更' : 'Rename';
  function finish() { setActive(false); setError(''); onFinish?.(); }
  async function save() {
    if (pending) return;
    setPending(true);
    try {
      const ack = await client.command('session.rename', { rootId: root.id, name: name.trim() });
      if (ack.ok) finish();
      else setError(language === 'ja' ? '名前を変更できませんでした' : 'Unable to rename');
    } catch { setError(language === 'ja' ? '名前を変更できませんでした' : 'Unable to rename'); }
    finally { setPending(false); }
  }
  if (!active) return <button type="button" className="session-name" title={root.user_name ? root.auto_name : undefined} aria-label={label} onClick={() => { setName(root.name); setActive(true); }}>{root.name}</button>;
  return <span className="session-name-editor"><input autoFocus aria-label={label} value={name} maxLength={80} disabled={pending}
    onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)}
    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(); } if (event.key === 'Escape') { event.preventDefault(); finish(); } }}/>
    {error && <span role="alert">{error}</span>}</span>;
}
