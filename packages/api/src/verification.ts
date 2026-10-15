import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SMOKE_DIRECTORY = join(homedir(), '.cache/agent-graph/smoke');
export const SMOKE_PROJECT_ID = 'agent-graph-smoke';

/** 確認用の場所だけを非表示にする。近い名前や利用者の作業ツリーは含めない。 */
export function isSmokeDirectory(cwd: string): boolean {
  return Boolean(cwd) && resolve(cwd) === SMOKE_DIRECTORY;
}

export function verificationVisibility(cwd: string): { hidden?: true; hidden_reason?: string } {
  return isSmokeDirectory(cwd) ? { hidden: true, hidden_reason: 'Isolated smoke verification' } : {};
}
