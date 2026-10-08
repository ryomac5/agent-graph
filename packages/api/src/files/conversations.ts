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

export function createCommitConversationIndex(db: DatabaseSync) {
  let revision = '';
  let evidence: CommitEvidence[] = [];
  return (commits: readonly Commit[]) => {
    const state = db.prepare('SELECT generation, last_seq FROM projection_state WHERE id = 1').get()!;
    // 再構築と追記の両方で更新し、変化のない投影の本文は読み直さない。
    const next = `${state.generation}:${state.last_seq}`;
    if (next !== revision) {
      const calls = db.prepare(`SELECT m.body, m.source_ts, mm.conversation_id FROM messages m
        JOIN message_memberships mm ON mm.message_id = m.id AND mm.active = 1
        WHERE m.provider = 'claude' AND m.role = 'assistant'
          AND (instr(m.body, 'git commit') > 0 OR instr(m.body, 'git -C ') > 0 OR instr(m.body, 'git merge') > 0)`).all() as unknown as Message[];
      const results = db.prepare(`WITH tools AS MATERIALIZED (
        SELECT cm.conversation_id, json_extract(b.value, '$.id') AS tool_id FROM messages c
        JOIN message_memberships cm ON cm.message_id = c.id AND cm.active = 1
        JOIN json_each(CASE WHEN json_type(c.body) = 'array' THEN c.body ELSE '[]' END) b ON b.type = 'object'
        WHERE c.provider = 'claude' AND c.role = 'assistant'
          AND (instr(c.body, 'git commit') > 0 OR instr(c.body, 'git -C ') > 0 OR instr(c.body, 'git merge') > 0)
          AND json_extract(b.value, '$.type') = 'tool_use' AND json_extract(b.value, '$.name') = 'Bash')
        SELECT DISTINCT m.id, m.body, m.source_ts, mm.conversation_id FROM tools t
        JOIN message_memberships mm ON mm.conversation_id = t.conversation_id AND mm.active = 1
        JOIN messages m ON m.id = mm.message_id
        WHERE m.provider = 'claude' AND m.role = 'user' AND instr(m.body, t.tool_id) > 0
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(m.body) = 'array' THEN m.body ELSE '[]' END) b WHERE b.type = 'object' AND json_extract(b.value, '$.type') = 'tool_result'
            AND json_extract(b.value, '$.tool_use_id') = t.tool_id)`).all() as unknown as Message[];
      const decode = (message: Message): Message => ({ ...message, body: JSON.parse(String(message.body)) });
      evidence = extractCommitEvidence(calls.map(decode), results.map(decode));
      revision = next;
    }
    return matchCommitConversations(commits, evidence);
  };
}
