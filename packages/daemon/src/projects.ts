// ダッシュボードからのプロジェクトの追加。フォルダを選ばせ、Git の根を状態置き場に登録する。
// 追加の印を events に残し、セッションが無くても一覧の Recent に出るようにする
import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { newSpanId, newTraceId } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";

const execFileAsync = promisify(execFile);
// osascript の choose folder を取り消したときの番号
const USER_CANCELED = -128;
const PICK_SCRIPT = ['activate', 'POSIX path of (choose folder with prompt "Choose a project folder")'];

export interface ProjectResult { ok: boolean; message: string; key?: string; cancelled?: boolean }
export type RunCommand = (file: string, args: string[]) => Promise<{ stdout: string }>;
const run: RunCommand = (file, args) => execFileAsync(file, args);

// macOS のフォルダ選択を開く。取り消したら undefined
export async function pickFolder(command: RunCommand = run): Promise<string | undefined> {
  try {
    const { stdout } = await command("osascript", PICK_SCRIPT.flatMap((line) => ["-e", line]));
    return stdout.trim().replace(/\/$/, "") || undefined;
  } catch (error) {
    const text = `${(error as { stderr?: string }).stderr ?? ""}${(error as Error).message ?? ""}`;
    if (text.includes(String(USER_CANCELED))) return undefined;
    throw error;
  }
}

export async function addProject(path: string, stores: Map<string, Store>, command: RunCommand = run, now = new Date()): Promise<ProjectResult> {
  if (!isAbsolute(path) || path.includes("\0")) return { ok: false, message: "Choose an absolute folder path" };
  let root: string;
  try { root = (await command("git", ["-C", path, "rev-parse", "--show-toplevel"])).stdout.trim(); }
  catch { return { ok: false, message: `${path} is not a Git repository` }; }
  const key = repoKey(root);
  let store = stores.get(key);
  if (!store) { store = openStore(stateDbPath(key)); stores.set(key, store); }
  const existed = !!store.db.prepare("SELECT 1 FROM repos WHERE key = ?").get(key);
  store.upsertRepo({ key, rootPath: root, name: basename(root) });
  store.appendEvent({ id: ulid(), ts: now.toISOString(), kind: "project.added", repo: key,
    trace: { traceId: newTraceId(), spanId: newSpanId() }, payload: { rootPath: root } });
  return { ok: true, message: existed ? `${basename(root)} is already added` : `Added ${basename(root)}`, key };
}
