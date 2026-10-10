import type { HTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon.tsx';

/** ファイルと変更で、開閉の印と字下げを共有する。 */
export function FileTreeRow({ depth = 0, directory = false, open = false, selected = false, children, className = '', style, ...attributes }: HTMLAttributes<HTMLDivElement> & {
  depth?: number; directory?: boolean; open?: boolean; selected?: boolean; children: ReactNode;
}) {
  return <div {...attributes} className={`tree-row${selected ? ' is-selected' : ''} ${className}`.trim()} style={{ paddingLeft: `calc(var(--space-2) + ${depth} * 16px)`, ...style }}>
    {directory ? <Icon className="tree-chevron" name={open ? 'chevronDown' : 'chevronRight'} size={16}/> : <span className="tree-chevron"/>}
    <Icon className="tree-icon" name={directory ? open ? 'folderOpen' : 'folder' : 'file'} size={16}/>
    {children}
  </div>;
}
