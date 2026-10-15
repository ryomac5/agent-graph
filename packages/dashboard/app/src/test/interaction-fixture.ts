import { createStore } from "./current-fixture.ts";
import { workspaceKey } from '../lib/panes.ts';
export const interactionKey = workspaceKey('p', 'a');
export function createInteractionFixture(count = 3) {
  const target = createStore();
  const ids = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i));
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: ['p', 'q', 'r'].map(id => ({ id, display_name: id.toUpperCase(), state: 'registered' })),
    roots: [{ id: 'a', name: 'Same', project: 'p', state: 'idle', conversation_ids: ['a'] }],
    conversations: ids.map(id => ({ id, name: 'Same', provider: 'codex', origin: 'managed' })),
  } });
  localStorage.setItem(interactionKey, JSON.stringify({ kind: 'pane', id: 'pane', tabs: ids.map(id => ({ kind: 'conversation', id, conversationId: id })), active: 'a' }));
  return target;
}
