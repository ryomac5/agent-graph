import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRoots, connectRootDelegations } from '../../src/ledger/projections/roots.ts';

test('根は継続とキット名を時刻順にまとめ、子と別の根を分ける', () => {
  const roots = projectRoots([
    { id: 'b', type: 'interactive', kit_name: 'agent-graph-001', project: 'repo', created_ts: '2026-10-02' },
    { id: 'a', type: 'interactive', kit_name: 'agent-graph-001', project: 'repo', created_ts: '2026-10-01', name: 'Request' },
    { id: 'c', type: 'interactive', project: 'repo', created_ts: '2026-10-03', state: 'running' },
    { id: 'child', type: 'interactive', state: 'running' },
    { id: 'grandchild', type: 'subagent', state: 'ended' },
    { id: 'fork', type: 'interactive' },
    { id: 'other', type: 'interactive', kit_name: 'agent-graph-001', project: 'other' },
    { id: 'unattended', type: 'unattended' },
  ], [
    { from_id: 'b', to_id: 'c', type: 'continued', active: true },
    { from_id: 'c', to_id: 'c', type: 'compacted', active: true },
    { from_id: 'c', to_id: 'child', type: 'delegated', active: true },
    { from_id: 'child', to_id: 'grandchild', type: 'delegated', active: true },
    { from_id: 'a', to_id: 'fork', type: 'forked', active: true },
    { from_id: 'a', to_id: 'other', type: 'delegated', active: false },
  ]);
  assert.deepEqual(roots.map(row => row.id), ['a', 'other']);
  assert.deepEqual(roots[0], { id: 'a', name: 'agent-graph-001', project: 'repo', state: 'running',
    last_activity_ts: '2026-10-03', conversation_ids: ['a', 'b', 'c'], running_children: 1, total_children: 2 });
  assert.equal(connectRootDelegations([{ kit: { session: 'agent-graph-001' }, repository_id: 'repo' }], roots)[0].root_id, 'a');
});

test("キットのあるプロジェクトでは、キットの名前のある系列だけを根にする", () => {
  const roots = projectRoots([
    { id: "a", type: "interactive", kit_name: "agent-graph-001", project: "p", created_ts: "1" },
    { id: "b", type: "interactive", name: "横断検索を作る", project: "p", created_ts: "2" },
    { id: "c", type: "interactive", name: "solo", project: "q", created_ts: "3" },
  ], []);
  assert.deepEqual(roots.map(row => row.name).sort(), ["agent-graph-001", "solo"]);
});
