import { formatModelName } from '../../lib/format.ts';
import { readObject, readText } from './model.ts';
import type { DefaultSource } from '../../lib/settings.ts';

export interface ComposerModel { model: string; displayName: string; effort?: string }
export function isRecommended(model: ComposerModel): boolean { return /^(?:default|default \(recommended\))$/i.test(model.displayName) || model.model === 'default'; }
export function displayModel(model: string, models: ComposerModel[]): string {
  return formatModelName(model, models);
}
export function describeDefaultSource(source: DefaultSource | undefined): string {
  return source ? [source.path, source.key].filter(Boolean).join(' · ') : '';
}
export function readRecommendedModel(settings: unknown, provider: string): string {
  const snapshot = readObject(settings);
  const role = readObject(readObject(snapshot.policy).roles).orchestrate;
  const standard = Array.isArray(role) ? role : readObject(role).standard;
  const candidate = (Array.isArray(standard) ? standard : []).map(readObject).find(item => item.executor === provider);
  return readText(candidate?.model) || readText(readObject(readObject(readObject(snapshot.config).agents)[provider]).model);
}
export function findOlderModels(models: ComposerModel[], keep: string[]): Set<string> {
  const versions = models.map(item => {
    const match = /^(.*?)[ -]?(\d+(?:\.\d+)?)(?:[ -](.+))?$/.exec(item.displayName);
    return { item, key: match ? `${match[1].replace(/[ -]$/, '')}/${match[3] ?? ''}` : '', version: match ? Number(match[2]) : 0 };
  });
  return new Set(versions.filter(({ item, key, version }) => key && !keep.includes(item.model) && versions.some(other => other.key === key && other.version > version)).map(({ item }) => item.model));
}

export function readVisibleModels(settings: unknown): string[] {
  const policy = readObject(readObject(settings).policy);
  const assigned = Object.values(readObject(policy.roles)).flatMap(role => Array.isArray(role) ? role : Object.values(readObject(role)).flatMap(band => Array.isArray(band) ? band : [])).map(item => readText(readObject(item).model));
  const latest = (Array.isArray(policy.modelNotes) ? policy.modelNotes : []).map(readObject).filter(note => note.latest === true).map(note => readText(note.model));
  return [...assigned, ...latest];
}
