import { createContext, memo, useContext, useRef, type ReactNode } from 'react';

export const ViewVisible = createContext(true);
/** 入力や開閉状態を残し、隠れたタブへの親の更新を止める。 */
export const VisibleView = memo(function VisibleView({ visible, children, mountHidden = false }: { visible: boolean; children: ReactNode; mountHidden?: boolean }) {
  const parent = useContext(ViewVisible);
  const content = useRef<ReactNode>(mountHidden ? children : null);
  if (visible && parent) content.current = children;
  return <ViewVisible.Provider value={visible && parent}>{content.current}</ViewVisible.Provider>;
}, (before, next) => !before.visible && !next.visible);
