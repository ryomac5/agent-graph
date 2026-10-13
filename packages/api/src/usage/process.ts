import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir } from 'node:fs/promises';
import { asRecord } from './parsers.ts';

const PROCESS_TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export const CODEX_ARGS = ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server'];
export type SpawnUsage = typeof spawn;
export const CLAUDE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
export async function probeClaude(command: string, cwd: string, launch: SpawnUsage = spawn, environment: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  await mkdir(cwd, { recursive: true });
  // 認証は引き継ぎ、hook の出力先と親の会話からは隔離する。
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('AGENT_GRAPH_')
    && !['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'HERDR_PANE_ID'].includes(key)));
  env.AGENT_GRAPH_PROJECT = cwd;
  env.CLAUDE_PROJECT_DIR = cwd;
  return new Promise((resolve, reject) => {
    const child = launch(command, CLAUDE_ARGS, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
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
    lines.on('line', line => {
      let event;
      try { event = asRecord(JSON.parse(line)); } catch { return; }
      const response = asRecord(event.response);
      if (event.type !== 'control_response' || response.request_id !== 'usage') return;
      const limits = asRecord(response.response).rate_limits;
      finish(response.subtype === 'error' || !limits ? 'command_failed' : undefined, limits);
    });
    child.stdin.end(`${JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
  });
}
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
