import type { ConversationClient, SessionHost } from '../pages/conversation/ConversationPage.tsx';
export const SESSION_PROVIDER_KEY = 'agent-graph-session-provider';
const START_TIMEOUT_MS = 30000;
const DISCOVERY_POLL_MS = 500;
export function readSessionProvider() { return localStorage.getItem(SESSION_PROVIDER_KEY) === 'codex' ? 'codex' : 'claude'; }
export async function request<T>(client: ConversationClient, command: string, payload: object = {}): Promise<T> {
  const ack = await client.command(command, payload);
  if (!ack.ok) throw new Error(ack.error || 'Request failed');
  return ack.result as T;
}
export async function startSession(client: ConversationClient, payload: object, options: {
  terminalId?: string; onLaunched(id: string): void; active(): boolean;
}): Promise<SessionHost | undefined> {
  const terminalId = options.terminalId ?? (await request<{ terminalId: string }>(client, 'session.launch', payload)).terminalId;
  options.onLaunched(terminalId);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (options.active()) {
    const result = await request<{ hosts: SessionHost[] }>(client, 'session.hosts');
    const host = result.hosts.find(row => row.terminalId === terminalId);
    if (host?.disconnected) throw new Error('Connection lost');
    if (host) return host;
    if (Date.now() >= deadline) throw new Error('Start timed out');
    await new Promise(resolve => setTimeout(resolve, DISCOVERY_POLL_MS));
  }
}
