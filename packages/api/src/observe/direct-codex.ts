import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createNativeId } from '../../../core/src/ledger/index.ts';
import type { Fact, Ledger } from '../../../core/src/ledger/index.ts';
import { readSessionMeta } from './codex/files.ts';

const START_WINDOW_MS = 120_000;
const PREFIX_LINES = 3;
const READ_BYTES = 64 * 1024;
export interface DirectLaunch { cwd?: string; promptPath?: string }
export interface Launch extends DirectLaunch { parent: string; toolUseId: string; timestamp: string; key: string }
export interface RolloutRequest { id: string; timestamp: string; cwd: string; prompt: string }
function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readText(value: unknown): string { return typeof value === 'string' ? value : ''; }

/** 引用符とリダイレクトを分け、背景実行の括弧も命令の境界として扱う。展開や実行はしない。 */
export function findCodexExecs(command: string): DirectLaunch[] {
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s<>;&|()]+|&&|\|\||[<>;&|()]/g) ?? [];
  const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/s, '$2');
  const launches: DirectLaunch[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (basename(unquote(tokens[i])) !== 'codex' || tokens[i + 1] !== 'exec') continue;
    // echo 等の引数に書かれた codex exec を起動と取り違えない。
    const preceding = tokens.slice(0, i).reverse().find(token => !/^\w+=/.test(token));
    if (preceding && ![';', '&', '&&', '|', '||', '(', ')', 'command', 'exec'].includes(preceding)) continue;
    const launch: DirectLaunch = {};
    for (let j = i + 2; j < tokens.length && ![';', '&', '&&', '|', '||', ')'].includes(tokens[j]); j++) {
      const token = tokens[j];
      if (['-C', '--cd'].includes(token) && tokens[j + 1]) launch.cwd = unquote(tokens[++j]);
      else if (token.startsWith('--cd=')) launch.cwd = unquote(token.slice(5));
      else if (token === '<' && tokens[j + 1] && tokens[j + 1] !== '<') launch.promptPath = unquote(tokens[++j]);
    }
    launches.push(launch);
  }
  return launches;
}
function readPrefix(text: string): string {
  return text.trim().split(/\r?\n/).slice(0, PREFIX_LINES).map(line => line.trim()).join('\n');
}
export function readRequestHeading(text: string): string {
  return text.split(/\r?\n/).find(line => /^\s*#{1,6}\s+\S/.test(line))?.trim() ?? '';
}
function matchesLaunchContext(launch: Launch, rollout: { timestamp: string; cwd: string }): boolean {
  const elapsed = Date.parse(rollout.timestamp) - Date.parse(launch.timestamp);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= START_WINDOW_MS
    && Boolean(launch.cwd) && resolve(launch.cwd!) === resolve(rollout.cwd);
}
export function matchesCodexExec(launch: Launch, rollout: RolloutRequest, prompt?: string): boolean {
  return matchesLaunchContext(launch, rollout) && Boolean(rollout.prompt.trim()) && (prompt === undefined || Boolean(prompt.trim()) && readPrefix(prompt) === readPrefix(rollout.prompt));
}
function readPrompt(path: string | undefined, cwd: string | undefined): string | undefined {
  if (!path) return undefined;
  try { return readFileSync(resolve(cwd ?? '.', path), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(String(error.code))) return undefined;
    throw error;
  }
}
/** 最初の依頼までを読み、長い rollout の残りは読まない。環境の注入文は依頼から除く。 */
export function readRolloutRequest(path: string): RolloutRequest | undefined {
  const meta = readSessionMeta(path);
  if (!meta?.id || !meta.timestamp || !meta.cwd) return undefined;
  const fd = openSync(path, 'r');
  try {
    let pending = Buffer.alloc(0);
    const buffer = Buffer.alloc(READ_BYTES);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) return undefined;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let start = 0;
      for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10, start)) {
        const raw = pending.subarray(start, end).toString('utf8');
        start = end + 1;
        let row;
        try { row = readObject(JSON.parse(raw)); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        const payload = readObject(row.payload);
        let prompt = '';
        if (row.type === 'event_msg' && payload.type === 'user_message') prompt = readText(payload.message);
        if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
          prompt = Array.isArray(payload.content) ? payload.content.map(item => readText(readObject(item).text)).join('\n') : readText(payload.content);
        }
        if (!prompt || prompt.startsWith('# AGENTS.md instructions') || prompt.startsWith('<environment_context>')) continue;
        return { id: meta.id, timestamp: meta.timestamp, cwd: meta.cwd, prompt };
      }
      pending = Buffer.from(pending.subarray(start));
    }
  } finally { closeSync(fd); }
}

