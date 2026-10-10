import { ResizeDivider } from '../../components/ResizeDivider.tsx';
import { ResizableStack } from '../../components/ResizableStack.tsx';
import { FILES_SPLIT_KEY, FILES_COLLAPSED_KEY, useStoredToggle } from '../../lib/layout.ts';
import { DEFAULT_KEYS, createKeyHandler, type KeyBindings } from '../../lib/keys.ts';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { GraphPage } from '../graph/GraphPage.tsx';
import { ChangesPage } from '../changes/ChangesPage.tsx';
import { FileNotices, FileTreePanel, FileViewerPanel, useFileExplorer } from '../files/FilesPage.tsx';
import { Icon } from '../../components/Icon.tsx';

export const PANEL_WIDTH_KEY = 'agent-graph-panel-width';
export const PANEL_COLLAPSED_KEY = 'agent-graph-panel-collapsed';
export const PANEL_MIN_WIDTH = 320;

const PANEL_INITIAL_WIDTH = 420;
const clampWidth = (width: number) => Math.max(PANEL_MIN_WIDTH, Math.min(Math.max(PANEL_MIN_WIDTH, window.innerWidth / 2), width));

export function WorkspacePanel({ project, target, client, language, rootId, bindings = DEFAULT_KEYS }: {
  project: string; target: ScreenStore; client: ConversationClient; language: Language; rootId?: string; bindings?: KeyBindings;
}) {
  const [search, setSearch] = useSearchParams();
  const selected = search.get('panel');
  const tab = selected === 'changes' || selected === 'files' ? selected : 'graph';
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return saved > 0 && Number.isFinite(saved) ? clampWidth(saved) : window.innerWidth >= 1280 ? PANEL_INITIAL_WIDTH : 360;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === '1' || localStorage.getItem(PANEL_COLLAPSED_KEY) === null && window.innerWidth >= 900 && window.innerWidth < 1024);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const [treeCollapsed, setTreeCollapsed] = useStoredToggle(FILES_COLLAPSED_KEY);
  useEffect(() => {
    const handler = createKeyHandler({ togglePanel: bindings.togglePanel }, () => setCollapsed(value => !value));
    const keydown = (event: KeyboardEvent) => { if (!event.defaultPrevented && !document.querySelector('[role="dialog"]') && handler(event)) { event.preventDefault(); } };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [bindings]);
  const explorer = useFileExplorer({ client, target, project, enabled: tab === 'files' && !collapsed, embedded: true });
  const ja = language === 'ja';
  useEffect(() => { localStorage.setItem(PANEL_WIDTH_KEY, String(width)); }, [width]);
  useEffect(() => { localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => {
    const resize = () => { setViewportWidth(window.innerWidth); setWidth(value => clampWidth(value)); };
    window.addEventListener('resize', resize);
    return () => { window.removeEventListener('resize', resize); };
  }, []);
  const expandedQuery = new URLSearchParams(search);
  if (rootId) expandedQuery.set('root', rootId);
  return <aside className={`workspace-panel${collapsed ? ' panel-collapsed' : ''}`} aria-label={ja ? 'パネル' : 'Panel'} style={{ width: collapsed ? 0 : width }}>
    {!collapsed && <ResizeDivider className="panel-resize" label={ja ? 'パネルの幅' : 'Panel width'} orientation="vertical" value={width} min={PANEL_MIN_WIDTH} max={Math.max(PANEL_MIN_WIDTH, viewportWidth / 2)} step={20} reverse
      onChange={value => setWidth(clampWidth(value))} onDrag={delta => setWidth(clampWidth(width - delta))} onReset={() => setWidth(clampWidth(window.innerWidth >= 1280 ? PANEL_INITIAL_WIDTH : 360))}/>}
    <header className="panel-header">
      {!collapsed && <div className="panel-tabs" role="tablist" aria-label={ja ? 'パネル' : 'Panel'}>{(['graph', 'changes', 'files'] as const).map(value => <button key={value} role="tab" id={`panel-tab-${value}`} aria-controls="workspace-panel-content" aria-selected={tab === value}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = ['graph', 'changes', 'files']; const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3; const next = new URLSearchParams(search); next.set('panel', tabs[index]); setSearch(next); document.getElementById(`panel-tab-${tabs[index]}`)?.focus(); } }}
        onClick={() => { const next = new URLSearchParams(search); next.set('panel', value); setSearch(next); }}>{ja ? { graph: 'グラフ', changes: '変更', files: 'ファイル' }[value] : { graph: 'Graph', changes: 'Changes', files: 'Files' }[value]}</button>)}</div>}
      <div className="panel-actions">{!collapsed && tab !== 'files' && <Link className="icon-button panel-open-full" aria-label={ja ? '大きく開く' : 'Open full screen'} title={ja ? '大きく開く' : 'Open full screen'} to={`/p/${encodeURIComponent(project)}/${tab}?${expandedQuery}`}><Icon name="external" size={16}/></Link>}
      <button className="icon-button" aria-label={collapsed ? ja ? 'パネルを開く' : 'Expand panel' : ja ? 'パネルを畳む' : 'Collapse panel'} title={bindings.togglePanel} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} size={14}/></button></div>
    </header>
    {!collapsed && <div className="panel-content" role="tabpanel" id="workspace-panel-content" aria-labelledby={`panel-tab-${tab}`}>

      {tab === 'graph' ? <GraphPage project={project} target={target} client={client} language={language} rootId={rootId} embedded/>
        : tab === 'changes' ? <ChangesPage project={project} target={target} client={client} language={language} embedded/>
          : <div className="panel-files"><FileNotices explorer={explorer}/><button className="btn btn-ghost tree-toggle" aria-expanded={!treeCollapsed} onClick={() => setTreeCollapsed(value => !value)}>{treeCollapsed ? ja ? 'ファイルの木を開く' : 'Expand file tree' : ja ? 'ファイルの木を畳む' : 'Collapse file tree'}</button><ResizableStack storageKey={FILES_SPLIT_KEY} defaults={[0.45, 0.55]} labels={[ja ? 'ファイルの木の高さ' : 'File tree height']} collapsedFirst={treeCollapsed} children={[<FileTreePanel key="tree" explorer={explorer} language={language}/>, <FileViewerPanel explorer={explorer} language={language} actions={explorer.selectedPath && <button className="btn btn-ghost btn-xs" onClick={() => { const next = new URLSearchParams(search); next.delete('path'); setSearch(next); }}>{ja ? 'ファイルを閉じる' : 'Close file'}</button>}/>]}/></div>}
    </div>}
  </aside>;
}
