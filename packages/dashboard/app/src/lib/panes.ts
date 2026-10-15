export type WorkspaceTab = { name?: string } & ({ id: string; kind: 'conversation'; conversationId: string } | { id: string; kind: 'code'; path: string; worktree?: string } | { id: string; kind: 'terminal'; worktree?: string; terminalId?: string });
export type Pane = { kind: 'pane'; id: string; tabs: WorkspaceTab[]; active?: string };
export type PaneTree = Pane | { kind: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; first: PaneTree; second: PaneTree };
export const MIN_RATIO = 0.1;
export type PaneEdge = 'left' | 'right' | 'top' | 'bottom';
export function splitAndMoveTab(tree: PaneTree, tabId: string, destination: string, edge: PaneEdge, paneId: string, splitId: string): PaneTree {
  if (!listPanes(tree).some(pane => pane.id === destination) || !listPanes(tree).some(pane => pane.tabs.some(tab => tab.id === tabId))) return tree;
  const split = splitPane(tree, destination, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical', paneId, splitId);
  function orient(node: PaneTree): PaneTree {
    if (node.kind === 'pane') return node;
    if (node.id === splitId && (edge === 'left' || edge === 'top')) return { ...node, first: node.second, second: node.first };
    return { ...node, first: orient(node.first), second: orient(node.second) };
  }
  return moveTab(orient(split), tabId, paneId);
}
export function listPanes(tree: PaneTree): Pane[] { return tree.kind === 'pane' ? [tree] : [...listPanes(tree.first), ...listPanes(tree.second)]; }
export function updatePane(tree: PaneTree, id: string, update: (pane: Pane) => Pane): PaneTree {
  return tree.kind === 'pane' ? tree.id === id ? update(tree) : tree : { ...tree, first: updatePane(tree.first, id, update), second: updatePane(tree.second, id, update) };
}
export function splitPane(tree: PaneTree, id: string, direction: 'horizontal' | 'vertical', paneId: string, splitId: string, tab?: WorkspaceTab): PaneTree {
  if (tree.kind === 'pane') return tree.id !== id ? tree : { kind: 'split', id: splitId, direction, ratio: 0.5, first: tree, second: { kind: 'pane', id: paneId, tabs: tab ? [tab] : [], active: tab?.id } };
  return { ...tree, first: splitPane(tree.first, id, direction, paneId, splitId, tab), second: splitPane(tree.second, id, direction, paneId, splitId, tab) };
}
export function closeTab(tree: PaneTree, tabId: string): PaneTree | null {
  if (tree.kind === 'pane') {
    if (!tree.tabs.some(tab => tab.id === tabId)) return tree;
    const tabs = tree.tabs.filter(tab => tab.id !== tabId);
    return tabs.length ? { ...tree, tabs, active: tabs.some(tab => tab.id === tree.active) ? tree.active : tabs.at(-1)!.id } : null;
  }
  const first = closeTab(tree.first, tabId), second = closeTab(tree.second, tabId);
  return first && second ? { ...tree, first, second } : first ?? second;
}
export function closePane(tree: PaneTree, paneId: string): PaneTree | null {
  if (tree.kind === 'pane') return tree.id === paneId ? null : tree;
  const first = closePane(tree.first, paneId), second = closePane(tree.second, paneId);
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
export function restoreWorkspace(value: string | null, conversationId: string, seriesIds: readonly string[] = []): PaneTree | null {
  if (value === 'null') return null;
  if (!value) return createWorkspace(conversationId);
  try {
    const tree = JSON.parse(value);
    const ids = new Set<string>();
    function validId(id: unknown): boolean { if (typeof id !== 'string' || !id || ids.has(id)) return false; ids.add(id); return true; }
    function validTab(value: unknown): boolean {
      if (!value || typeof value !== 'object') return false;
      const tab = value as Record<string, unknown>;
      if (!validId(tab.id) || tab.name !== undefined && typeof tab.name !== 'string') return false;
      if (tab.kind === 'conversation') return typeof tab.conversationId === 'string';
      if (tab.worktree !== undefined && typeof tab.worktree !== 'string') return false;
      if (tab.terminalId !== undefined && typeof tab.terminalId !== 'string') return false;
      return tab.kind === 'code' ? typeof tab.path === 'string' : tab.kind === 'terminal';
    }
    function valid(value: unknown, depth = 0): boolean {
      if (depth > 30 || !value || typeof value !== 'object') return false;
      const node = value as Record<string, unknown>;
      if (!validId(node.id)) return false;
      if (node.kind === 'split') return (node.direction === 'horizontal' || node.direction === 'vertical') && typeof node.ratio === 'number' && node.ratio >= MIN_RATIO && node.ratio <= 1 - MIN_RATIO && valid(node.first, depth + 1) && valid(node.second, depth + 1);
      return node.kind === 'pane' && Array.isArray(node.tabs) && (node.tabs.length === 0 ? node.active === undefined : node.tabs.some(tab => tab?.id === node.active)) && node.tabs.every(validTab);
    }
    return valid(tree) ? migrateWorkspaceSeries(tree, conversationId, seriesIds) : createWorkspace(conversationId);
  } catch { return createWorkspace(conversationId); }
}

export function migrateWorkspaceSeries(tree: PaneTree, conversationId: string, seriesIds: readonly string[]): PaneTree {
  if (tree.kind === 'split') {
    const first = migrateWorkspaceSeries(tree.first, conversationId, seriesIds), second = migrateWorkspaceSeries(tree.second, conversationId, seriesIds);
    return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
  }
  const tabs = tree.tabs.map(tab => tab.kind === 'conversation' && tab.conversationId !== conversationId && seriesIds.includes(tab.conversationId) ? { ...tab, conversationId } : tab);
  return tabs.every((tab, i) => tab === tree.tabs[i]) ? tree : { ...tree, tabs };
}
