import { useEffect, useRef, useState } from 'react';
import type { FilesClient, FilesRequest } from '../../pages/files/model.ts';
import type { Language } from '../../lib/i18n.ts';
import './document.css';
export const PREVIEW_DEBOUNCE_MS = 500;
export function HtmlDocument({ client, request, content, language = 'en' }: { client: FilesClient; request: FilesRequest; content?: string; language?: Language }) {
  const [preview, setPreview] = useState<{ url: string; expiresAt: number | string }>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const { projectId, worktree, path } = request;
  const key = JSON.stringify([projectId, worktree ?? '', path]);
  const currentKey = useRef(key);
  const ja = language === 'ja';
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    if (currentKey.current !== key) { currentKey.current = key; setPreview(undefined); }
    const timer = setTimeout(() => {
      void client.command('files.preview', { projectId, ...(worktree ? { worktree } : {}), path, ...(content !== undefined ? { content } : {}) }).then(ack => {
        if (cancelled) return;
        if (!ack.ok) throw new Error(ack.error ?? 'not_previewable');
        const result = ack.result as { url?: string; expiresAt?: number | string } | undefined;
        if (!result?.url?.startsWith('/preview/') || result.url.includes('\\') || !result.expiresAt) throw new Error('not_previewable');
        setPreview({ url: result.url, expiresAt: result.expiresAt }); setLoading(false);
      }).catch(error => { if (!cancelled) { setError(String(error.message ?? error)); setLoading(false); } });
    }, content === undefined ? 0 : PREVIEW_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, projectId, worktree, path, content, revision, key]);
  return <div className="html-surface"><div className="document-toolbar">
    <button className="btn btn-ghost" onClick={() => setRevision(value => value + 1)}>{ja ? '再読み込み' : 'Reload'}</button>
    {preview && <a className="btn btn-ghost" href={preview.url} target="_blank" rel="noopener noreferrer">{ja ? '新しいタブで開く' : 'Open in new tab'}</a>}
  </div>{loading && <p role="status">{ja ? '読み込み中' : 'Loading…'}</p>}{error && <p role="alert">{ja ? '表示できません' : 'Unable to display preview'}: {error}</p>}
    {preview && <iframe title={ja ? 'HTML の表示' : 'HTML preview'} src={preview.url} sandbox="allow-scripts allow-popups allow-forms"/>}
  </div>;
}
