import { useEffect, useRef, useState } from 'react';
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
export const PANEL_MAX_WIDTH = 720;
const PANEL_INITIAL_WIDTH = 420;
const clampWidth = (width: number) => Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, width));

export function WorkspacePanel({ project, target, client, language, rootId }: {
  project: string; target: ScreenStore; client: ConversationClient; language: Language; rootId?: string;
}) {
  const [search, setSearch] = useSearchParams();
  const selected = search.get('panel');
  const tab = selected === 'changes' || selected === 'files' ? selected : 'graph';
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return saved > 0 && Number.isFinite(saved) ? clampWidth(saved) : PANEL_INITIAL_WIDTH;
  });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === '1');
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const explorer = useFileExplorer({ client, target, project, enabled: tab === 'files' && !collapsed, embedded: true });
  const ja = language === 'ja';
  useEffect(() => { localStorage.setItem(PANEL_WIDTH_KEY, String(width)); }, [width]);
  useEffect(() => { localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0'); }, [collapsed]);
  useEffect(() => {
    const move = (event: PointerEvent) => { if (drag.current) setWidth(clampWidth(drag.current.width + drag.current.x - event.clientX)); };
    const stop = () => { drag.current = undefined; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, []);
  const expandedQuery = new URLSearchParams(search);
  if (rootId) expandedQuery.set('root', rootId);
  return <aside className={`workspace-panel${collapsed ? ' panel-collapsed' : ''}`} aria-label={ja ? 'パネル' : 'Panel'} style={{ width: collapsed ? 40 : width }}>
    {!collapsed && <div className="panel-resize" role="separator" tabIndex={0} aria-label={ja ? 'パネルの幅' : 'Panel width'} aria-orientation="vertical" aria-valuemin={PANEL_MIN_WIDTH} aria-valuemax={PANEL_MAX_WIDTH} aria-valuenow={width}
      onPointerDown={event => { event.preventDefault(); drag.current = { x: event.clientX, width }; }}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => clampWidth(value + (event.key === 'ArrowLeft' ? 20 : -20))); } }}/>} 
    <header className="panel-header">
      {!collapsed && <div className="panel-tabs" role="tablist" aria-label={ja ? 'パネル' : 'Panel'}>{(['graph', 'changes', 'files'] as const).map(value => <button key={value} role="tab" id={`panel-tab-${value}`} aria-controls="workspace-panel-content" aria-selected={tab === value}
        onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = ['graph', 'changes', 'files']; const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3; const next = new URLSearchParams(search); next.set('panel', tabs[index]); setSearch(next); document.getElementById(`panel-tab-${tabs[index]}`)?.focus(); } }}
        onClick={() => { const next = new URLSearchParams(search); next.set('panel', value); setSearch(next); }}>{ja ? { graph: 'グラフ', changes: '変更', files: 'ファイル' }[value] : { graph: 'Graph', changes: 'Changes', files: 'Files' }[value]}</button>)}</div>}
      <button className="icon-button" aria-label={collapsed ? ja ? 'パネルを開く' : 'Expand panel' : ja ? 'パネルを畳む' : 'Collapse panel'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><Icon name={collapsed ? 'chevronLeft' : 'chevronRight'} size={14}/></button>
    </header>
    {!collapsed && <div className="panel-content" role="tabpanel" id="workspace-panel-content" aria-labelledby={`panel-tab-${tab}`}>
      {tab !== 'files' && <Link className="btn btn-ghost btn-xs panel-open-full" to={`/p/${encodeURIComponent(project)}/${tab}?${expandedQuery}`}><Icon name="external" size={12}/>{ja ? '大きく開く' : 'Open full screen'}</Link>}
      {tab === 'graph' ? <GraphPage project={project} target={target} client={client} language={language} rootId={rootId} embedded/>
        : tab === 'changes' ? <ChangesPage project={project} target={target} client={client} language={language} embedded/>
          : <div className="panel-files"><FileNotices explorer={explorer}/><FileTreePanel explorer={explorer} language={language}/><FileViewerPanel explorer={explorer} language={language} actions={explorer.selectedPath && <button className="btn btn-ghost btn-xs" onClick={() => { const next = new URLSearchParams(search); next.delete('path'); setSearch(next); }}>{ja ? 'ファイルを閉じる' : 'Close file'}</button>}/></div>}
    </div>}
  </aside>;
}
