export type ProviderId = 'claude' | 'codex' | 'antigravity';
export interface UsageWindow { key: string; label: string; usedPercent: number; resetsAt: string | null; group?: string }
export interface ProviderUsage { id: ProviderId; windows: UsageWindow[]; fetchedAt: string | null; state: 'ok' | 'stale' | 'unavailable'; reason?: string }
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('invalid_data');
  return value;
}
function readReset(value: unknown): string | null {
  const time = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function requireWindows(windows: UsageWindow[]): UsageWindow[] {
  if (!windows.length) throw new Error('no_windows');
  return windows;
}
export function parseClaude(value: unknown): { windows: UsageWindow[]; timestamp: number } {
  const data = asRecord(value);
  const timestamp = typeof data.ts === 'string' ? Date.parse(data.ts) : NaN;
  if (!Number.isFinite(timestamp) || !Array.isArray(data.windows)) throw new Error('invalid_data');
  return { timestamp, windows: requireWindows(data.windows.map(value => {
    const row = asRecord(value);
    if (typeof row.key !== 'string' || typeof row.label !== 'string') throw new Error('invalid_data');
    return { key: row.key, label: row.label, usedPercent: readPercent(row.percent), resetsAt: readReset(row.resets_at) };
  })) };
}
export function parseCodex(value: unknown, rollout = false): UsageWindow[] {
  const root = asRecord(value);
  const data = rollout ? root : asRecord(root.rateLimits);
  return requireWindows(['primary', 'secondary'].flatMap(key => {
    const row = asRecord(data[key]);
    if (!Object.keys(row).length) return [];
    const minutes = row[rollout ? 'window_minutes' : 'windowDurationMins'];
    return [{ key, label: minutes === 300 ? '5h' : minutes === 10080 ? 'wk' : typeof minutes === 'number' ? `${minutes}m` : key,
      usedPercent: readPercent(row[rollout ? 'used_percent' : 'usedPercent']), resetsAt: readReset(row[rollout ? 'resets_at' : 'resetsAt']) }];
  }));
}
export function supportsAgy(version: string): boolean {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11);
}
export function parseAntigravity(value: unknown): UsageWindow[] {
  const groups = asRecord(asRecord(asRecord(value).command).data).groups;
  if (!Array.isArray(groups)) throw new Error('invalid_data');
  return requireWindows(groups.flatMap((value, groupIndex) => {
    const group = asRecord(value);
    if (typeof group.name !== 'string' || !Array.isArray(group.buckets)) throw new Error('invalid_data');
    return group.buckets.flatMap((value, index) => {
      const bucket = asRecord(value);
      if (bucket.disabled === true) return [];
      if (bucket.window !== 'weekly' && bucket.window !== '5h') throw new Error('invalid_data');
      if (typeof bucket.remaining_fraction !== 'number' || bucket.remaining_fraction < 0 || bucket.remaining_fraction > 1) throw new Error('invalid_data');
      return [{ key: `${groupIndex}:${index}:${bucket.window}`, label: bucket.window === 'weekly' ? 'wk' : '5h',
        usedPercent: Math.round(readPercent((1 - bucket.remaining_fraction) * 100)), resetsAt: readReset(bucket.reset_time), group: group.name as string }];
    });
  }));
}
