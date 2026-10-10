export type WorkspaceTab = { id: string; kind: 'conversation'; conversationId: string } | { id: string; kind: 'code'; path: string; worktree?: string } | { id: string; kind: 'terminal'; worktree?: string };
export type Pane = { kind: 'pane'; id: string; tabs: WorkspaceTab[]; active: string };
export type PaneTree = Pane | { kind: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; first: PaneTree; second: PaneTree };
export const MIN_RATIO = 0.1;
export function listPanes(tree: PaneTree): Pane[] { return tree.kind === 'pane' ? [tree] : [...listPanes(tree.first), ...listPanes(tree.second)]; }
export function updatePane(tree: PaneTree, id: string, update: (pane: Pane) => Pane): PaneTree {
  return tree.kind === 'pane' ? tree.id === id ? update(tree) : tree : { ...tree, first: updatePane(tree.first, id, update), second: updatePane(tree.second, id, update) };
}
export function splitPane(tree: PaneTree, id: string, direction: 'horizontal' | 'vertical', tab: WorkspaceTab, paneId: string, splitId: string): PaneTree {
  if (tree.kind === 'pane') return tree.id !== id ? tree : { kind: 'split', id: splitId, direction, ratio: 0.5, first: tree, second: { kind: 'pane', id: paneId, tabs: [tab], active: tab.id } };
  return { ...tree, first: splitPane(tree.first, id, direction, tab, paneId, splitId), second: splitPane(tree.second, id, direction, tab, paneId, splitId) };
}
export function closeTab(tree: PaneTree, tabId: string): PaneTree | null {
  if (tree.kind === 'pane') {
    const tabs = tree.tabs.filter(tab => tab.id !== tabId);
    return tabs.length ? { ...tree, tabs, active: tabs.some(tab => tab.id === tree.active) ? tree.active : tabs.at(-1)!.id } : null;
  }
  const first = closeTab(tree.first, tabId), second = closeTab(tree.second, tabId);
  return first && second ? { ...tree, first, second } : first ?? second;
}
export function moveTab(tree: PaneTree, tabId: string, destination: string, before?: string): PaneTree {
  const tab = listPanes(tree).flatMap(pane => pane.tabs).find(tab => tab.id === tabId);
  if (!tab || !listPanes(tree).some(pane => pane.id === destination) || before === tabId) return tree;
  // 移動先に先に入れることで、最後のタブを移す区画だけを畳む。
  const inserted = updatePane(tree, destination, pane => {
    const tabs = pane.tabs.filter(item => item.id !== tabId);
    const index = before ? tabs.findIndex(item => item.id === before) : -1;
    tabs.splice(index < 0 ? tabs.length : index, 0, tab);
    return { ...pane, tabs, active: tabId };
  });
  function remove(node: PaneTree): PaneTree | null {
    if (node.kind === 'pane') return node.id === destination ? node : closeTab(node, tabId);
    const first = remove(node.first), second = remove(node.second);
    return first && second ? { ...node, first, second } : first ?? second;
  }
  return remove(inserted)!;
}
export function resizeSplit(tree: PaneTree, id: string, ratio: number): PaneTree {
  if (tree.kind === 'pane' || !Number.isFinite(ratio)) return tree;
  return tree.id === id ? { ...tree, ratio: Math.max(MIN_RATIO, Math.min(1 - MIN_RATIO, ratio)) } : { ...tree, first: resizeSplit(tree.first, id, ratio), second: resizeSplit(tree.second, id, ratio) };
}
export function createWorkspace(conversationId: string): PaneTree { return { kind: 'pane', id: 'initial-pane', tabs: [{ kind: 'conversation', id: 'initial-tab', conversationId }], active: 'initial-tab' }; }
export function workspaceKey(project: string, session: string): string { return `agent-graph-workspace:${JSON.stringify([project, session])}`; }
export function restoreWorkspace(value: string | null, conversationId: string): PaneTree | null {
  if (value === 'null') return null;
  if (!value) return createWorkspace(conversationId);
  try {
    const tree = JSON.parse(value);
    const ids = new Set<string>();
    function validId(id: unknown): boolean { if (typeof id !== 'string' || !id || ids.has(id)) return false; ids.add(id); return true; }
    function validTab(value: unknown): boolean {
      if (!value || typeof value !== 'object') return false;
      const tab = value as Record<string, unknown>;
      if (!validId(tab.id)) return false;
      if (tab.kind === 'conversation') return typeof tab.conversationId === 'string';
      if (tab.worktree !== undefined && typeof tab.worktree !== 'string') return false;
      return tab.kind === 'code' ? typeof tab.path === 'string' : tab.kind === 'terminal';
    }
    function valid(value: unknown, depth = 0): boolean {
      if (depth > 30 || !value || typeof value !== 'object') return false;
      const node = value as Record<string, unknown>;
      if (!validId(node.id)) return false;
      if (node.kind === 'split') return (node.direction === 'horizontal' || node.direction === 'vertical') && typeof node.ratio === 'number' && node.ratio >= MIN_RATIO && node.ratio <= 1 - MIN_RATIO && valid(node.first, depth + 1) && valid(node.second, depth + 1);
      return node.kind === 'pane' && Array.isArray(node.tabs) && node.tabs.length > 0 && node.tabs.some(tab => tab?.id === node.active) && node.tabs.every(validTab);
    }
    return valid(tree) ? tree : createWorkspace(conversationId);
  } catch { return createWorkspace(conversationId); }
}
