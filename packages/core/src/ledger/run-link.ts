import type { DatabaseSync } from 'node:sqlite';
import type { Fact } from './facts.ts';

/** 暗黙の世代継承も検索先も変わらないのは、履歴全体の明示の対応が一つのときだけ。 */
export function createStableRunLinkCheck(db: DatabaseSync): (fact: Fact) => boolean {
  const links = new Map<string, { conversation: unknown; generation: unknown }[]>();
  const read = db.prepare(`SELECT DISTINCT json_extract(payload, '$.conversation_id') AS conversation,
    json_extract(payload, '$.generation') AS generation FROM facts
    WHERE subject = ? AND kind GLOB 'run.*'`);
  return fact => {
    let rows = links.get(fact.subject);
    if (!rows) {
      rows = read.all(fact.subject).map(row => ({ conversation: row.conversation, generation: row.generation }));
      links.set(fact.subject, rows);
    }
    const payload = fact.payload as Record<string, unknown> | null;
    const conversations = new Set<unknown>(rows.flatMap(row => row.conversation === null ? [] : [row.conversation]));
    const generations = new Set<unknown>(rows.flatMap(row => row.generation === null ? [] : [row.generation]));
    return conversations.size === 1 && generations.size === 1
      && (payload?.conversation_id === undefined || conversations.has(payload.conversation_id))
      && (payload?.generation === undefined || generations.has(payload.generation));
  };
}
