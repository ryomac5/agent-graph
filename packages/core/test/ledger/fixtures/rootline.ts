import type { FactInput } from '../../../src/ledger/facts.ts';
import { createNativeId } from '../../../src/ledger/projections/relations.ts';

export const ROOT = createNativeId('claude', 'fea1ff97');
export const CHILD = createNativeId('claude', 'agent-a1c9e32');
export const START = '2026-10-11T12:57:14.100Z';
export const CHILD_START = '2026-10-11T12:49:29.326Z';

// 本番の別名、sdk-cli、hook の再開、子の完了後の道具呼び出しの並び。本文と native ID は置換する。
export function createRootlineFacts(): FactInput[] {
  const facts: FactInput[] = [];
  function add(input: FactInput) { facts.push(input); }
  for (const [native, type, ts] of [
    ['fea1ff97', 'interactive', '2026-10-11T06:47:43.612Z'],
    ['e814408e', 'unattended', '2026-10-11T07:27:46.409Z'],
    ['92994916', 'unattended', '2026-10-11T07:36:17.693Z'],
    ['36cd021a', 'unattended', '2026-10-11T07:36:20.351Z'],
    ['ca5ef53f', 'unattended', '2026-10-11T07:40:23.974Z'],
    ['5a08ea79', 'unattended', '2026-10-11T07:41:52.777Z'],
    ['agent-a1c9e32', 'subagent', '2026-10-11T12:49:05.124Z'],
  ] as const) {
    const id = createNativeId('claude', native);
    add({ source: 'hook', source_event_id: 'conversation:' + native, source_ts: ts, confidence: 'confirmed',
      kind: 'conversation.created', subject: `conversation:${id}`,
      payload: { provider: 'claude', native_id: native, origin: 'observed', type, history_format: 'jsonl', repository_id: 'repo' } });
    if (type !== 'subagent') add({ source: 'kit', source_event_id: 'alias:' + native, source_ts: ts, confidence: 'confirmed',
      kind: 'alias.created', subject: `alias:${native}`, payload: { entity_id: id, kind: 'kit', name: 'agent-graph-027' } });
    add({ source: 'transcript-claude', source_event_id: 'message:' + native, source_ts: ts, confidence: 'confirmed',
      kind: 'message.created', subject: `message:${native}`, payload: { provider: 'claude', native_id: native, version: 1, body_state: 'stored',
        role: 'user', body: type === 'unattended' ? 'Review a delegated task.\nOriginal request:\nBuild a sample feature' : 'Build a sample feature' } });
    add({ source: 'transcript-claude', source_event_id: 'membership:' + native, source_ts: ts, confidence: 'confirmed',
      kind: 'message_membership.created', subject: `message_membership:${native}`,
      payload: { conversation_id: id, message_id: createNativeId('claude', native), active: true } });
    add({ source: 'hook', source_event_id: 'session:' + native, source_ts: ts, confidence: 'confirmed',
      kind: 'run.created', subject: `run:${id}:1`, payload: { conversation_id: id, generation: 1, state: 'idle', started_ts: ts,
        last_evidence: { hook_event_name: 'SessionStart', input: { entrypoint: type === 'unattended' ? 'sdk-cli' : 'cli', source: 'startup' } } } });
  }
  add({ source: 'transcript-claude', source_event_id: 'child-parent', source_ts: '2026-10-11T12:49:05.124Z',
    confidence: 'confirmed', kind: 'relation.created', subject: 'relation:child-parent',
    payload: { type: 'delegated', from_id: ROOT, to_id: CHILD, active: true, confidence: 'confirmed', evidence: { agentType: 'general-purpose' } } });
  for (const [id, ts, state, evidence] of [
    [CHILD, '2026-10-11T12:49:05.124Z', 'running', { kind: 'turn_started' }],
    [CHILD, '2026-10-11T12:49:22.390Z', 'idle', { kind: 'turn_completed' }],
    [CHILD, CHILD_START, 'running', { kind: 'tool_call' }],
    [CHILD, '2026-10-11T12:49:30.000Z', 'running', { kind: 'tool_result' }],
    [ROOT, START, 'running', { hook_event_name: 'UserPromptSubmit', input: { prompt: 'Check a sample feature' } }],
  ] as const) add({ source: id === ROOT ? 'hook' : 'transcript-claude', source_event_id: ts, source_ts: ts,
    confidence: 'confirmed', kind: 'run.state_changed', subject: `run:${id}:1`,
    payload: { conversation_id: id, generation: 1, state, last_evidence: evidence, last_evidence_ts: ts } });
  return facts;
}
