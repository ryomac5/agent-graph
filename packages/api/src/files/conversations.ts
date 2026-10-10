import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';

interface Message { body: unknown; source_ts: string; conversation_id: string }
export interface CommitEvidence { hashes: string[]; subject?: string; time: string; conversationId: string; merge: boolean }
interface Commit { hash: string; subject: string; time: string; parents: string[] }

function readBlocks(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object');
  return [];
}
function readText(content: unknown): string {
  if (typeof content === 'string') return content;
  return readBlocks(content).map(block => typeof block.text === 'string' ? block.text : '').join('\n');
}
function readSubject(command: string): string | undefined {
  const match = /(?:^|\s)-m\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|]+))/.exec(command);
  if (!match) return undefined;
  // Claude が使う heredoc の先頭の段落も、git の件名として読む。
  if ((match[1] ?? match[3])?.startsWith('$(cat')) {
    const heredoc = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\1\b/.exec(command);
    return heredoc?.[2].split(/\r?\n\s*\r?\n/)[0].trim().replace(/\r?\n/g, ' ');
  }
  return (match[1]?.replace(/\\(["\\$`])/g, '$1') ?? match[2] ?? match[3]).split(/\r?\n\s*\r?\n/)[0].trim().replace(/\r?\n/g, ' ');
}

export function extractCommitEvidence(calls: readonly Message[], results: readonly Message[]): CommitEvidence[] {
  const outputs = new Map<string, Record<string, unknown>[]>();
  for (const message of results) for (const block of readBlocks(message.body)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
    const key = JSON.stringify([message.conversation_id, block.tool_use_id]);
    outputs.set(key, [...outputs.get(key) ?? [], block]);
  }
  const evidence: CommitEvidence[] = [];
  for (const message of calls) for (const block of readBlocks(message.body)) {
    if (block.type !== 'tool_use' || block.name !== 'Bash' || typeof block.id !== 'string') continue;
    const input = block.input as { command?: unknown } | undefined;
    if (typeof input?.command !== 'string') continue;
    const invocation = /(^|[;&|(\s])git( -C \S+)? (commit|merge)\b/.exec(input.command);
    if (!invocation) continue;
    const command = input.command.slice(invocation.index + invocation[1].length);
    if (/(?:^|\s)--help\b/.test(command.split(/[;&|\n]/)[0])) continue;
    const output = outputs.get(JSON.stringify([message.conversation_id, block.id]))?.filter(value => value.is_error !== true);
    if (!output?.length) continue;
    const text = output.map(value => readText(value.content)).join('\n');
    const hashes = [...text.matchAll(/^\[[^\]\n]+? (?:\(root-commit\) )?([a-f\d]{7,64})\]|^([a-f\d]{7,64})\s+\S/gim)]
      .map(match => (match[1] ?? match[2]).toLowerCase());
    evidence.push({ hashes: [...new Set(hashes)], subject: hashes.length ? undefined : readSubject(command),
      time: message.source_ts, conversationId: message.conversation_id, merge: invocation[3] === 'merge' });
  }
  return evidence;
}

export function matchCommitConversations(commits: readonly Commit[], evidence: readonly CommitEvidence[]): Map<string, string[]> {
  const matches = new Map(commits.map(commit => [commit.hash, new Set<string>()]));
  for (const call of evidence) {
    const candidates = commits.filter(commit => (commit.parents.length > 1) === call.merge);
    if (call.hashes.length) {
      for (const prefix of call.hashes) {
        const found = candidates.filter(commit => commit.hash.toLowerCase().startsWith(prefix));
        if (found.length === 1) matches.get(found[0].hash)!.add(call.conversationId);
      }
    } else if (call.subject) {
      const found = candidates.filter(commit => commit.subject === call.subject).toSorted((a, b) =>
        Math.abs(Date.parse(a.time) - Date.parse(call.time)) - Math.abs(Date.parse(b.time) - Date.parse(call.time)));
      if (found[0]) matches.get(found[0].hash)!.add(call.conversationId);
    }
  }
  return new Map([...matches].map(([hash, ids]) => [hash, [...ids].sort()]));
}

const INDEX_BATCH_SIZE = 250;
const INDEX_POLL_MS = 500;

export function createLocalCommitConversationIndex(db: DatabaseSync, publish: (evidence: CommitEvidence[], state: { generation: number; sequence: number; ready: boolean }) => void = () => {}, keepAlive = false) {
  let generation = -1;
  let sequence = 0;
  let cursor = 0;
  let scanning = true;
  let closed = false;
  let evidence: CommitEvidence[] = [];
  const messages = new Map<string, Message[]>();
  let pending: ReturnType<typeof setTimeout> | ReturnType<typeof setImmediate>;
  const readState = db.prepare('SELECT generation, last_seq FROM projection_state WHERE id = 1');
  const readMessages = db.prepare(`SELECT m.id, m.body, m.source_ts, mm.conversation_id FROM messages m
    JOIN message_memberships mm ON mm.message_id = m.id AND mm.active = 1
    WHERE m.id = ? AND m.provider = 'claude' AND m.role IN ('assistant', 'user')`);
  function updateMessage(id: string) {
    messages.delete(id);
    const rows = readMessages.all(id);
    const retained: Message[] = [];
    for (const row of rows) {
      const body = readBlocks(JSON.parse(String(row.body))).filter(block =>
        block.type === 'tool_result' || block.type === 'tool_use' && block.name === 'Bash'
          && /git(?: -C \S+)? (?:commit|merge)\b/.test(String((block.input as { command?: unknown })?.command ?? '')));
      for (const block of body) if (block.type === 'tool_result') {
        const text = readText(block.content);
        block.content = [...text.matchAll(/^\[[^\]\n]+? (?:\(root-commit\) )?([a-f\d]{7,64})\]|^([a-f\d]{7,64})\s+\S/gim)].map(match => match[0]).join('\n');
      }
      if (body.length) retained.push({ body, source_ts: String(row.source_ts), conversation_id: String(row.conversation_id) });
    }
    if (retained.length) messages.set(id, retained);
  }
  function refreshEvidence() {
    const calls: Message[] = [];
    const results: Message[] = [];
    for (const rows of messages.values()) for (const message of rows) {
      if (readBlocks(message.body).some(block => block.type === 'tool_use')) calls.push(message);
      if (readBlocks(message.body).some(block => block.type === 'tool_result')) results.push(message);
    }
    evidence = extractCommitEvidence(calls, results);
    publish(evidence, { generation, sequence, ready: !scanning });
  }
  function schedule(immediate: boolean) {
    pending = immediate ? setImmediate(advance) : setTimeout(advance, INDEX_POLL_MS);
    if (!keepAlive) pending.unref();
  }
  function advance() {
    if (closed) return;
    try {
      const state = readState.get()!;
      if (generation !== Number(state.generation) || sequence > Number(state.last_seq)) {
        generation = Number(state.generation); sequence = Number(state.last_seq); cursor = 0; scanning = true;
        messages.clear(); evidence = []; publish(evidence, { generation, sequence, ready: false });
      }
      if (scanning) {
        const rows = db.prepare('SELECT rowid AS position, id FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?').all(cursor, INDEX_BATCH_SIZE);
        for (const row of rows) { updateMessage(String(row.id)); cursor = Number(row.position); }
        scanning = rows.length === INDEX_BATCH_SIZE;
        if (!scanning) refreshEvidence();
        schedule(scanning); return;
      }
      const rows = db.prepare('SELECT seq, kind, subject FROM facts WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?').all(sequence, Number(state.last_seq), INDEX_BATCH_SIZE);
      let changed = false;
      for (const row of rows) {
        const kind = String(row.kind).split('.')[0];
        if (kind === 'conversation') {
          const id = String(row.subject).slice('conversation:'.length);
          const record = db.prepare("SELECT data FROM entity_records WHERE entity = 'conversation' AND id = ?").get(id);
          const data = record ? JSON.parse(String(record.data)) : {};
          const ids = [id, data.provider && data.native_id ? JSON.stringify([data.provider, data.native_id]) : id];
          const affected = new Set(db.prepare('SELECT message_id FROM message_memberships WHERE conversation_id IN (?, ?)').all(...ids).map(row => String(row.message_id)));
          for (const [messageId, rows] of messages) if (rows.some(message => ids.includes(message.conversation_id))) affected.add(messageId);
          for (const messageId of affected) updateMessage(messageId);
          changed ||= affected.size > 0;
        }
        if (kind === 'message' || kind === 'message_membership') {
          const record = db.prepare('SELECT data FROM entity_records WHERE entity = ? AND id = ?').get(kind, String(row.subject).slice(kind.length + 1));
          if (record) {
            const data = JSON.parse(String(record.data));
            const id = kind === 'message' ? data.provider && data.native_id ? JSON.stringify([data.provider, data.native_id]) : data.id : data.message_id;
            if (id) {
              const message = db.prepare("SELECT data FROM entity_records WHERE entity = 'message' AND id = ?").get(id);
              const value = message ? JSON.parse(String(message.data)) : {};
              const canonical = value.provider && value.native_id ? JSON.stringify([value.provider, value.native_id]) : id;
              updateMessage(canonical); changed = true;
            }
          }
        }
        sequence = Number(row.seq);
      }
      if (changed) refreshEvidence();
      else if (rows.length) publish(evidence, { generation, sequence, ready: true });
      schedule(rows.length === INDEX_BATCH_SIZE);
    } catch (error) {
      // 接続が閉じられたら常駐の読み取りも終える。
      if (error instanceof Error && /database is not open|database has been closed/i.test(error.message)) { closed = true; return; }
      throw error;
    }
  }
  schedule(false);
  const read = (commits: readonly Commit[]) => matchCommitConversations(commits, evidence);
  return Object.assign(read, {
    refresh: advance,
    pending: () => scanning,
    close() { closed = true; clearTimeout(pending as ReturnType<typeof setTimeout>); clearImmediate(pending as ReturnType<typeof setImmediate>); },
  });
}

export function createCommitConversationIndex(db: DatabaseSync) {
  const path = String(db.prepare('PRAGMA database_list').get()?.file ?? '');
  if (!path) return createLocalCommitConversationIndex(db);
  let evidence: CommitEvidence[] = [];
  let indexed = { generation: -1, sequence: -1, ready: false };
  let worker: Worker | undefined;
  function start() {
    if (worker) return;
    worker = new Worker(new URL('./conversation-worker.ts', import.meta.url), { workerData: path });
    worker.on('message', (next: { evidence: CommitEvidence[]; state: typeof indexed }) => { evidence = next.evidence; indexed = next.state; });
    worker.on('error', () => { evidence = []; });
    worker.unref();
  }
  return Object.assign((commits: readonly Commit[]) => { start(); return matchCommitConversations(commits, evidence); }, {
    pending() {
      const state = db.prepare('SELECT generation, last_seq FROM projection_state WHERE id = 1').get()!;
      return !indexed.ready || indexed.generation !== Number(state.generation) || indexed.sequence < Number(state.last_seq);
    },
    close() { void worker?.terminate(); },
  });
}
