import type { StateDecision } from '../../../core/src/state/index.ts';

export type ConversationDecision = Omit<StateDecision, 'display'> & {
  display: Omit<StateDecision['display'], 'label'> & { label: StateDecision['display']['label'] | 'Waiting for agents' };
};

/** turn の判定を保ち、現在の子の表示と試行から会話の代表表示を選ぶ。 */
export function renderConversationState(parent: StateDecision, children: readonly StateDecision[]): ConversationDecision {
  const waiting = parent.display.label === 'Idle' && children.some(child =>
    ['Working', 'Needs approval'].includes(child.display.label)
    && (child.result.stage === 'launched' || child.result.value === 'incomplete'));
  return waiting ? { ...parent, display: { ...parent.display, label: 'Waiting for agents' } } : parent;
}
