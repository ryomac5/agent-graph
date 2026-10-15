import { useCallback, useContext, useRef, useSyncExternalStore } from 'react';
import { ViewVisible } from './visibility.tsx';
import { shareValue } from './projection-cache.ts';
import { mergeIdentities, resolveProjection, resolveRow, resolveRunId, type ScreenIdentities } from './identities.ts';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'runner_unavailable';
export type Row = Record<string, unknown>;
export interface Snapshot { evaluated_at?: number; seq: number; generation: number; projection: Record<string, Row[]>; identities?: ScreenIdentities; pages?: Record<string, { total: number; next: string | null }> }
export interface Patch { evaluated_at?: number; type: 'patch'; from_seq: number; seq: number; generation: number;
  changes: Record<string, { upsert: Row[]; remove: string[] }>; identities?: ScreenIdentities }
export interface Delta { runId: string; text: string; conversationId?: string; messageId?: string; existingMessageIds?: string[] }
export interface ScreenState extends Snapshot {
  snapshotReady?: boolean;
  connection: ConnectionState;
  deltas: Record<string, Delta>;
  projectionError?: string;
}
export function createStore() {
  let state: ScreenState = { seq: 0, generation: 0, snapshotReady: false, projection: {}, connection: 'connecting', deltas: {} };
  const listeners = new Set<() => void>();
  function update(next: ScreenState) { state = next; for (const listener of listeners) listener(); }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setConnection: (connection: ConnectionState) => update({ ...state, connection }),
    setSnapshot: (snapshot: Snapshot) => update({ ...state, ...snapshot, snapshotReady: true, pages: snapshot.pages, projection: resolveProjection(snapshot.projection, snapshot.identities), deltas: {}, projectionError: undefined }),
    setSendWatches: (rows: Row[]) => {
      const shared = shareValue(state.projection.send_watches, rows);
      if (shared !== state.projection.send_watches) update({ ...state, projection: { ...state.projection, send_watches: shared! } });
    },
    clearDeltas: () => update({ ...state, deltas: {} }),
    mergeProjection(projection: Record<string, Row[]>, generation: number, identities = state.identities, pages = state.pages, projectionError = state.projectionError) {
      if (generation !== state.generation) return;
      identities = mergeIdentities(state.identities, identities);
      const next = identities === state.identities ? { ...state.projection } : resolveProjection(state.projection, identities);
      for (const [table, incoming] of Object.entries(resolveProjection(projection, identities))) {
        const rows = new Map((next[table] ?? []).map(row => [String(row.id), row]));
        for (const row of incoming) if (!rows.has(String(row.id))) rows.set(String(row.id), row);
        if (rows.size !== (next[table]?.length ?? 0)) next[table] = [...rows.values()];
      }
      update({ ...state, projection: next, identities, pages, projectionError });
    },
    applyPatch(patch: Patch): boolean {
      if (patch.generation !== state.generation || patch.from_seq > state.seq) return false;
      if (patch.seq < state.seq || patch.seq === state.seq && (patch.evaluated_at === undefined || patch.evaluated_at < (state.evaluated_at ?? 0))) return true;
      const identities = mergeIdentities(state.identities, patch.identities);
      const projection = identities === state.identities ? { ...state.projection } : resolveProjection(state.projection, identities);
      const deltas = { ...state.deltas };
      for (const [table, change] of Object.entries(patch.changes)) {
        let changed = false;
        const rows = new Map((projection[table] ?? []).map(row => [String(row.id), row]));
        for (const id of change.remove) if (rows.delete(String(resolveRow(table, { id }, state.identities).id))) changed = true;
        for (const source of change.upsert) {
          const row = resolveRow(table, source, identities);
          const id = String(row.id);
          const shared = shareValue(rows.get(id), row);
          if (shared !== rows.get(id)) { rows.set(id, shared!); changed = true; }
        }
        if (changed) projection[table] = [...rows.values()];
      }
      if (projection.state_decisions) {
        const used = new Set((projection.runs ?? []).map(row => row.decision_id));
        projection.state_decisions = projection.state_decisions.filter(row => used.has(row.id));
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
      update({ ...state, seq: patch.seq, evaluated_at: patch.evaluated_at ?? state.evaluated_at, projection: Object.keys(projection).every(table => projection[table] === state.projection[table]) ? state.projection : projection,
        deltas: Object.keys(deltas).length === Object.keys(state.deltas).length ? state.deltas : deltas, identities });
      return true;
    },
    appendDelta(delta: Delta) {
      delta = { ...delta, runId: resolveRunId(delta.runId, state.identities),
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
const identity = (state: ScreenState) => state;
const noSubscribe = () => () => {};
export function useScreenStore<T = ScreenState>(target = store, selector: (state: ScreenState) => T = identity as (state: ScreenState) => T) {
  const visible = useContext(ViewVisible);
  const cached = useRef<{ value: T }>(undefined);
  const getSnapshot = useCallback(() => {
    if (visible || !cached.current) cached.current = { value: selector(target.getSnapshot()) };
    return cached.current.value;
  }, [target, selector, visible]);
  return useSyncExternalStore(visible ? target.subscribe : noSubscribe, getSnapshot, getSnapshot);
}
