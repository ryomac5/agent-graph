// 旧版の dotfiles キットが付けたセッションの番号に、daemon の名前をそろえる。
// キットは <repo>/.agents/state/sessions.json に「会話 ID → 名前」を書き、herdr の枠の名前と hook の通知にも使う。
// 名前が違うと herdr とダッシュボードで同じ会話を別の番号で呼ぶことになるので、キットの名前を正とする
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { UNNAMED, type Store } from "../../core/src/store/store.ts";
import { listRepos, listSessions } from "../../core/src/store/queries.ts";

const KIT_NAME = /^[A-Za-z0-9._-]+-\d{3,}$/;
// キットの hook が Claude の会話に番号を書くまで待つ時間。過ぎても書かれなければ daemon がキットの数え方で付ける
const KIT_GRACE_MS = 120_000;
// キットの next_counter と同じ手順。counter.lock を flock で押さえ、counter を 1 つ進めて原子的に書く
const ALLOCATE_SCRIPT = `import fcntl, os, sys, tempfile
path = sys.argv[1]
with open(path + ".lock", "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        value = int(open(path).read().strip()) + 1 if os.path.exists(path) else 1
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
        with os.fdopen(fd, "w") as out:
            out.write(str(value))
        os.replace(tmp, path)
        print(value)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
`;
// 番号を待っている Claude の会話。会話 ID → 最初の人の指示の時刻
const pending = new Map<string, string>();
const cache = new Map<string, { mtime: number; names: Map<string, string> }>();

export function kitNamesPath(rootPath: string): string {
  return join(rootPath, ".agents", "state", "sessions.json");
}

export function kitCounterPath(rootPath: string): string {
  return join(rootPath, ".agents", "state", "counter");
}

// このリポジトリでキットが番号を数えているか
export function hasKit(rootPath: string): boolean {
  return existsSync(kitCounterPath(rootPath)) || existsSync(kitNamesPath(rootPath));
}

// キットの counter から次の番号を取り、キットと同じ形の名前にする
export function allocateKitName(rootPath: string, run: (script: string, path: string) => string = (script, path) =>
  execFileSync("python3", ["-c", script, path], { encoding: "utf8" })): string {
  const value = Number(run(ALLOCATE_SCRIPT, kitCounterPath(rootPath)).trim());
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid kit counter: ${value}`);
  return `${basename(rootPath)}-${String(value).padStart(3, "0")}`;
}

// 最初の人の指示で番号を付ける。キットのあるリポジトリでは、キットと番号を取り合わない。
// Claude の会話はキットの hook が付けるので待ち、Codex などキットが付けない会話はキットの counter から取る
export function nameAtFirstPrompt(store: Store, sessionId: string, at: string): void {
  const row = store.db.prepare(`SELECT s.client, r.root_path FROM sessions s JOIN repos r ON r.key = s.repo_key WHERE s.id = ?`).get(sessionId);
  const root = row ? String(row.root_path) : "";
  if (!row || !hasKit(root)) { store.nameSessionAtFirstPrompt(sessionId, at); return; }
  if (row.client === "claude") {
    if (!pending.has(sessionId)) pending.set(sessionId, at);
    store.nameSessionAtFirstPrompt(sessionId, at, () => undefined);
    return;
  }
  store.nameSessionAtFirstPrompt(sessionId, at, () => allocateKitName(root));
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

// キットの番号に名前をそろえる。付け替えた数を返す。
// 1. キットが番号を書いた会話は、その番号にする
// 2. キットの番号と重なった、キットが知らない会話は、キットの counter から取り直す。fork で親の番号を継いだものは除く
// 3. 番号を待っている Claude の会話で、待つ時間を過ぎてもキットが書かなかったものは、キットの counter から取る
export function syncKitNames(store: Store, now = new Date(), allocate: (rootPath: string) => string = (root) => allocateKitName(root)): number {
  let renamed = 0;
  const at = now.toISOString();
  for (const repo of listRepos(store.db)) {
    if (!hasKit(repo.rootPath)) continue;
    const names = readKitNames(repo.rootPath);
    const sessions = listSessions(store.db, repo.key);
    for (const session of sessions) {
      const name = names.get(session.id);
      if (name) {
        pending.delete(session.id);
        if (name !== session.name && store.renameSession(session.id, name, at, "kit")) renamed++;
      }
    }
    const kitOwned = new Map<string, string>();
    for (const [id, name] of names) kitOwned.set(name, id);
    for (const session of listSessions(store.db, repo.key)) {
      if (names.has(session.id) || session.name === UNNAMED) continue;
      const owner = kitOwned.get(session.name);
      if (!owner || owner === session.id) continue;
      const forked = store.db.prepare(`SELECT 1 FROM events WHERE kind = 'session.forked' AND session_id = ?
        AND json_extract(payload, '$.parentSessionId') IN (SELECT id FROM sessions WHERE name = ?)`).get(session.id, session.name);
      if (forked) continue;
      if (store.renameSession(session.id, allocate(repo.rootPath), at, "kit")) renamed++;
    }
    for (const session of listSessions(store.db, repo.key)) {
      const since = pending.get(session.id);
      if (!since || session.name !== UNNAMED || names.has(session.id)) continue;
      if (now.getTime() - Date.parse(since) < KIT_GRACE_MS) continue;
      pending.delete(session.id);
      if (store.nameSessionAtFirstPrompt(session.id, at, () => allocate(repo.rootPath)) !== undefined) renamed++;
    }
  }
  return renamed;
}
