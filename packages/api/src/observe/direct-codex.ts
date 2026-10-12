import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readLedgerDatabase } from '../../../core/src/ledger/repository.ts';
import { createNativeId } from '../../../core/src/ledger/index.ts';
import type { Fact, Ledger } from '../../../core/src/ledger/index.ts';
import { readSessionMeta } from './codex/files.ts';

const START_WINDOW_MS = 120_000;
const PREFIX_LINES = 3;
const READ_BYTES = 64 * 1024;
export interface DirectLaunch { cwd?: string; promptPath?: string }
export interface Launch extends DirectLaunch { parent: string; toolUseId: string; timestamp: string; key: string }
export interface RolloutRequest { id: string; timestamp: string; cwd: string; prompt: string; heading?: string }
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
export function readRolloutRequest(path: string, meta = readSessionMeta(path)): RolloutRequest | undefined {
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

export const DIRECT_REQUEST_CACHE_LIMIT = 16_384;

/** 起動の本文と所属だけを逐次読み、無関係な会話と関係は取り出さない。 */
export function prepareDirectFacts(db: DatabaseSync) {
  return db.prepare(`SELECT * FROM facts f WHERE seq > ? AND seq <= ? AND source = 'transcript-claude' AND (
    kind = 'message.created' AND instr(payload, 'codex exec') > 0
    OR kind = 'message_membership.created' AND EXISTS (
      SELECT 1 FROM facts m WHERE m.subject = 'message:' || json_extract(f.payload, '$.message_id')
      AND m.kind = 'message.created' AND m.source = 'transcript-claude' AND instr(m.payload, 'codex exec') > 0
    )) ORDER BY seq`);
}

interface DirectCodexReaders {
  cacheLimit?: number;
  readMeta?: typeof readSessionMeta;
  readRequest?: typeof readRolloutRequest;
}
export function createDirectCodexObserver(ledger: Ledger, db: DatabaseSync = readLedgerDatabase(ledger), readers: DirectCodexReaders = {}) {
  const cacheLimit = readers.cacheLimit ?? DIRECT_REQUEST_CACHE_LIMIT;
  if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0) throw new RangeError('cacheLimit must be a nonnegative safe integer');
  const readMeta = readers.readMeta ?? readSessionMeta;
  const readRequest = readers.readRequest ?? readRolloutRequest;
  let through = 0;
  const launches = new Map<string, Launch>();
  const requests = new Map<string, { stamp: string; meta?: ReturnType<typeof readSessionMeta>; started: number; cwd: string; requestRead: boolean; request?: RolloutRequest }>();
  const readMessage = db.prepare("SELECT payload, source_ts FROM facts WHERE subject = ? AND kind = 'message.created' ORDER BY seq DESC LIMIT 1");
  const readMemberships = db.prepare(`SELECT json_extract(payload, '$.conversation_id') AS parent FROM facts
    WHERE seq IN (SELECT seq FROM fact_projection_dependencies WHERE projection = 'message_memberships'
      AND direction = 'needs' AND key = 'message:' || ?) AND kind = 'message_membership.created'
    AND json_extract(payload, '$.active') IS NOT 0`);
  const readLocation = db.prepare(`SELECT json_extract(payload, '$.cwd') AS cwd FROM facts WHERE subject = ?
    AND kind LIKE 'conversation.%' AND json_type(payload, '$.cwd') = 'text' ORDER BY seq DESC LIMIT 1`);
  const readLinked = db.prepare(`SELECT 1 FROM facts WHERE seq IN (
      SELECT seq FROM fact_projection_dependencies WHERE projection = 'relations' AND direction = 'needs' AND key = 'conversation:' || ?)
    AND kind = 'relation.created' AND json_extract(payload, '$.type') = 'delegated'
    AND json_extract(payload, '$.to_id') = ? LIMIT 1`);
  const readCompleted = db.prepare(`SELECT 1 FROM facts WHERE seq IN (
      SELECT seq FROM fact_projection_dependencies WHERE projection = 'relations' AND direction = 'needs' AND key = 'conversation:' || ?)
    AND kind = 'relation.created' AND json_extract(payload, '$.type') = 'delegated'
    AND json_extract(payload, '$.evidence.launchKey') = ? LIMIT 1`);
  function addLaunches(id: string, payload: Record<string, unknown>, timestamp: string) {
    const body = payload.body;
    if (payload.provider !== 'claude' || payload.role !== 'assistant' || !Array.isArray(body)) return;
    const parents = readMemberships.all(id).map(row => String(row.parent));
    for (const block of body) {
      const tool = readObject(block);
      if (tool.type !== 'tool_use' || tool.name !== 'Bash') continue;
      findCodexExecs(readText(readObject(tool.input).command)).forEach((command, index) => {
        for (const parent of parents.length ? parents : ['']) {
          const key = JSON.stringify([parent, tool.id, index]);
          if (parent && readCompleted.get(parent, key)) { launches.delete(key); continue; }
          launches.set(key, { ...command, parent, toolUseId: readText(tool.id), timestamp, key });
        }
        if (parents.length) launches.delete(JSON.stringify(['', tool.id, index]));
      });
    }
  }
  const promptStamps = new Map<string, string>();
  function readStamp(path: string): string {
    try { const stat = statSync(path); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
    catch (error) {
      if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(String(error.code))) return "missing";
      throw error;
    }
  }
  const observe = function observe(facts: Iterable<Fact>, paths: string[], observedTs = new Date().toISOString(), changedPaths?: ReadonlySet<string>) {
    for (const fact of facts) {
      if (fact.seq <= through) continue;
      through = Math.max(through, fact.seq);
      const payload = readObject(fact.payload);
      if (fact.kind === 'message.created') addLaunches(fact.subject.slice('message:'.length), payload, fact.source_ts);
      if (fact.kind === 'message_membership.created') {
        const id = readText(payload.message_id);
        const message = readMessage.get('message:' + id);
        if (message) addLaunches(id, readObject(JSON.parse(String(message.payload))), String(message.source_ts));
      }
    }
    // 場所は後着し得るため、未結合の起動にだけ SQL でその都度補う。
    const pendingLaunches: Launch[] = [];
    for (const [key, launch] of launches) {
      if (!launch.parent) continue;
      if (readCompleted.get(launch.parent, key)) { launches.delete(key); continue; }
      const parentCwd = readLocation.get('conversation:' + launch.parent)?.cwd;
      const cwd = typeof parentCwd === 'string' ? parentCwd : undefined;
      pendingLaunches.push({ ...launch,
        promptPath: launch.promptPath ? resolve(cwd ?? '.', launch.promptPath) : undefined,
        cwd: launch.cwd ? resolve(cwd ?? '.', launch.cwd) : cwd });
    }
    if (!pendingLaunches.length) { promptStamps.clear(); return { detected: 0, matched: 0, appended: 0 }; }
    const contexts = new Map<string, number[]>();
    for (const launch of pendingLaunches) {
      if (!launch.cwd) continue;
      const cwd = resolve(launch.cwd);
      if (!contexts.has(cwd)) contexts.set(cwd, []);
      contexts.get(cwd)!.push(Date.parse(launch.timestamp));
    }
    const rolloutIndex = new Map<string, RolloutRequest>();
    const seen = new Set(paths);
    for (const path of requests.keys()) if (!seen.has(path)) requests.delete(path);
    // 周期中の eviction で先頭のファイルから読み直し続けることを避ける。
    const cacheable = new Set(paths.slice(0, cacheLimit));
    for (const path of requests.keys()) if (!cacheable.has(path)) requests.delete(path);
    for (const path of paths) {
      try {
        let cached = requests.get(path);
        if (!cached || !changedPaths || changedPaths.has(path)) {
          const stat = statSync(path);
          const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          if (!cached || cached.stamp !== stamp) {
            const meta = readMeta(path);
            cached = { stamp, meta, started: Date.parse(meta?.timestamp ?? ''), cwd: meta?.cwd ? resolve(meta.cwd) : '', requestRead: false };
            if (cacheable.has(path)) requests.set(path, cached);
          }
        }
        const meta = cached.meta;
        if (!meta?.id || !meta.timestamp || !meta.cwd
          || !contexts.get(cached.cwd)?.some(started => cached!.started >= started && cached!.started - started <= START_WINDOW_MS)) {
          cached.request = undefined; cached.requestRead = false; continue;
        }
        if (readLinked.get(createNativeId('codex', meta.id), createNativeId('codex', meta.id))) { cached.request = undefined; continue; }
        if (!cached.requestRead) {
          const request = readRequest(path, meta);
          // 比較の先頭と表示の見出しだけを保持し、依頼の本文は持たない。
          cached.request = request ? { ...request, prompt: readPrefix(request.prompt), heading: readRequestHeading(request.prompt) } : undefined;
          cached.requestRead = true;
        }
        if (cached.request) rolloutIndex.set(cached.request.id, cached.request);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        requests.delete(path);
      }
    }
    const rollouts = [...rolloutIndex.values()];
    promptStamps.clear();
    const candidates = pendingLaunches.map(launch => {
      if (launch.promptPath) promptStamps.set(launch.promptPath, readStamp(launch.promptPath));
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
          evidence: { launchKey: launch.key, toolUseId: launch.toolUseId, agentType: 'codex-exec', description: prompt === undefined ? rollout.heading ?? readRequestHeading(rollout.prompt) : readRequestHeading(prompt),
            promptPath: launch.promptPath ?? null, promptMatched: prompt !== undefined, cwd: rollout.cwd, started_ts: rollout.timestamp } } });
      if (result.status === 'conflict') throw new Error(`Conflicting direct Codex relation: ${eventId}`);
      matched++; if (result.status === 'appended') appended++;
      launches.delete(launch.key);
      for (const cached of requests.values()) if (cached.request?.id === rollout.id) cached.request = undefined;
    }
    return { detected: candidates.length, matched, appended };
  };
  return Object.assign(observe, { hasChangedPrompts() {
    for (const [path, stamp] of promptStamps) if (readStamp(path) !== stamp) return true;
    return false;
  } });
}
