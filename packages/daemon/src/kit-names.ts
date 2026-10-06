// 旧版の dotfiles キットが付けたセッションの番号に、daemon の名前をそろえる。
// キットは <repo>/.agents/state/sessions.json に「会話 ID → 名前」を書き、herdr の枠の名前と hook の通知にも使う。
// 名前が違うと herdr とダッシュボードで同じ会話を別の番号で呼ぶことになるので、キットの名前を正とする
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../../core/src/store/store.ts";
import { listRepos, listSessions } from "../../core/src/store/queries.ts";

const KIT_NAME = /^[A-Za-z0-9._-]+-\d{3,}$/;
const cache = new Map<string, { mtime: number; names: Map<string, string> }>();

export function kitNamesPath(rootPath: string): string {
  return join(rootPath, ".agents", "state", "sessions.json");
}

// 読めないときや形が違うときは空。書きかけの JSON も空として次の回に回す
export function readKitNames(rootPath: string): Map<string, string> {
  const path = kitNamesPath(rootPath);
  let mtime: number;
  try { mtime = statSync(path).mtimeMs; } catch { return new Map(); }
  const cached = cache.get(path);
  if (cached && cached.mtime === mtime) return cached.names;
  let names = new Map<string, string>();
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      names = new Map(Object.entries(data as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && KIT_NAME.test(entry[1])));
    }
  } catch { return cached?.names ?? new Map(); }
  cache.set(path, { mtime, names });
  return names;
}

// キットの名前と違うセッションを付け替える。付け替えた数を返す
export function syncKitNames(store: Store, now = new Date()): number {
  let renamed = 0;
  for (const repo of listRepos(store.db)) {
    const names = readKitNames(repo.rootPath);
    if (!names.size) continue;
    for (const session of listSessions(store.db, repo.key)) {
      const name = names.get(session.id);
      if (name && name !== session.name && store.renameSession(session.id, name, now.toISOString(), "kit")) renamed++;
    }
  }
  return renamed;
}
