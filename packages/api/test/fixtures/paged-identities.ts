import { applyIncremental, createNativeId, openLedger, readLedgerDatabase } from '../../../core/src/ledger/index.ts';
import { ProjectionFeed } from '../../src/service/projection-feed.ts';

export const PAGE_SIZE = 1000;
export const TURN_START = '2026-10-11T00:00:00Z';
export function createPagedIdentityFeed(path: string) {
  const ledger = openLedger(path);
  const db = readLedgerDatabase(ledger);
  const base = { source: 'host-codex', source_ts: TURN_START, observed_ts: TURN_START, confidence: 'confirmed' } as const;
  const filler = createNativeId('codex', 'filler');
  ledger.append({ ...base, source_event_id: 'filler', kind: 'conversation.created', subject: `conversation:${filler}`,
    payload: { provider: 'codex', native_id: 'filler', origin: 'observed', type: 'unattended', history_format: 'legacy' } });
  for (let generation = 1; generation <= PAGE_SIZE; generation++) {
    ledger.append({ ...base, source_event_id: `filler-${generation}`, kind: 'run.created', subject: `run:${filler}:${generation}`,
      payload: { conversation_id: filler, generation, state: 'idle' } });
  }
  const targets = (['claude', 'codex'] as const).map(provider => {
    const legacy = `${provider}:root`;
    const canonical = createNativeId(provider, 'root');
    ledger.append({ ...base, source_event_id: legacy, kind: 'conversation.created', subject: `conversation:${legacy}`,
      payload: { provider, native_id: 'root', origin: 'observed', type: 'interactive', history_format: 'legacy' } });
    ledger.append({ ...base, source_event_id: `${legacy}:1`, kind: 'run.created', subject: `run:${legacy}:1`,
      payload: { conversation_id: legacy, generation: 1, state: 'running', started_ts: TURN_START,
        last_evidence: { kind: 'turn_started', turn_id: 'turn-start' }, last_evidence_ts: TURN_START } });
    return { provider, legacy, canonical };
  });
  const feed = new ProjectionFeed(path, () => applyIncremental(db, 0));
  feed.refresh(Date.parse(TURN_START) + 192_000);
  function updateRuns() {
    for (const { legacy } of targets) ledger.append({ ...base, source_event_id: `update-${legacy}`, kind: 'run.updated',
      subject: `run:${legacy}:1`, payload: { conversation_id: legacy, generation: 1, model: 'updated-model' } });
    const patch = feed.refresh(Date.parse(TURN_START) + 192_000);
    if (!patch || patch === 'resync') throw new Error('Expected a run patch');
    return patch;
  }
  function createRuns() {
    for (const { legacy } of targets) ledger.append({ ...base, source_event_id: `${legacy}:2`, kind: 'run.created',
      subject: `run:${legacy}:2`, payload: { conversation_id: legacy, generation: 2, state: 'running', started_ts: TURN_START,
        last_evidence: { kind: 'turn_started', turn_id: 'turn-start' }, last_evidence_ts: TURN_START } });
    const patch = feed.refresh(Date.parse(TURN_START) + 192_000);
    if (!patch || patch === 'resync') throw new Error('Expected a new run patch');
    return patch;
  }
  return { feed, targets, updateRuns, createRuns, close() { feed.close(); ledger.close(); } };
}
