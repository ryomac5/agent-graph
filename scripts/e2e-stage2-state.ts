import assert from "node:assert/strict";
import { basename } from "node:path";
import { repoKey, stateDbPath } from "../packages/core/src/paths.ts";
import { openStore } from "../packages/core/src/store/store.ts";
import { parseTraceparent, parseTracestate } from "../packages/core/src/trace.ts";

const [mode, role, executor] = process.argv.slice(2);
const root = process.cwd();
const key = repoKey(root);
const store = openStore(stateDbPath(key));
try {
  const trace = parseTraceparent(process.env.TRACEPARENT)!;
  const state = parseTracestate(process.env.TRACESTATE);
  assert.ok(trace);
  assert.ok(state.sessionId);
  assert.ok(state.delegationId);
  if (mode === "seed") {
    store.upsertRepo({ key, rootPath: root, name: basename(root) });
    store.insertSession({ id: state.sessionId, repoKey: key, name: state.sessionId,
      client: executor, traceId: trace.traceId, startedAt: new Date().toISOString() });
    store.insertDelegation({ id: state.delegationId, repoKey: key, sessionId: state.sessionId,
      role: "orchestrate", title: "e2e caller fixture", status: "done" });
    store.insertSpan({ trace, name: "e2e caller fixture", startedAt: new Date().toISOString(), status: "ok",
      attributes: { "agent.delegation": state.delegationId } });
  } else {
    const count = store.db.prepare("SELECT count(*) AS n FROM delegations WHERE session_id = ? AND id != ?")
      .get(state.sessionId, state.delegationId)!;
    assert.equal(count.n, 1, "delegate must be called exactly once, including unsuccessful calls");
    const rows = store.db.prepare(`SELECT d.status, d.parent_id, a.executor, s.trace_id, s.parent_span_id,
      p.trace_id AS parent_trace_id, p.span_id AS parent_span
      FROM delegations d JOIN assignments a ON a.delegation_id = d.id
      JOIN spans s ON json_extract(s.attributes, '$."agent.delegation"') = d.id
      JOIN spans p ON json_extract(p.attributes, '$."agent.delegation"') = d.parent_id
      WHERE d.role = ? AND d.session_id = ?`).all(role, state.sessionId);
    assert.equal(rows.length, 1, "delegate must be called exactly once");
    const row = rows[0];
    assert.equal(row.status, "done");
    assert.equal(row.executor, executor);
    assert.equal(row.parent_id, state.delegationId);
    assert.equal(row.trace_id, trace.traceId);
    assert.equal(row.trace_id, row.parent_trace_id);
    assert.equal(row.parent_span_id, row.parent_span);
    console.log(`PASS ${role}: ${executor}, done, parent trace connected`);
  }
} finally { store.close(); }
