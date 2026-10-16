import { applyIncremental, createNativeId, openLedger, readLedgerDatabase, type FactInput } from '../../../core/src/ledger/index.ts';
import { ProjectionFeed } from '../../src/service/projection-feed.ts';
import { SendWatch } from '../../src/service/send-watch.ts';

export const START = '2026-10-13T00:00:00.000Z';
export const LEGACY = 'claude:root:with:colon';
export const ROOT = createNativeId('claude', 'root:with:colon');
export const CHILD = createNativeId('codex', 'child');
export function createCompactSnapshotFeed(path: string) {
  const ledger = openLedger(path);
  const db = readLedgerDatabase(ledger);
  let sequence = 0;
  function append(kind: FactInput['kind'], subject: FactInput['subject'], payload: FactInput['payload']) {
    ledger.append({ source: 'host-claude', source_event_id: `event-${++sequence}`, source_ts: new Date(Date.parse(START) + sequence * 1000).toISOString(),
      confidence: 'confirmed', kind, subject, payload } as FactInput);
  }
  append('conversation.created', `conversation:${LEGACY}`, { provider: 'claude', native_id: 'root:with:colon',
    origin: 'observed', type: 'interactive', name: 'Snapshot root', cwd: '/repo' });
  append('conversation.created', `conversation:${CHILD}`, { provider: 'codex', native_id: 'child',
    origin: 'observed', type: 'subagent' });
  append('run.created', `run:${LEGACY}:1`, { conversation_id: LEGACY, generation: 1, state: 'running',
    started_ts: START, last_evidence: { kind: 'turn_started' }, last_evidence_ts: START });
  append('run.created', 'run:custom-host-run', { conversation_id: CHILD, generation: 1, state: 'idle' });
  append('relation.created', 'relation:delegated', { type: 'delegated', from_id: LEGACY, to_id: CHILD, active: true,
    confidence: 'confirmed', evidence: { agentType: 'review', description: 'Review snapshot', source_ts: START } });
  append('relation.created', 'relation:compacted', { type: 'compacted', from_id: LEGACY, to_id: LEGACY, active: true,
    confidence: 'confirmed', evidence: { source_ts: '2026-10-13T00:00:08.000Z', summary: 'Preserved evidence 日本語 '.repeat(100) } });
  append('message.created', 'message:reply', { role: 'assistant', body: 'Existing reply', body_state: 'stored', version: 1 });
  append('message_membership.created', 'message_membership:reply', { message_id: 'reply', conversation_id: LEGACY, active: true });
  append('conversation.input_queue_changed', `conversation:${ROOT}`, { input_queue_event: { operation: 'enqueue', body: 'Next step' } });
  const feed = new ProjectionFeed(path, () => applyIncremental(db, 0));
  const watch = new SendWatch(path);
  const now = Date.parse(START);
  watch.record('send', ROOT, 'Next step', watch.capture(ROOT, now));
  function snapshot(): ReturnType<ProjectionFeed['snapshot']> {
    const result = feed.snapshot();
    return { ...result, projection: { ...result.projection, send_watches: watch.list() } };
  }
  return { ledger, db, feed, watch, append, snapshot, close() { watch.close(); feed.close(); ledger.close(); } };
}
