import type { Command } from './Commands.tsx';
import type { TurnSnapshot } from '../../lib/turns.ts';
import { rootHref } from '../../lib/turns.ts';
import { conversationName } from '../../lib/format.ts';
import { reviewConversations, selectRoots } from '../../lib/roots.ts';
import type { Language } from '../../lib/i18n.ts';

export function orderCommands(commands: Command[], snapshot: TurnSnapshot, language: Language): Command[] {
  const { state, turns, history, navigate } = snapshot;
  function deduplicate(rows: Command[]): Command[] {
    const names = new Set<string>();
    return rows.filter(row => { if (names.has(row.name)) return false; names.add(row.name); return true; });
  }
  if (!state || !navigate) return deduplicate(commands);
  const roots = selectRoots(state);
  const reviews = reviewConversations(state);
  const rootsByConversation = new Map(roots.flatMap(root => [...root.conversation_ids, root.id].map(id => [id, root] as const)));
  const conversations = new Map((state.projection.conversations ?? []).map(row => [String(row.id), row]));
  const rootCommands = new Map(commands.filter(command => command.id.startsWith('conversation-')).map(command => [command.id.slice('conversation-'.length), command]));
  const remaining = commands.filter(command => !command.id.startsWith('conversation-'));
  const seen = new Set<string>();
  const candidates: Command[] = [];
  function addConversation(id: string) {
    if (reviews.has(id)) return;
    const root = rootsByConversation.get(id);
    if (!root && !conversations.has(id)) return;
    const name = root?.name ?? conversationName(state!, id);
    if (seen.has(name)) return;
    seen.add(name);
    candidates.push(root && rootCommands.get(root.id) || {
      id: `conversation-${root?.id ?? id}`, name: language === 'ja' ? `会話を開く: ${name}` : `Open conversation: ${name}`,
      run: () => navigate!(root ? rootHref(root) : `/c/${encodeURIComponent(id)}`),
    });
  }
  for (const turn of turns) {
    if (turn.kind === 'approval') candidates.push({ id: `open-${turn.id}`,
      name: language === 'ja' ? `承認を開く: ${turn.id.slice('approval-'.length)}` : `Open approval: ${turn.id.slice('approval-'.length)}`,
      run: () => navigate(turn.to) });
    else addConversation(turn.conversationId);
  }
  for (const id of history.recent) addConversation(id);
  const priority = candidates.length;
  for (const root of roots) addConversation(root.conversation_ids.at(-1) ?? root.id);
  for (const id of conversations.keys()) addConversation(id);
  const ordered = [...candidates.slice(0, priority), ...remaining, ...candidates.slice(priority)];
  return deduplicate(ordered);
}
