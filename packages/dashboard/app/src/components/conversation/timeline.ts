import { harnessKind } from '../../lib/message-body.ts';
import { isBlank, isToolOnly } from './Message.tsx';
import { isDelegationTool } from './DelegationCard.tsx';
import { messageSignature, readBody, readObject, readText, type TimelineEntry } from './model.ts';
import type { Row } from '../../lib/store.ts';

export type DisplayEntry = TimelineEntry | { [Kind in 'tools' | 'instructions' | 'project']: { kind: Kind; key: string; rows: TimelineEntry[] } }['tools' | 'instructions' | 'project'];
export function instructionKind(row: Row): 'instructions' | 'project' | undefined {
  if (['developer', 'system'].includes(readText(row.role))) return 'instructions';
  if (row.role === 'user' && /^(?:# AGENTS\.md\b|<INSTRUCTIONS>)/.test(readBody(row.body).trimStart())) return 'project';
}
/** 見える発言を基準に、空の区切りと内部の履歴を整理する。 */
export function groupToolRuns(entries: TimelineEntry[]): DisplayEntry[] {
  const grouped: DisplayEntry[] = [];
  const seen = new Set<string>();
  let hasVisible = false;
  let responseTools: Extract<DisplayEntry, { kind: 'tools' }> | undefined;
  let turnId: unknown;
  const calls = new Set(entries.flatMap(entry => entry.kind === 'message' && Array.isArray(entry.row.body) ? entry.row.body.map(readObject).filter(block => block.type === 'tool_use').map(block => block.id) : []));
  for (const entry of entries) {
    if (entry.kind === 'message') {
      const signature = messageSignature(entry.row, entry.time);
      if (seen.has(signature)) continue;
      seen.add(signature);
      if (isBlank(entry.row) || harnessKind(readBody(entry.row.body)) === 'notification') continue;
      if (isToolOnly(entry.row) && Array.isArray(entry.row.body) && entry.row.body.map(readObject).every(block => block.type === 'tool_result' && calls.has(block.tool_use_id))) continue;
      const instruction = instructionKind(entry.row);
      if (instruction) {
        const last = grouped.at(-1);
        if (last?.kind === instruction) last.rows.push(entry);
        else grouped.push({ kind: instruction, key: entry.key, rows: [entry] });
        hasVisible = true;
        continue;
      }
    }
    if (entry.kind === 'boundary') {
      responseTools = undefined;
      if (!hasVisible) continue;
      const last = grouped.at(-1);
      if (last?.kind === 'boundary') {
        // 要約の区切りは継続の区切りより具体的なので残す。
        if (last.row.type !== 'compacted') grouped[grouped.length - 1] = entry;
      } else grouped.push(entry);
      continue;
    }
    if (entry.kind === 'gap' && grouped.at(-1)?.kind === 'gap') {
      const last = grouped.at(-1) as TimelineEntry;
      last.row = { ...last.row, to: entry.row.to ?? entry.row.id, title: [last.row.title ?? last.row.from ?? last.row.id, entry.row.from ?? entry.row.id, entry.row.to].filter(Boolean).join(' · ') };
      continue;
    }
    if (entry.kind !== 'message') {
      if (entry.kind === 'gap') responseTools = undefined;
    } else {
      const row = entry.row;
      const blocks = Array.isArray(row.body) ? row.body.map(readObject) : [];
      const resultOnly = blocks.length > 0 && blocks.every(block => block.type === 'tool_result');
      const nextTurn = row.turn_id ?? row.turnId;
      if (row.role === 'user' && !resultOnly || nextTurn && turnId && nextTurn !== turnId) responseTools = undefined;
      if (nextTurn) turnId = nextTurn;
      const tools = blocks.filter(block => block.type === 'tool_use' && !isDelegationTool(block));
      const orphanResults = blocks.filter(block => block.type === 'tool_result' && !calls.has(block.tool_use_id));
      if (tools.length || orphanResults.length) {
        const toolEntry = { ...entry, key: 'tools:' + entry.key, row: { ...row, id: 'tools:' + row.id, body: [...tools, ...orphanResults] } };
        if (!responseTools) {
          responseTools = { kind: 'tools', key: toolEntry.key, rows: [] };
          grouped.push(responseTools);
        }
        responseTools.rows.push(toolEntry);
        const visible = blocks.filter(block => !tools.includes(block) && block.type !== 'tool_result');
        const message = { ...entry, row: { ...row, body: visible } };
        if (!isBlank(message.row)) grouped.push(message);
        hasVisible = true;
        if (row.phase === 'final_answer') responseTools = undefined;
        continue;
      }
      if (row.phase === 'final_answer') responseTools = undefined;
    }
    grouped.push(entry);
    hasVisible = true;
  }
  return grouped;
}
