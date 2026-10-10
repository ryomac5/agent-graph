import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { spawn, IPty } from 'node-pty';
import type { FilesRequest } from '../files/index.ts';
import { MAX_TERMINALS, spawnTerminal, type TerminalNotification } from './index.ts';

export const MAX_SCROLLBACK_BYTES = 256 * 1024;
const DISCOVERY_MS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[a-z0-9][a-z0-9._-]*$/i;
const execute = promisify(execFile);
type Notify = (message: TerminalNotification) => void;
interface Host {
  terminalId: string; terminal: IPty; startedAt: string; conversationId?: string; resumeId?: string;
  scrollback: Buffer; pending: string[]; listeners: Set<Notify>; sending?: Promise<void>;
}
export interface HostOptions {
  openTerminal?: typeof spawn;
  sessionsDirectory?: string;
  listProcesses?: () => Promise<{ pid: number; ppid: number }[]>;
  /** 貼り付けのあと Enter を送るまでの待ち。試験では 0 にする。 */
  submitDelayMs?: number;
}
async function listProcesses() {
  const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=']);
  return stdout.trim().split('\n').map(line => {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid };
  });
}
export function createSessionHosts(selectRoot: (request: FilesRequest) => Promise<string>, options: HostOptions = {}) {
  const hosts = new Map<string, Host>();
  const directory = options.sessionsDirectory ?? join(homedir(), '.claude', 'sessions');
  let opening = 0, closed = false;
  let scanning: Promise<void> | undefined;
  // Orca と同じく、入力中の行を消してから貼り付け、Enter は間を置いて別に書く。
  // 同じ書き込みに Enter を含めると、貼り付けの中身として扱われて送られないことがあるからである。
  // 送信は端末ごとに順に並べ、続けて送った発言が混ざらないようにする。
  function writeMessage(host: Host, text: string): Promise<void> {
    const delay = options.submitDelayMs ?? 500;
    host.sending = (host.sending ?? Promise.resolve()).then(async () => {
      if (!hosts.has(host.terminalId)) return;
      host.terminal.write('\x15');
      host.terminal.write(`\x1b[200~${text}\x1b[201~`);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (hosts.has(host.terminalId)) host.terminal.write('\r');
    });
    return host.sending;
  }
  async function discover() {
    const pending = [...hosts.values()].filter(host => !host.conversationId);
    if (!pending.length) return;
    const processes = await (options.listProcesses ?? listProcesses)();
    for (const host of pending) {
      const descendants = new Set([host.terminal.pid]);
      let count = 0;
      while (count !== descendants.size) {
        count = descendants.size;
        for (const row of processes) if (descendants.has(row.ppid)) descendants.add(row.pid);
      }
      for (const pid of descendants) {
        let row;
        // 起動中のファイルの不在や書きかけは、次の周期で読み直す。
        try { row = JSON.parse(await readFile(join(directory, `${pid}.json`), 'utf8')); }
        catch { continue; }
        if (row?.pid !== pid || typeof row.sessionId !== 'string' || !UUID.test(row.sessionId)
          || host.resumeId && row.sessionId !== host.resumeId || !hosts.has(host.terminalId)) continue;
        host.conversationId = JSON.stringify(['claude', row.sessionId]);
        for (const text of host.pending) void writeMessage(host, text);
        host.pending = [];
        break;
      }
    }
  }
  function refresh(): Promise<void> {
    if (!scanning) scanning = discover().finally(() => { scanning = undefined; });
    return scanning;
  }
  const timer = setInterval(() => { void refresh().catch(() => {}); }, DISCOVERY_MS);
  timer.unref();
  return {
    hasTerminal(id: unknown) { return typeof id === 'string' && hosts.has(id); },
    detach(notify: Notify) { for (const host of hosts.values()) host.listeners.delete(notify); },
    async handle(command: string, payload: unknown, notify: Notify) {
      if (closed) throw new Error('Terminal service closed');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid session request');
      const request = payload as Record<string, unknown>;
      if (command === 'session.launch') {
        if (Object.keys(request).some(key => !['projectId', 'provider', 'resume', 'model'].includes(key))
          || request.provider !== 'claude' || typeof request.projectId !== 'string' || !request.projectId
          || request.resume !== undefined && (typeof request.resume !== 'string' || !UUID.test(request.resume))
          || request.model !== undefined && (typeof request.model !== 'string' || !MODEL.test(request.model))) throw new Error('Invalid session launch');
        const resumeId = request.resume as string | undefined;
        if (resumeId && [...hosts.values()].some(host => host.resumeId === resumeId || host.conversationId === JSON.stringify(['claude', resumeId]))) throw new Error('Session already hosted');
        if (hosts.size + opening >= MAX_TERMINALS) throw new Error('Terminal limit reached');
        opening++;
        try {
          const cwd = await selectRoot({ projectId: request.projectId } as FilesRequest);
          if (closed) throw new Error('Terminal service closed');
          if (resumeId && [...hosts.values()].some(host => host.resumeId === resumeId || host.conversationId === JSON.stringify(['claude', resumeId]))) throw new Error('Session already hosted');
          const args: string[] = [];
          if (resumeId) args.push('--resume', resumeId);
          if (request.model) args.push('--model', String(request.model));
          const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
            && !key.startsWith('AGENT_GRAPH') && !key.startsWith('CLAUDE_CODE') && key !== 'CLAUDECODE')) as Record<string, string>;
          env.TERM = 'xterm-256color';
          const terminal = (options.openTerminal ?? spawnTerminal)('claude', args, { cwd, env, name: env.TERM, cols: 80, rows: 24 });
          const terminalId = randomUUID();
          const host: Host = { terminalId, terminal, resumeId, startedAt: new Date().toISOString(), scrollback: Buffer.alloc(0), pending: [], listeners: new Set() };
          hosts.set(terminalId, host);
          terminal.onData(data => {
            const buffer = Buffer.concat([host.scrollback, Buffer.from(data)]);
            let start = Math.max(0, buffer.length - MAX_SCROLLBACK_BYTES);
            while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
            host.scrollback = Buffer.from(buffer.subarray(start));
            for (const listener of host.listeners) listener({ type: 'terminal', event: 'output', terminalId, data });
          });
          terminal.onExit(({ exitCode }) => {
            hosts.delete(terminalId);
            for (const listener of host.listeners) listener({ type: 'terminal', event: 'exit', terminalId, exitCode });
          });
          void refresh().catch(() => {});
          return { terminalId, pid: terminal.pid };
        } finally { opening--; }
      }
      if (command === 'session.hosts') {
        await refresh();
        return { hosts: [...hosts.values()].filter(host => host.conversationId).map(host => ({
          conversationId: host.conversationId!, terminalId: host.terminalId, pid: host.terminal.pid, startedAt: host.startedAt,
        })) };
      }
      if (command === 'session.send' || command === 'session.interrupt') {
        if (typeof request.conversationId !== 'string' || command === 'session.send' && typeof request.text !== 'string') throw new Error('Invalid session request');
        const host = [...hosts.values()].find(host => host.conversationId === request.conversationId
          || host.resumeId && JSON.stringify(['claude', host.resumeId]) === request.conversationId);
        if (!host) throw new Error('no_host');
        if (command === 'session.interrupt') host.terminal.write('\x1b');
        else if (host.conversationId) await writeMessage(host, request.text as string);
        else host.pending.push(request.text as string);
        return {};
      }
      const host = hosts.get(String(request.terminalId));
      if (!host) throw new Error('Unknown terminal');
      if (command === 'terminal.attach') {
        host.listeners.add(notify);
        return { terminalId: host.terminalId, scrollback: host.scrollback.toString('utf8') };
      }
      if (command === 'terminal.input') {
        if (!host.listeners.has(notify)) throw new Error('Unknown terminal');
        if (typeof request.data !== 'string') throw new Error('Invalid terminal input');
        host.terminal.write(request.data);
      } else if (command === 'terminal.resize') {
        if (!host.listeners.has(notify)) throw new Error('Unknown terminal');
        if (![request.cols, request.rows].every(value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 65535)) throw new Error('Invalid terminal size');
        host.terminal.resize(Number(request.cols), Number(request.rows));
      } else if (command === 'terminal.close') {
        if (!host.listeners.has(notify)) throw new Error('Unknown terminal');
        host.terminal.kill();
      } else throw new Error('Unknown terminal command');
      return {};
    },
    close() { closed = true; clearInterval(timer); for (const host of hosts.values()) host.terminal.kill(); hosts.clear(); },
  };
}
