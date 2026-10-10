import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { quoteShell } from './index.ts';
import type { SshConnection, TargetService } from './index.ts';
const ROLLOUT = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
async function readFirstLine(path: string): Promise<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { for await (const line of lines) return line; return ''; }
  finally { lines.close(); stream.destroy(); }
}
export async function discoverCodex(service: TargetService, pid: number, connection?: SshConnection) {
  const processes = connection ? await service.ssh(connection, 'ps -axo pid=,ppid=') : await service.run('ps', ['-axo', 'pid=,ppid=']);
  const descendants = new Set([pid]);
  let size = 0;
  while (size !== descendants.size) {
    size = descendants.size;
    for (const line of processes.split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (descendants.has(parent)) descendants.add(child);
    }
  }
  const pids = [...descendants].join(',');
  const command = `lsof -nP -p ${pids} -F n`;

  const output = connection ? await service.ssh(connection, command) : await service.run('lsof', ['-nP', '-p', pids, '-F', 'n']);
  for (const line of output.split('\n')) {
    if (!line.startsWith('n/')) continue;
    const path = line.slice(1), match = ROLLOUT.exec(path);
    if (!match) continue;
    const body = connection ? await service.ssh(connection, `head -n 1 ${quoteShell(path)}`) : await readFirstLine(path);
    const row = JSON.parse(body.split('\n')[0]);
    if (row.type === 'session_meta' && row.payload?.id === match[1]) return { sessionId: match[1], path, cwd: String(row.payload.cwd) };
  }
  return undefined;
}
