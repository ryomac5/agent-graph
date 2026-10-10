import { useEffect, useState } from 'react';
export const SIDEBAR_WIDTH_KEY = 'agent-graph-sidebar-width';
export const SIDEBAR_COLLAPSED_KEY = 'agent-graph-sidebar-collapsed';
export const FILES_SPLIT_KEY = 'agent-graph-files-split';
export const FILES_COLLAPSED_KEY = 'agent-graph-files-collapsed';
export const CHANGES_SPLIT_KEY = 'agent-graph-changes-split';
export const SIDEBAR_INITIAL_WIDTH = 248;
export const SIDEBAR_COMPACT_WIDTH = 216;
export const SIDEBAR_RESTORE_WIDTH = 20;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 400;
export const clampSidebar = (value: number) => Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, value));
export function useStoredToggle(key: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) === '1');
  useEffect(() => { localStorage.setItem(key, value ? '1' : '0'); }, [key, value]);
  return [value, setValue] as const;
}
