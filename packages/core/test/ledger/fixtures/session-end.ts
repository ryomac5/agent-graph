import type { Fact, JsonValue, RunPayload, RunState } from '../../../src/ledger/facts.ts';

export const SESSION = 'session-end-fixture';
export const CONVERSATION = `claude:${SESSION}`;
export const GENERATION = 1791953410470;
export const START = '2026-10-14T04:50:10.487Z';
export const END = '2026-10-14T09:08:58.731Z';
export const RESUME = '2026-10-14T09:10:41.205Z';
export const STOP = '2026-10-14T09:11:37.891Z';

// 本番の SessionStart(fork) → SessionEnd(other) → 同じ世代のターンを本文なしで再現する。
export function createSessionEndFacts(): Fact[] {
  const events: { name: string; ts: string; state: RunState; kind: 'run.created' | 'run.updated';
    input: { [key: string]: JsonValue }; extra: Partial<RunPayload> }[] = [
    { name: 'SessionStart', ts: START, state: 'idle', kind: 'run.created', input: { source: 'fork' }, extra: { started_ts: START } },
    { name: 'SessionEnd', ts: END, state: 'ended', kind: 'run.updated', input: { reason: 'other' },
      extra: { ended_ts: END, end_evidence: { kind: 'session_end', generation: GENERATION } } },
    { name: 'UserPromptSubmit', ts: RESUME, state: 'running', kind: 'run.updated', input: {}, extra: {} },
    { name: 'Stop', ts: STOP, state: 'idle', kind: 'run.updated', input: {}, extra: {} },
  ];
  return events.map((event, index) => ({
    seq: index + 1, fact_id: event.name, source: 'hook', source_event_id: event.name,
    kind: event.kind, subject: `run:${CONVERSATION}:${GENERATION}`,
    payload: { conversation_id: CONVERSATION, generation: GENERATION, state: event.state,
      last_evidence: { hook_event_name: event.name, generation: GENERATION, auxiliary: false,
        input: { session_id: SESSION, hook_event_name: event.name, ...event.input } },
      last_evidence_ts: event.ts, ...event.extra },
    payload_hash: 'structural-test', source_ts: event.ts, observed_ts: event.ts,
    schema_version: 1, cursor: null, confidence: 'confirmed', supersedes: null,
  } as Fact));
}
