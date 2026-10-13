import { modelName } from '../../lib/format.ts';
import { shownRole } from '../../lib/roots.ts';
import type { PolicyPreview as Preview } from '../../lib/settings.ts';
import { translate } from './text.ts';

const EXAMPLE_LIMIT = 5;
export function PolicyPreview({ preview, language = 'en' }: { preview: Preview; language?: 'en' | 'ja' }) {
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  function describeModels(candidates: Preview['roleChanges'][number]['bands'][number]['before'], other: typeof candidates): string {
    return candidates.map((candidate, index) => `${modelName(candidate.model)}${candidate.effort && candidate.effort !== other[index]?.effort ? ` (${candidate.effort})` : ''}`).join(', ') || t('noCandidates');
  }
  function describeBands(bands: Preview['roleChanges'][number]['bands']): string {
    const changes = new Map<string, string[]>();
    for (const band of bands) {
      // 変わらない予備モデルと effort は繰り返さず、同じ変更は作業の重さをまとめる。
      const sameBackups = JSON.stringify(band.before.slice(1)) === JSON.stringify(band.after.slice(1));
      const before = sameBackups ? band.before.slice(0, 1) : band.before;
      const after = sameBackups ? band.after.slice(0, 1) : band.after;
      const change = `${describeModels(before, after)} → ${describeModels(after, before)}`;
      changes.set(change, [...(changes.get(change) ?? []), t(band.weight)]);
    }
    return [...changes].map(([change, weights]) => `${change}${weights.length === 3 ? '' : ` (${weights.join(' / ')})`}`).join('; ');
  }
  function describeWhen(timestamp: string | null): string {
    return timestamp && Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : t('timeUnknown');
  }
  return <div className="policy-preview">
    <ul className="policy-preview-summary" aria-label={t('assignmentChanges')}>
      {preview.roleChanges.map(change => <li key={change.role}><strong>{shownRole(change.role, language)}:</strong> {describeBands(change.bands)}</li>)}
    </ul>
    {!preview.roleChanges.length && <p className="settings-note">{t('noAssignmentChanges')}</p>}
    <p>{translate(language, 'impact', { total: preview.total, changed: preview.changed })}</p>
    {preview.changed === 0 ? <p>{t('noPastChanges')}</p> : <table>
      <caption>{t('examples')}</caption>
      <thead><tr><th scope="col">{t('request')}</th><th scope="col">{t('date')}</th><th scope="col">{t('role')}</th></tr></thead>
      <tbody>{preview.rows.slice(0, EXAMPLE_LIMIT).map(row => <tr key={row.id}>
        <td>{row.description || t('untitled')}</td>
        <td><time dateTime={row.timestamp ?? undefined}>{describeWhen(row.timestamp)}</time></td>
        <td>{shownRole(row.role, language)}</td>
      </tr>)}</tbody>
    </table>}
  </div>;
}
