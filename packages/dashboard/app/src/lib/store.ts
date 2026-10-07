import { useSyncExternalStore } from 'react';
import { resolveProjection, resolveRow, type ScreenIdentities } from './identities.ts';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'runner_unavailable';
export type Row = Record<string, unknown>;
export interface Snapshot { seq: number; generation: number; projection: Record<string, Row[]>; identities?: ScreenIdentities }
export interface Patch { type: 'patch'; from_seq: number; seq: number; generation: number;
  changes: Record<string, { upsert: Row[]; remove: string[] }>; identities?: ScreenIdentities }
export interface Delta { runId: string; text: string; conversationId?: string; messageId?: string; existingMessageIds?: string[] }
export interface ScreenState extends Snapshot {
  connection: ConnectionState;
  deltas: Record<string, Delta>;
}
export function createStore() {
  let state: ScreenState = { seq: 0, generation: 0, projection: {}, connection: 'connecting', deltas: {} };
  const listeners = new Set<() => void>();
  function update(next: ScreenState) { state = next; for (const listener of listeners) listener(); }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setConnection: (connection: ConnectionState) => update({ ...state, connection }),
    setSnapshot: (snapshot: Snapshot) => update({ ...state, ...snapshot, projection: resolveProjection(snapshot.projection, snapshot.identities), deltas: {} }),
    clearDeltas: () => update({ ...state, deltas: {} }),
    applyPatch(patch: Patch): boolean {
      if (patch.generation !== state.generation || patch.from_seq > state.seq) return false;
      if (patch.seq <= state.seq) return true;
      const identities = patch.identities ?? state.identities;
      const projection = resolveProjection(state.projection, identities);
      const deltas = { ...state.deltas };
      for (const [table, change] of Object.entries(patch.changes)) {
        const rows = new Map((projection[table] ?? []).map(row => [String(row.id), row]));
        for (const id of change.remove) rows.delete(String(resolveRow(table, { id }, state.identities).id));
        for (const source of change.upsert) {
          const row = resolveRow(table, source, identities);
          rows.set(String(row.id), row);
        }
        projection[table] = [...rows.values()];

      }
      const completed = patch.changes.messages?.upsert ?? [];
      for (const [key, delta] of Object.entries(deltas)) {
        const conversationId = delta.conversationId ?? projection.runs?.find(row => row.id === delta.runId)?.conversation_id;
        const messageComplete = completed.some(row => String(row.id) === delta.messageId);
        const conversationComplete = !delta.messageId && (projection.messages ?? []).some(row => row.role === 'assistant'
          && !delta.existingMessageIds?.includes(String(row.id))
          && (projection.message_memberships ?? []).some(link => link.active === 1
            && link.message_id === row.id && link.conversation_id === conversationId));
        if (messageComplete || conversationComplete) delete deltas[key];
      }
      update({ ...state, seq: patch.seq, projection, deltas, identities });
      return true;
    },
    appendDelta(delta: Delta) {
      delta = { ...delta, runId: state.identities?.runs[delta.runId] ?? delta.runId,
        ...(delta.conversationId ? { conversationId: state.identities?.conversations[delta.conversationId] ?? delta.conversationId } : {}) };
      const key = JSON.stringify([delta.runId, delta.conversationId, delta.messageId]);
      update({ ...state, deltas: { ...state.deltas, [key]: {
        ...delta, existingMessageIds: state.deltas[key]?.existingMessageIds ?? (state.projection.messages ?? []).map(row => String(row.id)),
        text: (state.deltas[key]?.text ?? '') + delta.text,
      } } });
    },
  };
}
export type ScreenStore = ReturnType<typeof createStore>;
export const store = createStore();
export function useScreenStore(target = store) {
  return useSyncExternalStore(target.subscribe, target.getSnapshot, target.getSnapshot);
}
