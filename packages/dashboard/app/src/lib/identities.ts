import type { Row } from './store.ts';
import { decodeStoredValue } from '../components/activity.ts';

export interface ScreenIdentities { conversations: Record<string, string>; runs: Record<string, string> }
export function resolveRunId(value: string, identities?: ScreenIdentities): string {
  if (!identities) return value;
  if (identities.runs[value] !== undefined) return identities.runs[value];
  const match = /^(.*):(\d+)$/.exec(value);
  return match && identities.conversations[match[1]] ? `${identities.conversations[match[1]]}:${match[2]}` : value;
}
export function mergeIdentities(previous?: ScreenIdentities, incoming?: ScreenIdentities): ScreenIdentities | undefined {
  if (!incoming || incoming === previous) return previous;
  if (previous && Object.entries(incoming.conversations).every(([key, value]) => previous.conversations[key] === value)
    && Object.entries(incoming.runs).every(([key, value]) => previous.runs[key] === value)) return previous;
  return { conversations: { ...previous?.conversations, ...incoming.conversations }, runs: { ...previous?.runs, ...incoming.runs } };
}
export function resolveRow(table: string, row: Row, identities?: ScreenIdentities): Row {
  if (!identities && table !== 'relations') return row;
  const result = { ...row };
  if (table === 'relations' && ['type', 'from_id', 'to_id', 'evidence'].some(key => !(key in row))) {
    const parts = decodeStoredValue(row.id);
    if (Array.isArray(parts) && parts.length === 4 && parts.every(value => typeof value === 'string')) {
      for (const [index, key] of ['type', 'from_id', 'to_id', 'evidence'].entries()) {
        if (!(key in result)) result[key] = parts[index];
      }
    }
  }
  const conversation = (value: unknown) => typeof value === 'string' ? identities?.conversations[value] ?? value : value;
  const run = (value: unknown) => typeof value === 'string' ? resolveRunId(value, identities) : value;
  if ('conversation_id' in result) result.conversation_id = conversation(result.conversation_id);
  if ('run_id' in result) result.run_id = run(result.run_id);
  if (table === 'runs') result.id = run(row.id);
  if (table === 'relations') {
    result.from_id = run(conversation(result.from_id));
    result.to_id = run(conversation(result.to_id));
  }
  if (table === 'delegations') {
    const attempts = decodeStoredValue(row.attempts);
    if (Array.isArray(attempts) && attempts.some(attempt => run(attempt.run_id) !== attempt.run_id)) result.attempts = attempts.map(attempt => ({ ...attempt, run_id: run(attempt.run_id) }));
  }
  return Object.keys(result).every(key => result[key] === row[key]) ? row : result;
}
export function resolveProjection(projection: Record<string, Row[]>, identities?: ScreenIdentities) {
  return Object.fromEntries(Object.entries(projection).map(([table, rows]) => {
    const resolved = rows.map(row => resolveRow(table, row, identities));
    return [table, resolved.every((row, index) => row === rows[index]) ? rows : resolved];
  }));
}
