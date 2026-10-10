import { discoverCodex } from '../remote/codex.ts';
import { createTargetService, buildLaunchCommand, validateTarget, type TargetOptions, type TargetService, type ExecutionTarget, type SshConnection } from '../remote/index.ts';
import { discoverRemoteSession, startRemoteMirror } from '../remote/mirror.ts';
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
  described?: boolean; provider?: 'claude' | 'codex'; projectId?: string; cwd?: string; target?: ExecutionTarget; connection?: SshConnection; remotePid?: number; discoveryBuffer?: string; disconnected?: boolean; mirror?: ReturnType<typeof startRemoteMirror>;
  scrollback: Buffer; pending: string[]; listeners: Set<Notify>; sending?: Promise<void>;
}
export interface HostOptions {
  targets?: TargetService;
  targetOptions?: TargetOptions;
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
  const targets = options.targets ?? createTargetService(selectRoot, options.targetOptions);
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
      if (!hosts.has(host.terminalId) || host.disconnected) return;
      host.terminal.write('\x15');
      host.terminal.write(`\x1b[200~${text}\x1b[201~`);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (hosts.has(host.terminalId)) host.terminal.write('\r');
    });
    return host.sending;
  }
  async function discover() {
    const pending = [...hosts.values()].filter(host => !host.conversationId || host.connection && !host.mirror && !host.disconnected);
    if (!pending.length) return;
    const processes = pending.some(host => !host.connection && host.provider !== 'codex') ? await (options.listProcesses ?? listProcesses)() : [];
    for (const host of pending.filter(host => host.provider === 'codex' && !host.disconnected)) {
      const pid = host.connection ? host.remotePid : host.terminal.pid;
      if (!pid) continue;
      let row;
      try { row = await discoverCodex(targets, pid, host.connection); } catch { continue; }
      if (!row || closed || !hosts.has(host.terminalId)) continue;
      host.conversationId = JSON.stringify(['codex', row.sessionId]);
      for (const text of host.pending) void writeMessage(host, text);
      host.pending = [];
      if (host.connection && !host.mirror) host.mirror = startRemoteMirror(targets, host.connection, row.path, row.sessionId, host.projectId!, row.cwd, () => { host.disconnected = true; }, 'codex');
    }
    for (const host of pending.filter(host => host.connection && host.provider === 'claude' && !host.disconnected)) {
      let row;
      try { row = await discoverRemoteSession(targets, host.connection!, host.cwd!, host.startedAt, host.remotePid, host.resumeId); } catch { continue; }
      if (!row || !hosts.has(host.terminalId) || host.disconnected || closed) continue;
      host.conversationId = JSON.stringify(['claude', row.sessionId]);
      for (const text of host.pending) void writeMessage(host, text);
      host.pending = [];
      let remoteFile: string;
      try { remoteFile = (await targets.ssh(host.connection!, `find "$HOME"/.claude/projects -type f -name ${JSON.stringify(row.sessionId + '.jsonl')} -print`)).trim().split('\n')[0]; } catch { continue; }
      if (host.disconnected || closed) continue;
      if (!remoteFile) continue;
      host.mirror = startRemoteMirror(targets, host.connection!, remoteFile, row.sessionId, host.projectId!, row.cwd, () => { host.disconnected = true; });
    }
    for (const host of pending.filter(host => !host.connection && host.provider !== 'codex')) {
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
        if (Object.keys(request).some(key => !['projectId', 'provider', 'resume', 'model', 'target', 'worktree'].includes(key))
          || !['claude', 'codex'].includes(String(request.provider)) || typeof request.projectId !== 'string' || !request.projectId
          || request.resume !== undefined && (typeof request.resume !== 'string' || !UUID.test(request.resume))
          || request.model !== undefined && (typeof request.model !== 'string' || !MODEL.test(request.model))) throw new Error('Invalid session launch');
        const target = validateTarget(request.target);
        const provider = request.provider as 'claude' | 'codex';
        const resumeId = request.resume as string | undefined;
        if (resumeId && [...hosts.values()].some(host => host.provider === provider && (host.resumeId === resumeId || host.conversationId === JSON.stringify([provider, resumeId])))) throw new Error('Session already hosted');
        if ([...hosts.values()].filter(host => !host.disconnected).length + opening >= MAX_TERMINALS) throw new Error('Terminal limit reached');
        opening++;
        try {
          const location = await targets.launchLocation(request.projectId as string, target, request.worktree);
          const cwd = location.path;
          if (closed) throw new Error('Terminal service closed');
          if (resumeId && [...hosts.values()].some(host => host.provider === provider && (host.resumeId === resumeId || host.conversationId === JSON.stringify([provider, resumeId])))) throw new Error('Session already hosted');
          const args: string[] = [];
          if (resumeId) args.push(provider === 'codex' ? 'resume' : '--resume', resumeId);
          if (request.model) args.push('--model', String(request.model));
          const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
            && !key.startsWith('AGENT_GRAPH') && !key.startsWith('CLAUDE_CODE') && key !== 'CLAUDECODE')) as Record<string, string>;
          env.TERM = 'xterm-256color';
          const terminal = (options.openTerminal ?? spawnTerminal)(location.connection ? 'ssh' : provider, location.connection ? ['-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', location.connection.destination, '--', buildLaunchCommand(cwd, provider, resumeId, request.model as string | undefined)] : args, { cwd: location.connection ? location.local : cwd, env, name: env.TERM, cols: 80, rows: 24 });
          const terminalId = randomUUID();
          const host: Host = { described: request.target !== undefined, terminalId, terminal, resumeId, provider, projectId: request.projectId as string, cwd, target, connection: location.connection, startedAt: new Date().toISOString(), scrollback: Buffer.alloc(0), pending: [], listeners: new Set() };
          hosts.set(terminalId, host);
          terminal.onData(data => {
            if (host.connection && !host.remotePid) {
              const discovery = (host.discoveryBuffer ?? '') + data;
              const marker = /\x1b\]777;agent-graph-pid=(\d+)\x07/.exec(discovery);
              host.discoveryBuffer = marker ? undefined : discovery.slice(-128);
              if (marker) host.remotePid = Number(marker[1]);
            }
            const buffer = Buffer.concat([host.scrollback, Buffer.from(data)]);
            let start = Math.max(0, buffer.length - MAX_SCROLLBACK_BYTES);
            while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
            host.scrollback = Buffer.from(buffer.subarray(start));
            for (const listener of host.listeners) listener({ type: 'terminal', event: 'output', terminalId, data });
          });
          terminal.onExit(({ exitCode }) => {
            host.mirror?.disconnect();
            if (host.connection) host.disconnected = true;
            else hosts.delete(terminalId);
            for (const listener of host.listeners) listener({ type: 'terminal', event: 'exit', terminalId, exitCode });
          });
          void refresh().catch(() => {});
          return { terminalId, pid: terminal.pid };
        } finally { opening--; }
      }
      if (['ssh.read', 'ssh.write', 'ssh.test', 'worktree.create', 'git.branches'].includes(command)) return targets.handle(command, payload);
      if (command === 'session.hosts') {
        await refresh();
        return { hosts: [...hosts.values()].filter(host => host.conversationId || host.disconnected).map(host => ({
          conversationId: host.conversationId!, terminalId: host.terminalId, pid: host.terminal.pid, startedAt: host.startedAt, ...(host.connection || host.described ? { provider: host.provider, cwd: host.cwd, target: host.target, projectId: host.projectId, disconnected: host.disconnected === true } : {}),
        })) };
      }
      if (command === 'session.send' || command === 'session.interrupt') {
        if (typeof request.conversationId !== 'string' || command === 'session.send' && typeof request.text !== 'string') throw new Error('Invalid session request');
        const host = [...hosts.values()].find(host => host.conversationId === request.conversationId
          || host.resumeId && JSON.stringify([host.provider ?? 'claude', host.resumeId]) === request.conversationId);
        if (!host || host.disconnected) throw new Error('no_host');
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
    close() { closed = true; clearInterval(timer); for (const host of hosts.values()) { host.mirror?.disconnect(); host.terminal.kill(); } hosts.clear(); },
  };
}
