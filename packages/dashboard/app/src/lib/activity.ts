import type { Row, ScreenState } from './store.ts';
import { readText } from '../components/conversation/model.ts';

const indexes = new WeakMap<Row[], Map<string, Row>>();

/** 同じ系列の最新世代から状態と時計を選ぶ。子の状態は親に混ぜない。 */
export function resolveActivity(state: ScreenState | undefined, conversationIds: string[], fallback = 'unknown', turns = new Set<string>()): { state: string; run?: Row } {
  const rows = state?.projection.runs;
  let latest = rows && indexes.get(rows);
  if (!latest) {
    latest = new Map<string, Row>();
    for (const run of state?.projection.runs ?? []) {
      const id = readText(run.conversation_id);
      const previous = latest.get(id);
      if (!previous || Number(run.generation ?? 0) > Number(previous.generation ?? 0)) latest.set(id, run);
    }
    if (rows) indexes.set(rows, latest);
  }
  const rank = (run: Row) => ['waiting_approval', 'waiting_input'].includes(readText(run.state)) ? 2
    : ['starting', 'running'].includes(readText(run.state)) ? 1 : 0;
  const run = conversationIds.flatMap(id => latest.get(id) ? [latest.get(id)!] : []).sort((a, b) => rank(b) - rank(a)
    || readText(b.last_evidence_ts ?? b.started_ts).localeCompare(readText(a.last_evidence_ts ?? a.started_ts)))[0];
  const activity = readText(run?.state) || fallback;
  return { state: conversationIds.some(id => turns.has(id)) && !['waiting_approval', 'waiting_input'].includes(activity) ? 'waiting_input' : activity, run };
}
