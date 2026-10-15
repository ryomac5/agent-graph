import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRoots, connectRootDelegations } from '../../src/ledger/projections/roots.ts';

test('根は確定した継続を時刻順にまとめ、子と別の根を分ける', () => {
  const roots = projectRoots([
    { id: 'b', type: 'interactive', kit_name: 'agent-graph-001', project: 'repo', created_ts: '2026-10-02' },
    { id: 'a', type: 'interactive', kit_name: 'agent-graph-001', project: 'repo', created_ts: '2026-10-01', name: 'Request' },
    { id: 'c', type: 'interactive', project: 'repo', created_ts: '2026-10-03', state: 'running', activity_rank: 4 },
    { id: 'child', type: 'interactive', state: 'running', activity_rank: 4 },
    { id: 'grandchild', type: 'subagent', state: 'ended' },
    { id: 'fork', type: 'interactive', project: 'repo', created_ts: '2026-10-04' },
    { id: 'other', type: 'interactive', kit_name: 'agent-graph-001', project: 'other' },
    { id: 'unattended', type: 'unattended' },
  ], [
    { from_id: 'a', to_id: 'b', type: 'continued', active: true, confidence: 'confirmed' },
    { from_id: 'b', to_id: 'c', type: 'continued', active: true, confidence: 'confirmed' },
    { from_id: 'c', to_id: 'c', type: 'compacted', active: true, confidence: 'confirmed' },
    { from_id: 'c', to_id: 'child', type: 'delegated', active: true },
    { from_id: 'child', to_id: 'grandchild', type: 'delegated', active: true, confidence: 'inferred' },
    { from_id: 'a', to_id: 'fork', type: 'forked', active: true, confidence: 'confirmed' },
    { from_id: 'a', to_id: 'other', type: 'delegated', active: false },
  ]);
  assert.deepEqual(roots.map(row => row.id), ['a', 'other']);
  assert.deepEqual(roots[0], { id: 'a', name: 'agent-graph-001', project: 'repo', state: 'running',
    last_activity_ts: '2026-10-04', conversation_ids: ['a', 'b', 'c', 'fork'], current_conversation_id: 'c', running_children: 1, total_children: 2 });
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

test("系列の新しい待機中の会話や子の終了は、動いている根のターンを隠さない", () => {
  const roots = projectRoots([
    { id: 'parent', type: 'interactive', created_ts: '2026-10-11T00:00:00Z', last_activity_ts: '2026-10-11T00:01:00Z', state: 'running', activity_rank: 4 },
    { id: 'peer', type: 'interactive', created_ts: '2026-10-11T00:02:00Z', last_activity_ts: '2026-10-11T00:12:00Z', state: 'idle', activity_rank: 7 },
    { id: 'child', type: 'subagent', created_ts: '2026-10-11T00:03:00Z', last_activity_ts: '2026-10-11T00:13:00Z', state: 'ended' },
  ], [
    { type: 'continued', from_id: 'parent', to_id: 'peer', active: true, confidence: 'confirmed' },
    { type: 'delegated', from_id: 'parent', to_id: 'child', active: true, confidence: 'confirmed' },
  ]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].state, 'running');
  assert.equal(roots[0].running_children, 0);
});

test('同じキット名の根と確定した継続と分岐をつなぎ、無人実行と子を混ぜない', () => {
  const conversations = [
    { id: 'root', type: 'interactive', kit_name: 'same-001', project: 'p', created_ts: '1', state: 'running', activity_rank: 4, last_activity_ts: '2' },
    { id: 'resume', type: 'interactive', project: 'p', created_ts: '2', state: 'idle', activity_rank: 7, last_activity_ts: '9' },
    { id: 'other', type: 'interactive', kit_name: 'same-001', project: 'p', created_ts: '3' },
    { id: 'review', type: 'unattended', kit_name: 'same-001', project: 'p', created_ts: '4', state: 'idle', activity_rank: 7, last_activity_ts: '10' },
    { id: 'child', type: 'subagent', kit_name: 'same-001', project: 'p', created_ts: '5' },
    { id: 'fork', type: 'interactive', kit_name: 'same-001', project: 'p', created_ts: '6', state: 'running', activity_rank: 4, last_activity_ts: '8' },
  ];
  const relations = [
    { from_id: 'root', to_id: 'resume', type: 'continued', confidence: 'confirmed', active: true },
    { from_id: 'root', to_id: 'other', type: 'continued', confidence: 'inferred', active: true },
    { from_id: 'root', to_id: 'review', type: 'compacted', confidence: 'confirmed', active: true },
    { from_id: 'root', to_id: 'child', type: 'delegated', confidence: 'confirmed', active: true },
    { from_id: 'root', to_id: 'fork', type: 'forked', confidence: 'confirmed', active: true },
  ];
  const roots = projectRoots(conversations, relations);
  assert.deepEqual(roots.map(row => row.id), ['root']);
  const root = roots.find(row => row.id === 'root')!;
  assert.deepEqual(root.conversation_ids, ['root', 'resume', 'other', 'fork']);
  assert.equal(root.current_conversation_id, 'fork');
  assert.equal(root.state, 'running');
  assert.deepEqual(projectRoots([...conversations].reverse(), [...relations].reverse()), roots);
});

test('fork の関係がなくても同じキット名の根を系列にまとめ、直近の会話を操作先にする', () => {
  const conversations = [
    { id: 'root', type: 'interactive', kit_name: 'same-001', project: 'p', created_ts: '1', state: 'idle', activity_rank: 7, last_activity_ts: '2' },
    { id: 'fork', type: 'interactive', kit_name: 'same-001', project: 'p', created_ts: '3', state: 'running', activity_rank: 4, last_activity_ts: '4' },
  ];
  const roots = projectRoots(conversations, []);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].id, 'root');
  assert.deepEqual(roots[0].conversation_ids, ['root', 'fork']);
  assert.equal(roots[0].current_conversation_id, 'fork');
  assert.equal(roots[0].state, 'running');
  assert.deepEqual(projectRoots([...conversations].reverse(), []), roots);
});

