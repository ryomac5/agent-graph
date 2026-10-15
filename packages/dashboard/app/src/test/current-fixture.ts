import { createStore as createScreenStore, type Snapshot, type Row, type Patch } from '../lib/store.ts';
export * from '../lib/store.ts';
const rank = ['unresolved', 'stopped', 'waiting_approval', 'waiting_input', 'running', 'closed', 'not_hosted', 'idle', 'unknown'];
const priority = (state: unknown) => { const value = rank.indexOf(String(state)); return value < 0 ? 8 : value; };

/** 画面単体試験の短い標本に API の現在値を明示する。製品の store は補完しない。 */
export function currentFixture(snapshot: Snapshot): Snapshot {
  const p = snapshot.projection;
  if (!p.conversations) return snapshot;
  const rootByConversation = new Map<unknown, Row>();
  for (const root of p.roots ?? []) for (const id of Array.isArray(root.conversation_ids) ? root.conversation_ids : []) rootByConversation.set(id, root);
  const latest = new Map<unknown, Row>();
  for (const run of p.runs ?? []) {
    const previous = latest.get(run.conversation_id);
    if (!previous || Number(run.generation ?? 0) >= Number(previous.generation ?? 0)) latest.set(run.conversation_id, run);
  }
  const messages = new Map((p.messages ?? []).map(row => [row.id, row]));
  const times = new Map<unknown, string>();
  for (const link of p.message_memberships ?? []) {
    const ts = messages.get(link.message_id)?.source_ts;
    if (typeof ts === 'string' && link.active !== 0 && ts > (times.get(link.conversation_id) ?? '')) times.set(link.conversation_id, ts);
  }
  const conversations = (p.conversations ?? []).map(row => {
    const run = latest.get(row.id);
    const root = rootByConversation.get(row.id);
    const state = run?.state ?? row.state ?? root?.state ?? 'unknown';
    const value: Row = { ...row, current_run_id: run?.id, state, activity_rank: priority(state),
      last_activity_ts: [row.last_message_ts, times.get(row.id), run?.last_evidence_ts, run?.ended_ts, run?.started_ts, row.created_ts].filter((x): x is string => typeof x === 'string').sort().at(-1) ?? row.last_activity_ts };
    return ['current_run_id', 'state', 'activity_rank', 'last_activity_ts'].every(key => value[key] === row[key]) ? row : value;
  });
  const byId = new Map(conversations.map(row => [row.id, row]));
  const roots = p.roots?.map(row => {
    const candidates = (Array.isArray(row.conversation_ids) ? row.conversation_ids : []).map(id => byId.get(id)).filter((row): row is Row => !!row);
    const selected = candidates.find(c => c.id === row.current_conversation_id) ?? candidates.sort((a, b) => priority(a.state) - priority(b.state) || String(b.last_activity_ts ?? '').localeCompare(String(a.last_activity_ts ?? '')))[0];
    const state = candidates.some(c => latest.has(c.id)) ? selected?.state ?? row.state : row.state;
    const current = selected?.id ?? row.current_conversation_id;
    if (row.state === state && row.current_conversation_id === current && row.activity_rank === priority(state)) return row;
    return { ...row, state, current_conversation_id: current, activity_rank: priority(state) };
  });
  return { ...snapshot, projection: { ...p, conversations, ...(roots ? { roots } : {}) } };
}
export function createStore() {
  const store = createScreenStore();
  const setSnapshot = store.setSnapshot;
  store.setSnapshot = snapshot => setSnapshot(currentFixture(snapshot));
  const applyPatch = store.applyPatch;
  store.applyPatch = patch => {
    const state = store.getSnapshot();
    if (!['runs', 'conversations', 'roots', 'messages', 'message_memberships'].some(table => patch.changes[table])) return applyPatch(patch);
    const p = { ...state.projection };
    for (const [table, change] of Object.entries(patch.changes)) {
      const rows = new Map((p[table] ?? []).map(row => [String(row.id), row]));
      for (const id of change.remove) rows.delete(id);
      for (const row of change.upsert) rows.set(String(row.id), row);
      p[table] = [...rows.values()];
    }
    const filled = currentFixture({ ...state, projection: p }).projection;
    const changes = { ...patch.changes };
    for (const table of ['conversations', 'roots']) {
      const before = new Map((state.projection[table] ?? []).map(row => [row.id, JSON.stringify(row)]));
      const incoming = new Set(changes[table]?.upsert.map(row => row.id));
      const upsert = (filled[table] ?? []).filter(row => incoming.has(row.id) || before.get(row.id) !== JSON.stringify(row));
      if (upsert.length) changes[table] = { upsert, remove: changes[table]?.remove ?? [] };
    }
    return applyPatch({ ...patch, changes });
  };
  return store;
}
