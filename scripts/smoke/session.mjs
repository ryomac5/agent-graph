import { readFile } from 'node:fs/promises';
import { SMOKE_DIRECTORY, SMOKE_PROJECT_ID } from '../../packages/api/src/verification.ts';

/** 旧い保存先や利用者の会話へ戻らない。詳細も読み直して保存ファイルの取り違えを防ぐ。 */
export async function readSmokeSession(path, readConversation) {
  const saved = await readFile(path, 'utf8').then(JSON.parse, error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!saved) return;
  if (saved.version !== 2 || saved.cwd !== SMOKE_DIRECTORY || saved.project !== SMOKE_PROJECT_ID) {
    throw new Error('Unsafe saved smoke session; do not reuse a user conversation');
  }
  const parts = JSON.parse(saved.conversationId);
  if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== 'claude' || !/^[0-9a-f-]{36}$/.test(parts[1])) throw new Error('Invalid smoke conversation');
  const detail = await readConversation(saved.conversationId);
  const row = detail.projection?.conversations?.find(row => row.id === saved.conversationId);
  if (!row || row.cwd !== SMOKE_DIRECTORY || !row.hidden) throw new Error('Saved smoke conversation is not isolated and hidden');
  return saved;
}