test('同名でも委譲の子と審査役とその継続は、根の系列にも操作先にも入れない', () => {
  const conversations = ['root', 'child', 'review', 'child-resume', 'review-resume'].map((id, index) => ({
    id, type: 'interactive', kit_name: 'same-001', project: 'p', created_ts: String(index), last_activity_ts: String(index), state: 'idle', activity_rank: 7,
  }));
  const relations = [
    { from_id: 'root', to_id: 'child', type: 'delegated', confidence: 'confirmed', active: true },
    { from_id: 'review', to_id: 'root', type: 'review_of', confidence: 'confirmed', active: true },
    { from_id: 'child', to_id: 'child-resume', type: 'continued', confidence: 'confirmed', active: true },
    { from_id: 'review', to_id: 'review-resume', type: 'continued', confidence: 'confirmed', active: true },
  ];
  const roots = projectRoots(conversations, relations);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].conversation_ids, ['root']);
  assert.equal(roots[0].current_conversation_id, 'root');
  assert.equal(roots[0].total_children, 2);
  assert.deepEqual(projectRoots([...conversations].reverse(), [...relations].reverse()), roots);
});

for (const confidence of [undefined, 'inferred']) test(`delegated の確度が ${confidence ?? '未指定'} でも動く子と孫を集計し、同名の子を根にしない`, () => {
  const roots = projectRoots([
    { id: 'root', type: 'interactive', kit_name: 'same-001', project: 'p' },
    { id: 'child', type: 'interactive', kit_name: 'same-001', project: 'p', state: 'running', activity_rank: 4 },
    { id: 'codex', type: 'unattended', state: 'running', activity_rank: 4 },
  ], [
    { from_id: 'root', to_id: 'child', type: 'delegated', active: true, confidence },
    { from_id: 'child', to_id: 'codex', type: 'delegated', active: true, confidence },
  ]);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].conversation_ids, ['root']);
  assert.equal(roots[0].current_conversation_id, 'root');
  assert.equal(roots[0].total_children, 2);
  assert.equal(roots[0].running_children, 2);
});

test('確定した fork でも子と審査役と無人会話とそれらの分岐を根に混ぜない', () => {
  const conversations = ['root', 'child', 'review', 'unattended', 'child-fork', 'review-fork', 'unattended-fork'].map((id, index) => ({
    id, type: id === 'unattended' ? 'unattended' : 'interactive', kit_name: 'same-001', project: 'p',
    created_ts: String(index), last_activity_ts: String(index), state: 'running', activity_rank: 4,
  }));
  const relations = [
    { from_id: 'root', to_id: 'child', type: 'delegated', confidence: 'inferred', active: true },
    { from_id: 'review', to_id: 'root', type: 'review_of', confidence: 'confirmed', active: true },
    ...['child', 'review', 'unattended'].flatMap(id => [
      { from_id: 'root', to_id: id, type: 'forked', confidence: 'confirmed', active: true },
      { from_id: id, to_id: id + '-fork', type: 'forked', confidence: 'confirmed', active: true },
    ]),
  ];
  const roots = projectRoots(conversations, relations);
  assert.equal(roots.length, 1);
  assert.deepEqual(roots[0].conversation_ids, ['root']);
  assert.equal(roots[0].current_conversation_id, 'root');
  assert.deepEqual(projectRoots([...conversations].reverse(), [...relations].reverse()), roots);
});

test('未確定の継続と分岐は会話の統合や操作先に使わず、根を隠さない', () => {
  const conversations = [
    { id: 'root', type: 'interactive', created_ts: '1' },
    { id: 'peer', type: 'interactive', created_ts: '2', state: 'running', activity_rank: 4 },
  ];
  for (const type of ['continued', 'forked']) for (const confidence of [undefined, 'inferred']) {
    const roots = projectRoots(conversations, [{ from_id: 'root', to_id: 'peer', type, confidence, active: true }]);
    assert.deepEqual(roots.map(row => row.conversation_ids), [['peer'], ['root']]);
    assert.equal(roots.find(row => row.id === 'root')!.current_conversation_id, 'root');
  }
});

test('系列の代表は呼び出し側の表示順を使い、古い working 優先を再計算しない', () => {
  const roots = projectRoots([
    { id: 'stopped', type: 'interactive', state: 'stopped', activity_rank: 1, created_ts: '1' },
    { id: 'working', type: 'interactive', state: 'running', activity_rank: 4, created_ts: '2' },
  ], [{ from_id: 'stopped', to_id: 'working', type: 'continued', confidence: 'confirmed', active: true }]);
  assert.equal(roots[0].current_conversation_id, 'stopped');
  assert.equal(roots[0].state, 'stopped');
});
