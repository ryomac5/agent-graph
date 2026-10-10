import { createContext } from 'react';
export const OpenWorkspaceFile = createContext<((path: string, worktree?: string) => void) | undefined>(undefined);
