import { createContext } from 'react';
export const OpenWorkspaceFile = createContext<((path: string, worktree?: string) => void) | undefined>(undefined);
export const OpenWorkspaceTerminal = createContext<((terminalId: string) => void) | undefined>(undefined);
export const OpenWorkspaceConversation = createContext<((conversationId: string) => boolean) | undefined>(undefined);

export interface ConversationTabMetadata { name: string; state: string; title: string; autoName?: string; startedAt?: string }
export const WorkspaceConversationHeader = createContext<{ tabId: string; report: (tabId: string, metadata: ConversationTabMetadata) => void } | undefined>(undefined);
