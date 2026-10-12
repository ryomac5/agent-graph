import type { ScreenState } from './store.ts';
import { resolveActivity } from './activity.ts';
import { readBody, readObject, readText, selectTimeline } from '../components/conversation/model.ts';
import { resolveParticipants, senderOf } from '../components/conversation/participants.ts';
import { instructionKind } from '../components/conversation/timeline.ts';
import { visibleText } from './message-body.ts';

export type ReplyStatus = 'reply' | 'answer';
const cache = new WeakMap<ScreenState, Map<string, ReplyStatus | undefined>>();

/** 既読に関係なく、生きている根の最後の発言から利用者の番を判定する。 */
export function resolveReplyStatus(state: ScreenState, conversationIds: string[], fallback = 'unknown'): ReplyStatus | undefined {
  const activity = resolveActivity(state, conversationIds, fallback);
  if (!['idle', 'waiting_input'].includes(activity.state)) return;
  const id = readText(activity.run?.conversation_id) || conversationIds.at(-1) || '';
  let statuses = cache.get(state);
  if (!statuses) { statuses = new Map(); cache.set(state, statuses); }
  if (statuses.has(id)) return statuses.get(id);
  const participants = resolveParticipants(state, id, { user: '', assistant: '', parent: '' });
  const conversation = state.projection.conversations?.find(row => row.id === id);
  if (participants.child || conversation?.type === 'unattended' || ['ended', 'failed', 'archived', 'closed'].includes(readText(conversation?.state))
    || Array.isArray(conversation?.pending_inputs) && conversation.pending_inputs.length > 0) return;
  const messages = selectTimeline(state, id).filter(entry => entry.kind === 'message' && !instructionKind(entry.row)).map(entry => entry.row);
  const spoken = messages.filter(row => {
    const sender = senderOf(row, participants);
    return sender.key === 'end' || readText(row.role) === 'assistant';
  });
  const last = spoken.at(-1);
  let status: ReplyStatus | undefined;
  if (last && readText(last.role) === 'assistant') {
    const body = Array.isArray(last.body) ? last.body.map(readObject).filter(block => !['tool_use', 'tool_result', 'thinking'].includes(readText(block.type))).map(readBody).join('\n') : readBody(last.body);
    const text = visibleText(body, Boolean(last.content_normalized)).replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').trim();
    const userIndex = messages.findLastIndex(row => senderOf(row, participants).key === 'end');
    const blocks = messages.slice(userIndex + 1).flatMap(row => Array.isArray(row.body) ? row.body.map(readObject) : []);
    const answered = new Set(blocks.filter(block => block.type === 'tool_result').map(block => readText(block.tool_use_id)));
    const question = blocks.some(block => block.type === 'tool_use' && /(?:^|[_.])(?:AskUserQuestion|ask_user_question|request_user_input)$/i.test(readText(block.name)) && !answered.has(readText(block.id)));
    status = /(?:[?？]|(?:ます|です|でしょう|ません)か[。．.]?)[\s"'”’」』)*_]*$/u.test(text) || question ? 'answer' : 'reply';
  }
  statuses.set(id, status);
  return status;
}
