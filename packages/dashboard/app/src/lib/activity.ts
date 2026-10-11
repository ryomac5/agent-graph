import type { Row, ScreenState } from './store.ts';
import { readText } from '../components/conversation/model.ts';

const indexes = new WeakMap<ScreenState, Map<string, Row>>();

/** 同じ系列の最新世代から状態と時計を選ぶ。子の状態は親に混ぜない。 */
export function resolveActivity(state: ScreenState, conversationIds: string[], fallback = 'unknown'): { state: string; run?: Row } {
  let latest = indexes.get(state);
  if (!latest) {
    latest = new Map<string, Row>();
    for (const run of state.projection.runs ?? []) {
      const id = readText(run.conversation_id);
      const previous = latest.get(id);
      if (!previous || Number(run.generation ?? 0) > Number(previous.generation ?? 0)) latest.set(id, run);
    }
    indexes.set(state, latest);
  }
  const rank = (run: Row) => ['waiting_approval', 'waiting_input'].includes(readText(run.state)) ? 2
    : ['starting', 'running'].includes(readText(run.state)) ? 1 : 0;
  const run = conversationIds.flatMap(id => latest.get(id) ? [latest.get(id)!] : []).sort((a, b) => rank(b) - rank(a)
    || readText(b.last_evidence_ts ?? b.started_ts).localeCompare(readText(a.last_evidence_ts ?? a.started_ts)))[0];
  return { state: readText(run?.state) || fallback, run };
}
