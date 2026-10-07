import type { Fact } from '../../../core/src/ledger/facts.ts';
import { projectConversationIds } from '../../../core/src/ledger/projections/relations.ts';

export interface ScreenIdentities { conversations: Record<string, string>; runs: Record<string, string> }
export function createScreenIdentities(facts: readonly Fact[]): ScreenIdentities {
  const conversations = Object.fromEntries(projectConversationIds(facts));
  const runs: Record<string, string> = {};
  for (const fact of facts) {
    if (fact.kind !== 'run.created' || !fact.payload?.conversation_id || !fact.payload.generation) continue;
    const original = `${fact.payload.conversation_id}:${fact.payload.generation}`;
    const canonical = `${conversations[fact.payload.conversation_id] ?? fact.payload.conversation_id}:${fact.payload.generation}`;
    runs[fact.subject.slice('run:'.length)] = canonical;
    runs[original] = canonical;
  }
  return { conversations, runs };
}
