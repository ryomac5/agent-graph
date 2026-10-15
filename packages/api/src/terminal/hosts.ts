import { discoverCodex } from '../remote/codex.ts';
import { createTargetService, buildLaunchCommand, validateTarget, type TargetOptions, type TargetService, type ExecutionTarget, type SshConnection } from '../remote/index.ts';
import { discoverRemoteSession, startRemoteMirror } from '../remote/mirror.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { spawn, IPty } from 'node-pty';
import type { FilesRequest } from '../files/index.ts';
import { MAX_TERMINALS, spawnTerminal, type TerminalNotification } from './index.ts';
import { TerminalScreen, isInputBlocked, readPrompt, readPanel, readCommandOutput } from './screen.ts';
import { listSlashCommands } from './slash-commands.ts';
import { SMOKE_DIRECTORY, SMOKE_PROJECT_ID } from '../verification.ts';

import { createAttachmentStore, escapeAttachmentPath, uploadRemoteAttachment, type AttachmentOptions } from './attachments.ts';

export const MAX_SCROLLBACK_BYTES = 256 * 1024;
const DISCOVERY_MS = 500;
const STARTUP_LIMIT_MS = 15_000;
const STARTUP_POLL_MS = 100;
const COMMAND_SETTLE_MS = 300;
const COMMAND_LIMIT_MS = 3000;
const SESSION_CHANGING_COMMANDS = new Set(['clear', 'new', 'resume']);
const READ_ONLY_PANELS = new Map([
  ['help', /\bHelp\s+General\s+Commands/u],
  ['cost', /\b(?:Total cost:|Session cost|Usage)\b/u],
  ['usage', /\b(?:Total cost:|Session cost|Usage)\b/u],
  ['context', /\bContext (?:Usage|usage)\b/u],
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL = /^[a-z0-9][a-z0-9._-]*$/i;
const execute = promisify(execFile);
type Notify = (message: TerminalNotification) => void;
interface Host {
  launchModel?: string;
  terminalId: string; terminal: IPty; startedAt: string; startedTick: number; conversationId?: string; resumeId?: string; sessionPid?: number;
  described?: boolean; provider?: 'claude' | 'codex'; projectId?: string; cwd?: string; target?: ExecutionTarget; connection?: SshConnection; remotePid?: number; discoveryBuffer?: string; disconnected?: boolean; mirror?: ReturnType<typeof startRemoteMirror>;
  scrollback: Buffer; screen: TerminalScreen; listeners: Set<Notify>; sending?: Promise<unknown>; lastOutputAt?: number; inputReady?: boolean; inputRevision: number;
}
export interface SessionSendResult {
  delivery?: 'terminal';
  terminalId?: string;
  conversationId?: string;
  command?: { text: string; output: string; status: 'completed' | 'interactive' };
}
export class TerminalInputError extends Error {
  readonly terminalId: string;
  constructor(terminalId: string) { super('Terminal is not ready for a message. Continue in the terminal tab.'); this.terminalId = terminalId; }
}
export interface SendLifecycle { emitting(target: string): void; emitted(): void }
export interface HostOptions {
  targets?: TargetService;
  targetOptions?: TargetOptions;
  openTerminal?: typeof spawn;
  sessionsDirectory?: string;
  listProcesses?: () => Promise<{ pid: number; ppid: number }[]>;
  /** 貼り付けのあと Enter を送るまでの待ち。試験では 0 にする。 */
  submitDelayMs?: number;
  /** 起動時だけ、出力が止まってから待つ時間と、起動から待つ時間。試験では 0 にする。 */
  quietMs?: number; warmupMs?: number;
  attachments?: AttachmentOptions;
  wait?: (ms: number) => Promise<void>;
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
  const attachments = createAttachmentStore(options.attachments);
  const hosts = new Map<string, Host>();
  const directory = options.sessionsDirectory ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');
  let opening = 0, closed = false;
  let scanning: Promise<void> | undefined;
  function isInputReady(host: Host): boolean {
    const now = performance.now(), age = now - host.startedTick;
    // 準備完了を記憶し、作業中の描画では静穏待ちに戻さない。上限も送信時でなく起動時から数える。
    host.inputReady ||= age >= STARTUP_LIMIT_MS
      || age >= (options.warmupMs ?? 2500) && now - (host.lastOutputAt ?? host.startedTick) >= (options.quietMs ?? 800);
    return host.inputReady;
  }
  // Orca と同じく、入力中の行を消してから貼り付け、Enter は間を置いて別に書く。
  // 同じ書き込みに Enter を含めると、貼り付けの中身として扱われて送られないことがあるからである。
  // 送信は端末ごとに順に並べ、続けて送った発言が混ざらないようにする。
  function writeMessage(host: Host, conversationId: string, text: string, paths: Promise<string[]> = Promise.resolve([]), lifecycle?: SendLifecycle): Promise<SessionSendResult> {
    const delay = options.submitDelayMs ?? 500;
    const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const sending = (host.sending ?? Promise.resolve()).catch(() => {}).then(async (): Promise<SessionSendResult> => {
      await recheckLocalSession(host);
      if (!hosts.has(host.terminalId) || host.disconnected) throw new Error('no_host');
      if (host.conversationId && host.conversationId !== conversationId) throw new Error('no_host');
      // 起動や resume の直後は、画面が入力を受け付ける前に貼ると、bracketed paste が効かず素の文字として入る。
      while (!isInputReady(host)) {
        await wait(STARTUP_POLL_MS);
        if (!hosts.has(host.terminalId) || host.disconnected) throw new Error('no_host');
      }
      const localPaths = await paths;
      const pasted = host.connection ? await Promise.all(localPaths.map(path => uploadRemoteAttachment(targets, host.connection!, path))) : localPaths;
      if (!hosts.has(host.terminalId) || host.disconnected) throw new Error('no_host');
      const provider = host.provider!;
      const before = await host.screen.read();
      if (isInputBlocked(before, provider)) throw new TerminalInputError(host.terminalId);
      const inputRevision = host.inputRevision;
      const slash = /^\/([^\s]+)(?:\s|$)/u.exec(text.trimStart());
      // 引数のないコマンドも空白で確定し、補完候補の先頭を誤実行しない。
      const body = slash && !/\s$/u.test(text) ? text + ' ' : text;
      await recheckLocalSession(host);
      if (host.conversationId && host.conversationId !== conversationId) throw new Error('no_host');
      lifecycle?.emitting(JSON.stringify([host.terminalId, host.startedAt]));
      host.terminal.write('\x15');
      for (const path of pasted) host.terminal.write(`\x1b[200~${escapeAttachmentPath(path)}\x1b[201~`);
      if (pasted.length) await wait(300);
      if (!hosts.has(host.terminalId) || host.disconnected) throw new Error('no_host');
      host.terminal.write(`\x1b[200~${pasted.length ? ' ' : ''}${body}\x1b[201~`);
      if (delay) await wait(delay);
      if (!hosts.has(host.terminalId) || host.disconnected) throw new Error('no_host');
      if (host.inputRevision !== inputRevision || isInputBlocked(await host.screen.read(), provider)) throw new TerminalInputError(host.terminalId);
      host.terminal.write('\r');
      lifecycle?.emitted();
      if (!slash) return {};
      let after = before;
      let previous = '';
      let settled = 0;
      for (let elapsed = 0; elapsed < COMMAND_LIMIT_MS; elapsed += STARTUP_POLL_MS) {
        await wait(STARTUP_POLL_MS);
        if (!hosts.has(host.terminalId) || host.disconnected) throw new Error('no_host');
        after = await host.screen.read();
        const current = after.lines.join('\n');
        settled = current === previous ? settled + STARTUP_POLL_MS : 0;
        previous = current;
        if (after.revision > before.revision && settled >= COMMAND_SETTLE_MS) break;
      }
      if (SESSION_CHANGING_COMMANDS.has(slash[1]) && (host.connection || provider === 'codex')) await refresh(host);
      else await recheckLocalSession(host);
      const prompt = readPrompt(after, provider);
      const output = prompt ? readCommandOutput(before, after, text, provider) : readPanel(after);
      if (!prompt) {
        const readOnly = provider === 'claude' && READ_ONLY_PANELS.get(slash[1])?.test(output);
        if (readOnly && host.inputRevision === inputRevision) {
          host.terminal.write('\x1b');
          for (let elapsed = 0; elapsed < COMMAND_LIMIT_MS; elapsed += STARTUP_POLL_MS) {
            await wait(STARTUP_POLL_MS);
            if (readPrompt(await host.screen.read(), provider)) {
              return { delivery: 'terminal', terminalId: host.terminalId, command: { text, output, status: 'completed' } };
            }
          }
        }
        return { delivery: 'terminal', terminalId: host.terminalId, command: { text, output, status: 'interactive' } };
      }
      // 即時の端末出力だけは一時表示し、非同期の結果は既存の履歴取り込みで反映する。
      if (prompt.text.startsWith(text.trim())) throw new TerminalInputError(host.terminalId);
      if (output && (/^\s*⎿/mu.test(output) || ['help', 'cost', 'usage', 'context', 'status', 'model', 'clear', 'new', 'reset', 'config', 'permissions', 'effort'].includes(slash[1])))
        return { ...(slash[1] === 'compact' ? {} : { delivery: 'terminal' as const }), terminalId: host.terminalId, conversationId: host.conversationId,
          command: { text, output, status: 'completed' } };
      if (host.conversationId !== conversationId) return { delivery: 'terminal', conversationId: host.conversationId };
      return {};
    });
    host.sending = sending;
    return sending;
  }
  async function readLocalSession(host: Host, pid: number): Promise<boolean> {
    let row;
    // 起動中のファイルの不在や書きかけは、次の周期で読み直す。
    try { row = JSON.parse(await readFile(join(directory, `${pid}.json`), 'utf8')); }
    catch { return false; }
    if (row?.pid !== pid || typeof row.sessionId !== 'string' || !UUID.test(row.sessionId)
      || !host.conversationId && host.resumeId && row.sessionId !== host.resumeId || !hosts.has(host.terminalId) || closed) return false;
    host.conversationId = JSON.stringify(['claude', row.sessionId]);
    host.sessionPid = pid;
    return true;
  }
  async function recheckLocalSession(host: Host): Promise<void> {
    // 確定済みの PID の記録だけを読み直し、送信や一覧取得で ps / lsof / ssh を呼ばない。
    if (!host.connection && host.provider === 'claude' && !host.disconnected) await readLocalSession(host, host.sessionPid ?? host.terminal.pid);
  }
  async function discover(recheck?: Host) {
    const pending = (recheck ? [recheck] : [...hosts.values()].filter(host => !host.conversationId || host.connection && !host.mirror))
      .filter(host => !host.disconnected && hosts.has(host.terminalId));
    if (!pending.length) return;
    const processes = pending.some(host => !host.connection && host.provider !== 'codex') ? await (options.listProcesses ?? listProcesses)() : [];
    for (const host of pending.filter(host => host.provider === 'codex' && !host.disconnected)) {
      const pid = host.connection ? host.remotePid : host.terminal.pid;
      if (!pid) continue;
      let row;
      try { row = await discoverCodex(targets, pid, host.connection); } catch { continue; }
      if (!row || closed || !hosts.has(host.terminalId)) continue;
      if (host.conversationId !== JSON.stringify(['codex', row.sessionId])) { host.mirror?.stop(); host.mirror = undefined; }
      host.conversationId = JSON.stringify(['codex', row.sessionId]);
      if (host.connection && !host.mirror) host.mirror = startRemoteMirror(targets, host.connection, row.path, row.sessionId, host.projectId!, row.cwd, () => { host.disconnected = true; }, 'codex');
    }
    for (const host of pending.filter(host => host.connection && host.provider === 'claude' && !host.disconnected)) {
      let row;
      try { row = await discoverRemoteSession(targets, host.connection!, host.cwd!, host.startedAt, host.remotePid, host.conversationId ? undefined : host.resumeId); } catch { continue; }
      if (!row || !hosts.has(host.terminalId) || host.disconnected || closed) continue;
      if (host.conversationId !== JSON.stringify(['claude', row.sessionId])) { host.mirror?.stop(); host.mirror = undefined; }
      host.conversationId = JSON.stringify(['claude', row.sessionId]);
      if (host.mirror) continue;
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
        if (await readLocalSession(host, pid)) break;
      }
    }
  }
  function refresh(recheck?: Host): Promise<void> {
    if (scanning && recheck) return scanning.then(() => refresh(recheck));
    if (!scanning) scanning = discover(recheck).finally(() => { scanning = undefined; });
    return scanning;
  }
  const timer = setInterval(() => {
    for (const host of hosts.values()) isInputReady(host);
    void refresh().catch(() => {});
  }, DISCOVERY_MS);
  timer.unref();
  return {
    hasTerminal(id: unknown) { return typeof id === 'string' && hosts.has(id); },
    detach(notify: Notify) { for (const host of hosts.values()) host.listeners.delete(notify); },
    async target(conversation: string): Promise<string | undefined> {
      await refresh();
      const host = [...hosts.values()].find(host => host.conversationId === conversation
        || !host.conversationId && host.resumeId && JSON.stringify([host.provider ?? 'claude', host.resumeId]) === conversation);
      return host ? JSON.stringify([host.terminalId, host.startedAt]) : undefined;
    },
    async handle(command: string, payload: unknown, notify: Notify, lifecycle?: SendLifecycle): Promise<unknown> {
      if (closed) throw new Error('Terminal service closed');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid session request');
      const request = payload as Record<string, unknown>;
      if (command === 'attachment.put') return attachments.put(payload);
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
          const smokeLaunch = request.projectId === SMOKE_PROJECT_ID;
          if (smokeLaunch) {
            if (provider !== 'claude' || request.target !== undefined || request.worktree !== undefined) throw new Error('Invalid session launch');
            await mkdir(SMOKE_DIRECTORY, { recursive: true });
            if (await realpath(SMOKE_DIRECTORY) !== join(await realpath(homedir()), '.cache/agent-graph/smoke')) throw new Error('Invalid smoke directory');
            if (resumeId) {
              const transcript = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects',
                SMOKE_DIRECTORY.replace(/[^a-zA-Z0-9]/g, '-'), `${resumeId}.jsonl`);
              const rows = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
              const cwds = rows.flatMap(row => typeof row.cwd === 'string' ? [row.cwd] : []);
              if (!cwds.length || cwds.some(cwd => cwd !== SMOKE_DIRECTORY)) throw new Error('Invalid smoke resume');
            }
          }
          const location = smokeLaunch ? { path: SMOKE_DIRECTORY, local: SMOKE_DIRECTORY, connection: undefined }
            : await targets.launchLocation(request.projectId as string, target, request.worktree);
          const cwd = location.path;
          if (closed) throw new Error('Terminal service closed');
          if (resumeId && [...hosts.values()].some(host => host.provider === provider && (host.resumeId === resumeId || host.conversationId === JSON.stringify([provider, resumeId])))) throw new Error('Session already hosted');
          const args: string[] = [];
          if (resumeId) args.push(provider === 'codex' ? 'resume' : '--resume', resumeId);
          if (request.model) args.push('--model', String(request.model));
          const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
            && !key.startsWith('AGENT_GRAPH') && !key.startsWith('CLAUDE_CODE') && key !== 'CLAUDECODE')) as Record<string, string>;
          env.TERM = 'xterm-256color';
          // 旧キットの turn hook もこの印で採番を抑止する。利用者の cwd は引き継がない。
          if (smokeLaunch) env.AGENT_GRAPH_HEADLESS = '1';
          const terminal = (options.openTerminal ?? spawnTerminal)(location.connection ? 'ssh' : provider, location.connection ? ['-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', location.connection.destination, '--', buildLaunchCommand(cwd, provider, resumeId, request.model as string | undefined)] : args, { cwd: location.connection ? location.local : cwd, env, name: env.TERM, cols: 80, rows: 24 });
          const terminalId = randomUUID();
          const host: Host = { described: request.target !== undefined, terminalId, terminal, resumeId, provider, projectId: request.projectId as string, cwd, target, connection: location.connection, startedAt: new Date().toISOString(), startedTick: performance.now(), scrollback: Buffer.alloc(0), screen: new TerminalScreen(), inputRevision: 0, listeners: new Set() };
          host.launchModel = request.model as string | undefined;
          hosts.set(terminalId, host);
          terminal.onData(data => {
            if (host.connection && !host.remotePid) {
              const discovery = (host.discoveryBuffer ?? '') + data;
              const marker = /\x1b\]777;agent-graph-pid=(\d+)\x07/.exec(discovery);
              host.discoveryBuffer = marker ? undefined : discovery.slice(-128);
              if (marker) host.remotePid = Number(marker[1]);
            }
            host.lastOutputAt = performance.now();
            host.screen.write(data);
            const buffer = Buffer.concat([host.scrollback, Buffer.from(data)]);
            let start = Math.max(0, buffer.length - MAX_SCROLLBACK_BYTES);
            while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
            host.scrollback = Buffer.from(buffer.subarray(start));
            for (const listener of host.listeners) listener({ type: 'terminal', event: 'output', terminalId, data });
          });
          terminal.onExit(({ exitCode }) => {
            host.screen.close();
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
      if (command === 'session.commands') {
        const host = [...hosts.values()].find(host => host.conversationId === request.conversationId);
        if (host) return { commands: await listSlashCommands(host.provider!, host.cwd!, { remote: Boolean(host.connection) }) };
        if (typeof request.projectId !== 'string' || !['claude', 'codex'].includes(String(request.provider))) throw new Error('Invalid session request');
        return { commands: await listSlashCommands(request.provider as 'claude' | 'codex', await selectRoot({ projectId: request.projectId })) };
      }
      if (command === 'session.hosts') {
        await refresh();
        await Promise.all([...hosts.values()].map(recheckLocalSession));
        return { hosts: [...hosts.values()].filter(host => host.conversationId || host.disconnected).map(host => ({
          conversationId: host.conversationId!, terminalId: host.terminalId, pid: host.terminal.pid, startedAt: host.startedAt,
          ...(host.launchModel ? { launchModel: host.launchModel } : {}),
          ...(host.connection || host.described ? { provider: host.provider, cwd: host.cwd, target: host.target, projectId: host.projectId, disconnected: host.disconnected === true } : {}),
        })) };
      }
      if (command === 'session.send' || command === 'session.interrupt') {
        if (typeof request.conversationId !== 'string' || command === 'session.send' && typeof request.text !== 'string') throw new Error('Invalid session request');
        const host = [...hosts.values()].find(host => host.conversationId === request.conversationId
          || !host.conversationId && host.resumeId && JSON.stringify([host.provider ?? 'claude', host.resumeId]) === request.conversationId);
        if (!host || host.disconnected) throw new Error('no_host');
        if (command === 'session.interrupt') { host.inputRevision++; host.terminal.write('\x1b'); }
        else {
          const paths = attachments.resolve(request.attachments);
          void paths.catch(() => {});
          return await writeMessage(host, request.conversationId as string, request.text as string, paths, lifecycle);
        }
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
        host.inputRevision++;
        host.terminal.write(request.data);
      } else if (command === 'terminal.resize') {
        if (!host.listeners.has(notify)) throw new Error('Unknown terminal');
        if (![request.cols, request.rows].every(value => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 65535)) throw new Error('Invalid terminal size');
        host.terminal.resize(Number(request.cols), Number(request.rows));
        host.screen.resize(Number(request.cols), Number(request.rows));
      } else if (command === 'terminal.close') {
        if (!host.listeners.has(notify)) throw new Error('Unknown terminal');
        host.terminal.kill();
      } else throw new Error('Unknown terminal command');
      return {};
    },
    close() { closed = true; clearInterval(timer); attachments.close(); for (const host of hosts.values()) { host.mirror?.disconnect(); host.screen.close(); host.terminal.kill(); } hosts.clear(); },
  };
}
