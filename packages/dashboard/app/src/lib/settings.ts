import type { Ack } from './client.ts';
import type { ConfigSettings, ProjectSettings, SettingsStatus, Policy } from '../../../../api/src/ws/settings-contract.ts';
export type { ConfigSettings, ProjectSettings, SettingsStatus, Policy };
export interface SettingsClient { command(command: string, payload?: unknown, cmdId?: string): Promise<Ack> }
export interface SettingsSnapshot { config: ConfigSettings; policy: Policy; project: ProjectSettings; errors: Record<string, string>; apiKeyConfigured: boolean }
export interface PolicyPreview { token: string; rows: { id: string; before: Decision; after: Decision }[] }
interface Decision { ok: boolean; assignment?: { executor: string; model: string }; reason?: string[] }
export function describeDecision(decision: Decision): string {
  return decision.ok && decision.assignment ? `${decision.assignment.executor} · ${decision.assignment.model}` : decision.reason?.join('; ') ?? 'Unavailable';
}
export async function requestSettings<T>(client: SettingsClient, command: string, payload?: unknown): Promise<T> {
  const ack = await client.command(command, payload);
  if (!ack.ok) throw new Error(ack.error ?? 'Settings operation failed');
  return ack.result as T;
}
export type Appearance = { theme: 'system' | 'light' | 'dark'; density: 'comfortable' | 'compact'; diff: 'side-by-side' | 'unified'; time: 'relative' | 'absolute'; language: 'en' | 'ja' };
export const APPEARANCE_DEFAULTS: Appearance = { theme: 'system', density: 'comfortable', diff: 'side-by-side', time: 'relative', language: 'en' };
export const APPEARANCE_CHOICES = { theme: ['system', 'light', 'dark'], density: ['comfortable', 'compact'], diff: ['side-by-side', 'unified'], time: ['relative', 'absolute'], language: ['en', 'ja'] } as const;
export function loadAppearance(storage: Pick<Storage, 'getItem'> = localStorage): Appearance {
  return Object.fromEntries(Object.entries(APPEARANCE_CHOICES).map(([key, choices]) => {
    const saved = storage.getItem(`agent-graph-${key}`);
    return [key, (choices as readonly unknown[]).includes(saved) ? saved : APPEARANCE_DEFAULTS[key as keyof Appearance]];
  })) as Appearance;
}
export function saveAppearance(value: Appearance, storage: Pick<Storage, 'setItem'> = localStorage) {
  for (const [key, entry] of Object.entries(value)) storage.setItem(`agent-graph-${key}`, entry);
  document.documentElement.dataset.theme = value.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value.theme;
  document.documentElement.dataset.density = value.density;
  document.documentElement.dataset.diff = value.diff;
  document.documentElement.dataset.time = value.time;
  document.documentElement.lang = value.language;
  window.dispatchEvent(new CustomEvent('agent-graph-appearance', { detail: value }));
}
