import { stat, readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord, parseClaude, parseClaudeLimits, parseClaudeStatusline, parseCodex, parseAntigravity, supportsAgy, type ProviderId, type ProviderUsage, type UsageWindow } from './parsers.ts';
import { probeClaude, probeCodex, runUsageCommand, type SpawnUsage } from './process.ts';

export const POLL_MS = 15 * 60_000;
export const MANUAL_MS = 5 * 60_000;
export const STALE_MS = 30 * 60_000;
export const RETRY_MS = 30_000;
export interface UsageOptions { claudePath?: string; claudeCommand?: string; claudeProbePath?: string; readRepositoryPaths?: () => string[]; codexSessionsPath?: string; codexCommand?: string; agyCommand?: string; spawn?: SpawnUsage; now?: () => number }
interface Entry { value: ProviderUsage; attempted: number; next: number; failures: number }
export async function readClaudeFallback(repositories: string[]): Promise<ReturnType<typeof parseClaude>> {
  const results = await Promise.allSettled([...new Set(repositories)].map(async root =>
    parseClaudeStatusline(JSON.parse(await readFile(join(root, '.agents/state/usage.json'), 'utf8')))));
  let latest: ReturnType<typeof parseClaude> | undefined;
  for (const result of results) if (result.status === 'fulfilled' && (!latest || result.value.timestamp > latest.timestamp)) latest = result.value;
  if (!latest) throw new Error('no_record');
  return latest;
}
export async function readCodexFallback(directory: string): Promise<{ windows: UsageWindow[]; timestamp: number }> {
  let latest: { path: string; mtime: number } | undefined;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const info = await stat(path);
        if (!latest || info.mtimeMs > latest.mtime) latest = { path, mtime: info.mtimeMs };
      }
    }
  }
  await visit(directory);
  if (!latest) throw new Error('no_record');
  const input = createReadStream(latest.path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let last: Record<string, unknown> | undefined;
  try {
    for await (const line of lines) {
      if (!line.includes('token_count')) continue;
      let row;
      try { row = asRecord(JSON.parse(line)); } catch { continue; }
      const payload = asRecord(row.payload);
      if (payload.type === 'token_count') last = row;
    }
  } finally { lines.close(); input.destroy(); }
  if (!last) throw new Error('no_record');
  const timestamp = typeof last.timestamp === 'string' ? Date.parse(last.timestamp) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error('invalid_data');
  return { windows: parseCodex(asRecord(last.payload).rate_limits, true), timestamp };
}
export function createUsageService(options: UsageOptions = {}) {
  const now = options.now ?? Date.now;
  const entries = new Map<ProviderId, Entry>();
  const inflight = new Map<ProviderId, Promise<ProviderUsage>>();
  let agySupported: boolean | undefined;
  let agyStopped = false;
  async function fetchProvider(id: ProviderId): Promise<{ windows: UsageWindow[]; timestamp: number; reason?: string }> {
    if (id === 'claude') {
      try {
        const limits = await probeClaude(options.claudeCommand ?? 'claude', options.claudeProbePath ?? join(homedir(), '.cache/agent-graph/usage-probe'), options.spawn);
        return { windows: parseClaudeLimits(limits), timestamp: now() };
      } catch {
        try { return { ...await readClaudeFallback(options.readRepositoryPaths?.() ?? [process.cwd()]), reason: 'record_fallback' }; }
        catch {
          const path = options.claudePath ?? join(homedir(), '.cache/agent-graph/usage.json');
          return { ...parseClaude(JSON.parse(await readFile(path, 'utf8'))), reason: 'record_fallback' };
        }
      }
    }
    if (id === 'codex') {
      try { return { windows: parseCodex(await probeCodex(options.codexCommand ?? 'codex', options.spawn)), timestamp: now() }; }
      catch {
        const fallback = await readCodexFallback(options.codexSessionsPath ?? join(homedir(), '.codex/sessions'));
        return { ...fallback, reason: 'record_fallback' };
      }
    }
    if (agyStopped) throw new Error('turns_detected');
    const command = options.agyCommand ?? 'agy';
    if (agySupported === undefined) agySupported = supportsAgy(await runUsageCommand(command, ['--version'], options.spawn));
    if (!agySupported) throw new Error('unsupported_version');
    const result = asRecord(JSON.parse(await runUsageCommand(command, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], options.spawn)));
    if (result.num_turns !== 0) { agyStopped = true; throw new Error('turns_detected'); }
    return { windows: parseAntigravity(result), timestamp: now() };
  }
  function age(value: ProviderUsage): ProviderUsage {
    if (value.state === 'ok' && (!value.fetchedAt || now() - Date.parse(value.fetchedAt) > STALE_MS)) return { ...value, state: 'stale', reason: 'old_value' };
    return value;
  }
  async function readProvider(id: ProviderId, force: boolean): Promise<ProviderUsage> {
    const pending = inflight.get(id);
    if (pending) return pending;
    const previous = entries.get(id);
    const time = now();
    // 手動更新の待ち時間も共有し、複数の画面からの重複を防ぐ。
    if (previous && (force ? time - previous.attempted < MANUAL_MS : time < previous.next)) return age(previous.value);
    const promise = (async () => {
      let value: ProviderUsage;
      let failures = 0;
      try {
        const result = await fetchProvider(id);
        failures = result.reason ? (previous?.failures ?? 0) + 1 : 0;
        const stale = now() - result.timestamp > STALE_MS;
        value = { id, windows: result.windows, fetchedAt: new Date(result.timestamp).toISOString(), state: stale || result.reason ? 'stale' : 'ok', reason: result.reason ?? (stale ? 'old_value' : undefined) };
      } catch (error) {
        failures = (previous?.failures ?? 0) + 1;
        const known = ['turns_detected', 'unsupported_version', 'invalid_data', 'no_windows', 'timeout', 'command_unavailable', 'command_failed'];
        const reason = error instanceof Error && known.includes(error.message) ? error.message : id === 'claude' ? 'file_unavailable' : 'source_unavailable';
        value = { id, windows: previous?.value.windows ?? [], fetchedAt: previous?.value.fetchedAt ?? null, state: previous?.value.windows.length ? 'stale' : 'unavailable', reason };
      }
      entries.set(id, { value, attempted: time, failures, next: now() + (failures ? Math.min(RETRY_MS * 2 ** Math.min(failures - 1, 10), POLL_MS) : POLL_MS) });
      return age(value);
    })();
    inflight.set(id, promise);
    try { return await promise; } finally { inflight.delete(id); }
  }
  return { async read(payload: unknown = {}) {
    const data = asRecord(payload);
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || data.force !== undefined && typeof data.force !== 'boolean') throw new Error('Invalid usage request');
    return { providers: await Promise.all((['claude', 'codex', 'antigravity'] as const).map(id => readProvider(id, data.force === true))) };
  } };
}
