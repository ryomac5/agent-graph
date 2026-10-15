import type { Row, ScreenState } from './store.ts';
import { readText } from '../components/conversation/model.ts';

const indexes = new WeakMap<Row[], Map<unknown, Row>>();
const rootIndexes = new WeakMap<Row[], Map<string, Row>>();
function byId(rows: Row[] = []): Map<unknown, Row> {
  let index = indexes.get(rows);
  if (!index) { index = new Map(rows.map(row => [row.id, row])); indexes.set(rows, index); }
  return index;
}
function byMembers(rows: Row[] = []): Map<string, Row> {
  let index = rootIndexes.get(rows);
  if (!index) { index = new Map(rows.map(row => [JSON.stringify(Array.isArray(row.conversation_ids) ? row.conversation_ids.toSorted() : []), row])); rootIndexes.set(rows, index); }
  return index;
}

/** api が選んだ操作先と状態を読む。turn や発言から状態を導かない。 */
export function resolveActivity(state: ScreenState | undefined, conversationIds: string[], fallback = 'unknown', _turns = new Set<string>()): { state: string; run?: Row } {
  const root = byMembers(state?.projection.roots).get(JSON.stringify(conversationIds.toSorted()));
  const id = readText(root?.current_conversation_id) || conversationIds[0];
  const conversation = byId(state?.projection.conversations).get(id);
  const run = byId(state?.projection.runs).get(conversation?.current_run_id);
  return { state: readText(root?.state ?? conversation?.state) || fallback, run };
}
