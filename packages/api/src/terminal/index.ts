import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawn, type IPty } from 'node-pty';
import type { FilesRequest } from '../files/index.ts';

export const MAX_TERMINALS = 8;
const MAX_TERMINAL_DIMENSION = 65535;
export type TerminalNotification =
  | { type: 'terminal'; event: 'output'; terminalId: string; data: string }
  | { type: 'terminal'; event: 'exit'; terminalId: string; exitCode: number };
const require = createRequire(import.meta.url);

function prepareSpawnHelper(): void {
  if (process.platform !== 'darwin') return;
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = [resolve(root, 'build/Release/spawn-helper'), resolve(root, 'build/Debug/spawn-helper'), resolve(root, `prebuilds/${process.platform}-${process.arch}/spawn-helper`)]
    .find(path => existsSync(path));
  if (!helper) throw new Error('Terminal helper unavailable');
  const mode = statSync(helper).mode;
  // node-pty 1.1.0 の配布物では helper の実行権限が欠け、posix_spawnp が失敗する。
  if (!(mode & 0o100)) chmodSync(helper, mode | 0o100);
}

export function spawnTerminal(...args: Parameters<typeof spawn>): IPty {
  prepareSpawnHelper();
  return spawn(...args);
}

export function createTerminalSession(selectRoot: (request: FilesRequest) => Promise<string>, send: (message: TerminalNotification) => void,
  openTerminal: typeof spawn = spawnTerminal) {
  const terminals = new Map<string, IPty>();
  let opening = 0;
  let disposed = false;
  function validateSize(request: Record<string, unknown>): void {
    if (!Number.isSafeInteger(request.cols) || !Number.isSafeInteger(request.rows)
      || Number(request.cols) <= 0 || Number(request.rows) <= 0
      || Number(request.cols) > MAX_TERMINAL_DIMENSION || Number(request.rows) > MAX_TERMINAL_DIMENSION) throw new Error('Invalid terminal size');
  }
  return {
    async handle(command: string, payload: unknown) {
      if (disposed) throw new Error('Terminal connection closed');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid terminal request');
      const request = payload as Record<string, unknown>;
      if (command === 'terminal.open') {
        validateSize(request);
        if (typeof request.projectId !== 'string' || !request.projectId
          || request.worktree !== undefined && typeof request.worktree !== 'string') throw new Error('Invalid terminal project');
        if (terminals.size + opening >= MAX_TERMINALS) throw new Error('Terminal limit reached');
        opening++;
        try {
          const cwd = await selectRoot(request as unknown as FilesRequest);
          if (disposed) throw new Error('Terminal connection closed');
          const shell = process.env.SHELL || '/bin/zsh';
          const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
            !key.startsWith('AGENT_GRAPH') && value !== undefined)) as Record<string, string>;
          env.TERM = 'xterm-256color';
          const terminal = openTerminal(shell, ['-l'], { cwd, cols: Number(request.cols), rows: Number(request.rows), env, name: env.TERM });
          const terminalId = randomUUID();
          terminals.set(terminalId, terminal);
          terminal.onData(data => { if (!disposed) send({ type: 'terminal', event: 'output', terminalId, data }); });
          terminal.onExit(({ exitCode }) => {
            terminals.delete(terminalId);
            if (!disposed) send({ type: 'terminal', event: 'exit', terminalId, exitCode });
          });
          return { terminalId, cwd, shell };
        } finally { opening--; }
      }
      if (typeof request.terminalId !== 'string') throw new Error('Invalid terminal id');
      const terminal = terminals.get(request.terminalId);
      if (!terminal) throw new Error('Unknown terminal');
      if (command === 'terminal.input') {
        if (typeof request.data !== 'string') throw new Error('Invalid terminal input');
        terminal.write(request.data);
      } else if (command === 'terminal.resize') {
        validateSize(request);
        terminal.resize(Number(request.cols), Number(request.rows));
      } else if (command === 'terminal.close') terminal.kill();
      else throw new Error('Unknown terminal command');
      return {};
    },
    close() {
      disposed = true;
      for (const terminal of terminals.values()) terminal.kill();
      terminals.clear();
    },
  };
}
