import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Fact, Ledger, FactInput } from '../../../core/src/ledger/index.ts';
export interface RemoteMetadata { connectionId: string; projectId: string; cwd: string; disconnected: boolean }
export function readRemoteMetadata(path: string): RemoteMetadata | undefined {
  try { return JSON.parse(readFileSync(path + '.remote.json', 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function observeRemoteStatus(ledger: Ledger, paths: string[], facts: Fact[]): Set<string> {
  const conversations = new Set<string>();
  for (const path of paths) {
    const meta = readRemoteMetadata(path);
    if (!meta) continue;
    const provider = path.includes('/codex/') ? 'codex' : 'claude';
    const nativeId = provider === 'codex' ? /([0-9a-f-]{36})\.jsonl$/i.exec(basename(path))?.[1] : basename(path, '.jsonl');
    if (!nativeId) continue;
    const id = JSON.stringify([provider, nativeId]); conversations.add(id);
    if (!meta.disconnected) continue;
    const run = facts.filter(fact => fact.kind === 'run.created' && fact.payload?.conversation_id === id).at(-1);
    if (!run) continue;
    const generation = Number((run.payload as { generation?: number }).generation);
    const event = `remote-disconnected:${meta.connectionId}:${id}:${generation}`;
    if (facts.some(fact => fact.source_event_id === event)) continue;
    ledger.append({ source: 'transcript-claude', source_event_id: event, kind: 'run.state_changed', subject: run.subject,
      confidence: 'confirmed', source_ts: new Date().toISOString(), payload: { conversation_id: id,
        generation: generation, state: 'unknown', reason: 'disconnected', last_evidence: { kind: 'disconnected' } } } as FactInput);
  }
  return conversations;
}
