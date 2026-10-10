import type { ReactNode } from 'react';
import type { Language } from '../../lib/i18n.ts';
import './document.css';

export function DocumentToolbar({ raw, onRaw, html = false, dirty = false, language = 'en', actions, label }: {
  raw: boolean; onRaw: (raw: boolean) => void; html?: boolean; dirty?: boolean; language?: Language; actions?: ReactNode; label?: string;
}) {
  const ja = language === 'ja';
  return <div className="viewer-mode document-toolbar" role="group" aria-label={label ?? (ja ? 'ファイルの表示' : 'File view')}>
    <button className="viewer-mode-option" aria-pressed={!raw} onClick={() => onRaw(false)}>{html ? ja ? '表示' : 'Display' : ja ? 'プレビュー' : 'Preview'}</button>
    <button className="viewer-mode-option" aria-pressed={raw} onClick={() => onRaw(true)}>{ja ? '原文' : 'Raw'}</button>
    {dirty && <span className="document-draft" role="status" title={ja ? '未保存の編集を表示中' : 'Showing unsaved edits'}>{ja ? '未保存' : 'Unsaved'}</span>}
    <span className="document-toolbar-actions">{actions}</span>
  </div>;
}
