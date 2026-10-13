import { basename, normalize } from 'node:path';

export function isUsageProbeCwd(cwd: unknown): boolean {
  return typeof cwd === 'string' && basename(normalize(cwd)) === 'usage-probe';
}

export const VISIBLE_CONVERSATION_SQL = "coalesce(rtrim(t.cwd, '/'), '') NOT GLOB '*/usage-probe' AND coalesce(t.cwd, '') != 'usage-probe'";
