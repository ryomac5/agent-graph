import type { Row } from './store.ts';
import { decodeStoredValue } from '../components/activity.ts';

export interface ScreenIdentities { conversations: Record<string, string>; runs: Record<string, string> }
export function resolveRow(table: string, row: Row, identities?: ScreenIdentities): Row {
  if (!identities) return row;
  const result = { ...row };
  const conversation = (value: unknown) => typeof value === 'string' ? identities.conversations[value] ?? value : value;
  const run = (value: unknown) => typeof value === 'string' ? identities.runs[value] ?? value : value;
  if ('conversation_id' in result) result.conversation_id = conversation(result.conversation_id);
  if ('run_id' in result) result.run_id = run(result.run_id);
  if (table === 'runs') result.id = run(row.id);
  if (table === 'relations') {
    result.from_id = run(conversation(row.from_id));
    result.to_id = run(conversation(row.to_id));
  }
  if (table === 'delegations') {
    const attempts = decodeStoredValue(row.attempts);
    if (Array.isArray(attempts)) result.attempts = attempts.map(attempt => ({ ...attempt, run_id: run(attempt.run_id) }));
  }
  return result;
}
export function resolveProjection(projection: Record<string, Row[]>, identities?: ScreenIdentities) {
  return Object.fromEntries(Object.entries(projection).map(([table, rows]) => [table, rows.map(row => resolveRow(table, row, identities))]));
}
