import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TargetService, SshConnection } from './index.ts';
import { quoteShell, remotePath } from './index.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface RemoteSession { sessionId: string; pid: number; cwd: string; timestamp: number }
export async function discoverRemoteSession(service: TargetService, connection: SshConnection, cwd: string, started: string, pid?: number, resume?: string): Promise<RemoteSession | undefined> {
  const expanded = (await service.ssh(connection, `cd ${remotePath(cwd)} && pwd -P`)).trim();
  const body = await service.ssh(connection, `for f in "$HOME"/.claude/sessions/*.json; do [ -f "$f" ] || continue; printf '\\036'; stat -c %Y "$f" 2>/dev/null || stat -f %m "$f"; cat "$f"; done`);
  const rows = body.split('\x1e').flatMap(block => {
    const split = block.indexOf('\n');
    if (split < 0) return [];
    let row;
    try { row = JSON.parse(block.slice(split + 1)); } catch { return []; }
    const timestamp = Number(block.slice(0, split)) * 1000;
    return row && UUID.test(row.sessionId) && Number.isSafeInteger(row.pid) && row.cwd === expanded
      && (!resume || row.sessionId === resume) ? [{ sessionId: row.sessionId as string, pid: row.pid as number, cwd: expanded, timestamp }] : [];
  });
  if (pid) {
    let processes = '';
    try { processes = await service.ssh(connection, 'ps -axo pid=,ppid='); } catch { /* 時刻と場所による候補を使う。 */ }
    if (processes) {
      const descendants = new Set([pid]);
      let size = 0;
      while (size !== descendants.size) {
        size = descendants.size;
        for (const line of processes.trim().split('\n')) {
          const [child, parent] = line.trim().split(/\s+/).map(Number);
          if (descendants.has(parent)) descendants.add(child);
        }
      }
      const matched = rows.find(row => descendants.has(row.pid));
      // プロセスを辿れた場合、別の端末の会話を時刻で選ばない。
      if (descendants.size > 1 || processes.split('\n').some(line => Number(line.trim().split(/\s+/)[0]) === pid)) return matched;
    }
  }
  return rows.filter(row => row.timestamp >= Date.parse(started) - 1000).sort((a, b) => b.timestamp - a.timestamp)[0];
}
export function startRemoteMirror(service: TargetService, connection: SshConnection, remoteFile: string, sessionId: string,
  projectId: string, cwd: string, onDisconnect: () => void, provider: 'claude' | 'codex' = 'claude') {
  if (!UUID.test(sessionId) || !remoteFile.startsWith('/') || (provider === 'claude' ? basename(remoteFile) !== `${sessionId}.jsonl` : !basename(remoteFile).endsWith(`-${sessionId}.jsonl`))) throw new TypeError('Invalid remote transcript');
  const path = join(service.cache, 'remote', connection.id, provider === 'claude' ? 'projects' : 'codex', basename(dirname(remoteFile)), basename(remoteFile));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // tail は先頭から送るため、既存の写しの行を照合して再開する。
  let previous: string[] = [];
  try { previous = readFileSync(path, 'utf8').split('\n').slice(0, -1); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let index = 0, buffer = '', stopped = false;
  const decoder = new StringDecoder('utf8');
  const child = service.spawnStream('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', connection.destination, '--', `tail -n +1 -F ${quoteShell(remoteFile)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const metadata = { connectionId: connection.id, projectId, cwd, disconnected: false };
  const save = () => appendMetadata(path, metadata);
  save();
  const disconnect = () => { if (stopped) return; stopped = true; child.kill(); metadata.disconnected = true; save(); onDisconnect(); };
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stopped) return;
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (index < previous.length) {
        if (previous[index] !== line) { disconnect(); return; }
      } else appendFileSync(path, line + '\n', { mode: 0o600 });
      index++;
    }
  });
  child.stderr?.on('data', () => {});
  child.on('error', disconnect); child.on('exit', disconnect);
  return { path, stop() { if (!stopped) { stopped = true; child.kill(); } }, disconnect };
}
function appendMetadata(path: string, metadata: object) {
  writeFileSync(path + '.remote.tmp', JSON.stringify(metadata), { mode: 0o600 });
  renameSync(path + '.remote.tmp', path + '.remote.json');
}
