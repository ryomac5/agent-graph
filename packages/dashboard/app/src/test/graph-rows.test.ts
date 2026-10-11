import { expect, it } from 'vitest';
import { buildRows, readExpanded, PAGE_SIZE, type GraphNode, type GraphTree } from '../pages/graph/rows.ts';
import { createTimeScale } from '../pages/graph/GraphTimeline.tsx';
const now = new Date(2026, 9, 11, 12).getTime();
function node(id: string, state = 'ended', children: string[] = [], age = 0, role = 'implement'): GraphNode {
  return { id, kind: 'conversation', label: id, conversationId: id, state, role, provider: 'codex', model: '', children, attempts: [], activity: new Date(now - age).toISOString() };
}
function tree(nodes: GraphNode[]): GraphTree { return { nodes, roots: ['root'], edges: [], unresolved: [] }; }
it('emits depth-first rows, protects active ancestry and colors every edge on its path', () => {
  const input = tree([node('root', 'idle', ['old', 'parent']), node('parent', 'ended', ['child'], 48 * 3600_000), node('child', 'running'), node('old', 'ended', [], 48 * 3600_000)]);
  const original = structuredClone(input);
  const result = buildRows(input, { now });
  expect(result.rows.map(row => row.id)).toEqual(['root', 'parent', 'child', 'earlier:root']);
  expect(result.rows.map(row => row.depth)).toEqual([0, 1, 2, 1]);
  expect(result.rows.slice(0, 3).every(row => row.runningPath)).toBe(true);
  expect(result.rows[0].runningBelow).toBe(1);
  expect(result.rows[2].height).toBe(52);
  expect(input).toEqual(original);
});
it('retains five recent completions per parent, today groups, earlier groups and recent failures', () => {
  const children = Array.from({ length: 8 }, (_, i) => node(`done-${i}`, 'ended', [], i * 60_000));
  const input = tree([node('root', 'idle', [...children.map(row => row.id), 'today', 'old', 'failure', 'old-failure', 'reply']), ...children,
    node('today', 'ended', [], 3 * 3600_000), node('old', 'ended', [], 48 * 3600_000), node('failure', 'failed', [], 24 * 3600_000), node('old-failure', 'failed', [], 25 * 3600_000), node('reply', 'waiting_input', [], 72 * 3600_000)]);
  const result = buildRows(input, { now });
  expect(result.rows.filter(row => row.id.startsWith('done-'))).toHaveLength(5);
  expect(result.rows.find(row => row.id === 'today:root')?.group?.count).toBe(4);
  expect(result.rows.find(row => row.id === 'earlier:root')?.group?.count).toBe(2);
  expect(result.rows.some(row => row.id === 'failure')).toBe(true);
  expect(result.needsYou).toBe(1);
  expect(result.roles.implement).toBe(13);
});
it('opens groups twenty children at a time and restores expansion from the URL', () => {
  const children = Array.from({ length: 45 }, (_, i) => node(`old-${i}`, 'ended', [], 48 * 3600_000));
  const input = tree([node('root', 'idle', children.map(row => row.id)), ...children]);
  const result = buildRows(input, { now, expanded: readExpanded(['earlier:root@40']) });
  expect(result.rows.filter(row => row.node && row.parent)).toHaveLength(PAGE_SIZE * 2);
  expect(result.rows.find(row => row.group)?.group).toMatchObject({ shown: 40, count: 45, roles: { implement: 45 } });
  const selected = buildRows(input, { now, selected: 'old-44' });
  expect(selected.rows.some(row => row.id === 'old-44')).toBe(true);
});
it('filters by role including folded rows while retaining ancestors and stable totals', () => {
  const input = tree([node('root', 'idle', ['work', 'docs']), node('work', 'ended', ['review'], 48 * 3600_000), node('review', 'ended', [], 48 * 3600_000, 'review'), node('docs', 'ended', [], 48 * 3600_000, 'write')]);
  const result = buildRows(input, { now, role: 'review' });
  expect(result.rows.map(row => row.id)).toEqual(['root', 'work', 'review']);
  expect(result.roles).toEqual({ implement: 1, review: 1, document: 1 });
});
it('uses actual attempt times and compresses only gaps beyond thirty minutes', () => {
  const segments = [{ start: now - 4 * 3600_000, end: now - 3 * 3600_000, state: 'ended' }, { start: now - 3600_000, end: now, state: 'running' }];
  const scale = createTimeScale(segments, now, 'All', 600);
  expect(scale.gaps).toHaveLength(1);
  expect((scale.position(scale.gaps[0].end) - scale.position(scale.gaps[0].start)) * 6).toBeCloseTo(16);
  expect(scale.position(now)).toBe(100);
  expect(createTimeScale(segments, now, '1h', 600).gaps).toHaveLength(0);
});

it('依頼の題から Markdown の見出しの印を外す', async () => {
  const { requestTitle } = await import('../lib/roots.ts');
  expect(requestTitle('# グラフを直す')).toBe('グラフを直す');
  expect(requestTitle('### 直す')).toBe('直す');
  expect(requestTitle('C# の直し')).toBe('C# の直し');
});