export function createDirectCodexObserver(ledger: Ledger) {
  let through = 0;
  const messages = new Map<string, Fact>();
  const memberships = new Map<string, Set<string>>();
  const locations = new Map<string, string>();
  const launches = new Map<string, Launch>();
  const linked = new Set<string>();
  const completed = new Set<string>();
  const requests = new Map<string, { stamp: string; meta?: ReturnType<typeof readSessionMeta>; request?: RolloutRequest }>();
  return function observe(facts: Fact[], paths: string[], observedTs = new Date().toISOString()) {
    const changed = new Set<string>();
    for (const fact of facts) {
      if (fact.seq <= through) continue;
      through = Math.max(through, fact.seq);
      const payload = readObject(fact.payload);
      if (fact.kind.startsWith('conversation.') && typeof payload.cwd === 'string') locations.set(fact.subject.slice('conversation:'.length), payload.cwd);
      if (fact.kind === 'relation.created' && payload.type === 'delegated') {
        linked.add(readText(payload.to_id));
        const key = readText(readObject(payload.evidence).launchKey);
        if (key) { completed.add(key); launches.delete(key); }
      }
      if (fact.kind === 'message.created' && payload.provider === 'claude' && payload.role === 'assistant') {
        const id = fact.subject.slice('message:'.length); messages.set(id, fact); changed.add(id);
      }
      if (fact.kind === 'message_membership.created' && payload.active !== false) {
        const id = readText(payload.message_id);
        if (!memberships.has(id)) memberships.set(id, new Set());
        memberships.get(id)!.add(readText(payload.conversation_id)); changed.add(id);
      }
    }
    for (const id of changed) {
      const fact = messages.get(id);
      const body = readObject(fact?.payload).body;
      if (!fact || !Array.isArray(body)) continue;
      for (const block of body) {
        const tool = readObject(block);
        if (tool.type !== 'tool_use' || tool.name !== 'Bash') continue;
        const commands = findCodexExecs(readText(readObject(tool.input).command));
        for (const parent of memberships.get(id) ?? []) commands.forEach((command, index) => {
          const key = JSON.stringify([parent, tool.id, index]);
          if (completed.has(key)) return;
          const parentCwd = locations.get(parent);
          launches.set(key, { ...command, parent,
            promptPath: command.promptPath ? resolve(parentCwd ?? '.', command.promptPath) : undefined,
            cwd: command.cwd ? resolve(parentCwd ?? '.', command.cwd) : parentCwd,
            toolUseId: readText(tool.id), timestamp: fact.source_ts, key });
        });
      }
    }
    if (!launches.size) return { detected: 0, matched: 0, appended: 0 };
    const pendingLaunches = [...launches.values()];
    const rolloutIndex = new Map<string, RolloutRequest>();
    for (const path of paths) {
      try {
        const stat = statSync(path);
        const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        let cached = requests.get(path);
        if (!cached || cached.stamp !== stamp) {
          cached = { stamp, meta: readSessionMeta(path) }; requests.set(path, cached);
        }
        const meta = cached.meta;
        if (!cached.request && meta?.id && meta.timestamp && meta.cwd && !linked.has(createNativeId('codex', meta.id))
          && pendingLaunches.some(launch => matchesLaunchContext(launch, { timestamp: meta.timestamp!, cwd: meta.cwd! }))) {
          cached.request = readRolloutRequest(path);
        }
        if (cached.request && !linked.has(createNativeId('codex', cached.request.id))) rolloutIndex.set(cached.request.id, cached.request);
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    const rollouts = [...rolloutIndex.values()];
    const candidates = pendingLaunches.map(launch => {
      const prompt = readPrompt(launch.promptPath, launch.cwd);
      return { launch, prompt, matches: rollouts.filter(rollout => matchesCodexExec(launch, rollout, prompt)) };
    });
    let matched = 0;
    let appended = 0;
    for (const { launch, prompt, matches } of candidates) {
      if (matches.length !== 1) continue;
      const rollout = matches[0];
      // 同じ子を複数の命令が指す場合も、推定で選ばない。
      if (candidates.filter(item => item.matches.some(match => match.id === rollout.id)).length !== 1) continue;
      const child = createNativeId('codex', rollout.id);
      const eventId = `direct-codex:${launch.key}:${child}`;
      const result = ledger.append({ source: 'transcript-claude', source_event_id: eventId, source_ts: launch.timestamp,
        observed_ts: observedTs, kind: 'relation.created', subject: `relation:${eventId}`, confidence: 'inferred',
        payload: { type: 'delegated', from_id: launch.parent, to_id: child, active: true, confidence: 'inferred',
          evidence: { launchKey: launch.key, toolUseId: launch.toolUseId, agentType: 'codex-exec', description: readRequestHeading(prompt ?? rollout.prompt),
            promptPath: launch.promptPath ?? null, promptMatched: prompt !== undefined, cwd: rollout.cwd, started_ts: rollout.timestamp } } });
      if (result.status === 'conflict') throw new Error(`Conflicting direct Codex relation: ${eventId}`);
      matched++; if (result.status === 'appended') appended++;
      linked.add(child); completed.add(launch.key); launches.delete(launch.key);
    }
    return { detected: candidates.length, matched, appended };
  };
}
