import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// 仮想時計は隔離した台本と API の評価だけで共有する。待機や端末の時計は変えない。
export function stateNow(env = process.env) {
  let offset = 0;
  try { offset = JSON.parse(readFileSync(join(env.E2E_CONTROL, 'clock.json'), 'utf8')).offset; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Number.isFinite(offset)) throw new Error('Invalid E2E clock');
  return Date.now() + offset;
}
