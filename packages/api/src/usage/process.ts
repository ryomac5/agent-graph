import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { asRecord } from './parsers.ts';

const PROCESS_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export const CODEX_ARGS = ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server'];
export type SpawnUsage = typeof spawn;
export function runUsageCommand(command: string, args: string[], launch: SpawnUsage = spawn): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = launch(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, PROCESS_TIMEOUT_MS);
    child.stdout!.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) { child.kill('SIGKILL'); reject(new Error('invalid_data')); }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('command_unavailable')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error('command_failed')); });
  });
}
export function probeCodex(command: string, launch: SpawnUsage = spawn): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = launch(command, CODEX_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    let bytes = 0;
    const finish = (error?: string, result?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); lines.close(); child.kill('SIGKILL');
      error ? reject(new Error(error)) : resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), PROCESS_TIMEOUT_MS);
    child.once('error', () => finish('command_unavailable'));
    child.once('close', () => finish('command_failed'));
    child.stdin.on('error', () => finish('command_failed'));
    child.stderr.resume();
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT_BYTES) finish('invalid_data'); });
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    lines.on('line', line => {
      let value;
      try { value = asRecord(JSON.parse(line)); } catch { finish('invalid_data'); return; }
      if (value.id === 1) {
        if (value.error) { finish('command_failed'); return; }
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else if (value.id === 2) finish(value.error ? 'command_failed' : undefined, value.result);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-graph-usage', version: '1.0.0' }, capabilities: {} } });
  });
}
