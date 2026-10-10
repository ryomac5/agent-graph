import type { UiAppender } from '../service/index.ts';
import type { RootProjection } from '../../../core/src/ledger/projections/roots.ts';
import type { ScreenCommand } from './contract.ts';

export const SESSION_NAME_LIMIT = 80;
export async function renameSession(ledger: { append: UiAppender }, roots: readonly RootProjection[], message: ScreenCommand) {
  const payload = message.payload as { rootId?: unknown; name?: unknown } | undefined;
  if (!payload || typeof payload.rootId !== 'string' || typeof payload.name !== 'string') throw new Error('Invalid session name');
  const name = payload.name.trim();
  // 空欄は利用者の名前を解除する。
  if ([...name].length > SESSION_NAME_LIMIT || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('Invalid session name');
  if (!roots.some(root => root.id === payload.rootId)) throw new Error('Unknown session');
  const result = await ledger.append({ source: 'ui', source_event_id: `session.rename:${message.cmd_id}`,
    kind: 'conversation.renamed', subject: `conversation:${payload.rootId}`, payload: { user_name: name || null },
    confidence: 'confirmed', source_ts: new Date().toISOString() });
  if (result.status === 'conflict') throw new Error('Conflicting session rename');
  return { rootId: payload.rootId, name: name || null };
}
