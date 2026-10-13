import { conversationName, conversationStart, readModel } from './format.ts';
import { resolveActivity } from './activity.ts';
import { isWorkingTurn, resolveWorkingTurn } from './turns.ts';
import { stateLabel } from '../components/StateBadge.tsx';
import type { Root } from './roots.ts';
import type { ScreenState } from './store.ts';
import type { Language } from './i18n.ts';
import type { ConversationTabMetadata } from './workspace-context.ts';

/** 隠れた本文を描かず、見えているタブの名前・状態だけを更新する。 */
export function refreshConversationTab(state: ScreenState, roots: Root[], id: string, previous: ConversationTabMetadata, language: Language, turns: Set<string>): ConversationTabMetadata {
  id = state.identities?.conversations[id] ?? id;
  if (!state.projection.conversations?.some(row => row.id === id)) return previous;
  const root = roots.find(root => root.conversation_ids.includes(id));
  const activity = resolveActivity(state, root?.conversation_ids ?? [id], previous.state, turns);
  const name = root?.name || conversationName(state, id) || previous.name;
  const turn = resolveWorkingTurn(activity.run && { ...activity.run, state: activity.state });
  const run = resolveActivity(state, [id]).run;
  const elapsedStarted = previous.elapsedEnabled && isWorkingTurn(turn)
    ? Number.isFinite(turn?.started) ? turn!.started : previous.state === activity.state ? previous.elapsedStarted : undefined : undefined;
  return { ...previous, name, state: activity.state, title: `${name} · ${stateLabel(activity.state, language)}`,
    autoName: root?.auto_name, startedAt: conversationStart(state, id), elapsedStarted,
    model: String(run?.model ?? '') || readModel(run).model || previous.model };
}
