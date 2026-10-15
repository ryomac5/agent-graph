import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessIdentity } from '../../../core/src/state/index.ts';
import { normalizeProcessStart } from '../../../core/src/state/process.ts';

export const SESSION_SCAN_INTERVAL_MS = 10_000;
export const SESSION_SCAN_VALID_MS = 30_000;
const execute = promisify(execFile);
export interface SessionRegistration extends ProcessIdentity {
  sessionId: string;
  startedAt: number;
  status?: string;
  statusUpdatedAt?: number;
}
export interface SessionScan {
  provider?: 'claude' | 'codex';
  id: string; at: number; status: 'succeeded' | 'partial' | 'failed';
  sessions: SessionRegistration[];
  processes: { pid: number; procStart: string | null }[];
  error?: string;
}
export async function readProcessStarts(): Promise<Map<number, string>> {
  const { stdout } = await execute('ps', ['-axo', 'pid=,lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const entries = stdout.trim().split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('Invalid process listing');
    return [Number(match[1]), normalizeProcessStart(match[2], 'UTC')] as const;
  });
  return new Map(entries);
}
/** 部分成功は対象の不在を証明しない。登録と OS の開始値を別々に保持する。 */
export async function scanSessions(directory: string, readProcesses = readProcessStarts, now = Date.now): Promise<SessionScan> {
  const sessions: SessionRegistration[] = [];
  let status: SessionScan['status'] = 'succeeded';
  let processes: SessionScan['processes'] = [];
  let error: string | undefined;
  try {
    const names = await readdir(directory);
    const current = await readProcesses();
    processes = [...current].map(([pid, procStart]) => ({ pid, procStart: normalizeProcessStart(procStart, 'local') }));
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      try {
        const row = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (!row || typeof row.sessionId !== 'string' || !row.sessionId || !Number.isSafeInteger(row.pid) || row.pid <= 0
          || !Number.isFinite(row.startedAt)) throw new Error('Invalid registration');
        const procStart = typeof row.procStart === 'string' ? normalizeProcessStart(row.procStart, 'UTC')
          : processes.find(process => process.pid === row.pid)?.procStart;
        if (!procStart) continue;
        sessions.push({ sessionId: row.sessionId, pid: row.pid, procStart, startedAt: row.startedAt,
          status: row.status, statusUpdatedAt: row.statusUpdatedAt });
      } catch { status = 'partial'; error = 'Unreadable session registration'; }
    }
  } catch { status = 'failed'; error = 'Session scan failed'; }
  const at = now();
  return { id: `sessions:${at}`, at, status, sessions, processes, ...(error ? { error } : {}) };
}
