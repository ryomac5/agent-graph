import type { Language } from '../lib/i18n.ts';

export function LoadingFeature({ language = 'en' }: { language?: Language }) {
  return <p className="status-line" role="status">{language === 'ja' ? '読み込み中…' : 'Loading…'}</p>;
}
