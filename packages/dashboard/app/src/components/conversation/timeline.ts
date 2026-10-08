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
    if (entry.kind === 'message' && isToolOnly(entry.row) && !(Array.isArray(entry.row.body) && entry.row.body.map(readObject).some(block => block.type === 'tool_use' && isDelegationTool(block)))) {
      const last = grouped.at(-1);
      if (last?.kind === 'tools') { last.rows.push(entry); continue; }
      if (entry.row.role !== 'user') { grouped.push({ kind: 'tools', key: 'tools:' + entry.key, rows: [entry] }); hasVisible = true; continue; }
    }
    grouped.push(entry);
    hasVisible = true;
  }
  return grouped;
}
