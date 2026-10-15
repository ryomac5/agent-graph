import { expect, it } from 'vitest';
import { closePane, closeTab, createWorkspace, listPanes, moveTab, resizeSplit, restoreWorkspace, splitPane, updatePane } from '../lib/panes.ts';
it('splits in both directions without changing the original tree', () => {
  const original = createWorkspace('c');
  const horizontal = splitPane(original, 'initial-pane', 'horizontal', 'p2', 's1');
  const nested = splitPane(horizontal, 'p2', 'vertical', 'p3', 's2');
  expect(listPanes(original)).toHaveLength(1); expect(listPanes(nested).map(p => p.id)).toEqual(['initial-pane', 'p2', 'p3']);
  expect(listPanes(nested).flatMap(pane => pane.tabs)).toEqual(listPanes(original)[0].tabs);
  expect(listPanes(nested)[1]).toMatchObject({ tabs: [], active: undefined });
  expect(nested.kind === 'split' && nested.second.kind === 'split' && nested.second.direction).toBe('vertical');
});
it('collapses the empty side, selects the remaining tab, and can close the whole tree', () => {
  const tree = splitPane(createWorkspace('c'), 'initial-pane', 'horizontal', 'p2', 's', { id: 't2', kind: 'terminal' });
  expect(closeTab(tree, 't2')).toEqual(createWorkspace('c'));
  expect(closeTab(closeTab(tree, 't2')!, 'initial-tab')).toBeNull();
  const multiple = updatePane(tree, 'p2', p => ({ ...p, tabs: [...p.tabs, { kind: 'terminal', id: 't3' }] }));
  expect(listPanes(closeTab(multiple, 't2')!)[1].active).toBe('t3');
});
it('moves the last tab across panes and reorders within a pane without duplication', () => {
  const tree = splitPane(createWorkspace('c'), 'initial-pane', 'horizontal', 'p2', 's', { id: 't2', kind: 'terminal' });
  const moved = moveTab(tree, 'initial-tab', 'p2', 't2');
  expect(listPanes(moved)).toHaveLength(1); expect(listPanes(moved)[0].tabs.map(t => t.id)).toEqual(['initial-tab', 't2']);
  expect(listPanes(moveTab(moved, 't2', 'p2', 'initial-tab'))[0].tabs.map(t => t.id)).toEqual(['t2', 'initial-tab']);
  expect(moveTab(tree, 'initial-tab', 'missing')).toBe(tree);
});
it('resizes only the selected split and clamps limits', () => {
  const tree = splitPane(createWorkspace('c'), 'initial-pane', 'horizontal', 'p2', 's', { id: 't2', kind: 'terminal' });
  expect(resizeSplit(tree, 's', 5)).toMatchObject({ ratio: 0.9 }); expect(resizeSplit(tree, 's', -5)).toMatchObject({ ratio: 0.1 });
  expect(resizeSplit(tree, 's', NaN)).toBe(tree);
});
it('restores the layout and rejects invalid storage and duplicate identities', () => {
  const tree = splitPane(createWorkspace('c'), 'initial-pane', 'vertical', 'p2', 's', { id: 't2', kind: 'code', path: 'app.ts', worktree: '/repo' });
  expect(restoreWorkspace(JSON.stringify(tree), 'c')).toEqual(tree);
  for (const invalid of ['broken', '{}', JSON.stringify({ ...tree, ratio: 9 }), JSON.stringify({ ...tree, second: tree.kind === 'split' ? tree.first : tree })]) expect(restoreWorkspace(invalid, 'c')).toEqual(createWorkspace('c'));
});
it('restores an empty workspace after the final tab was closed', () => {
  expect(restoreWorkspace('null', 'c')).toBeNull();
});

it('preserves empty panes when closing unrelated tabs or moving tabs and closes panes explicitly', () => {
  const tree = splitPane(createWorkspace('c'), 'initial-pane', 'horizontal', 'p2', 's');
  expect(closeTab(tree, 'missing')).toEqual(tree);
  expect(closeTab(tree, 'initial-tab')).toEqual(listPanes(tree)[1]);
  expect(closePane(tree, 'p2')).toEqual(createWorkspace('c'));
  expect(closePane(closePane(tree, 'initial-pane')!, 'p2')).toBeNull();
  const nested = splitPane(tree, 'p2', 'vertical', 'p3', 's2');
  expect(listPanes(moveTab(nested, 'initial-tab', 'p3')).map(pane => pane.id)).toEqual(['p2', 'p3']);
  expect(restoreWorkspace(JSON.stringify(nested), 'c')).toEqual(nested);
  expect(restoreWorkspace(JSON.stringify({ kind: 'pane', id: 'empty', tabs: [], active: 'missing' }), 'c')).toEqual(createWorkspace('c'));
});

it('migrates only conversation tabs in the root series while preserving pane, tab and terminal identities', () => {
  const tree = { kind: 'pane' as const, id: 'pane', active: 'old-tab', tabs: [
    { kind: 'conversation' as const, id: 'old-tab', conversationId: 'old' },
    { kind: 'conversation' as const, id: 'child-tab', conversationId: 'child' },
    { kind: 'terminal' as const, id: 'terminal-tab', terminalId: 'running-terminal', worktree: '/repo' },
  ] };
  expect(restoreWorkspace(JSON.stringify(tree), 'current', ['old', 'current'])).toEqual({ ...tree,
    tabs: [{ ...tree.tabs[0], conversationId: 'current' }, ...tree.tabs.slice(1)] });
});
