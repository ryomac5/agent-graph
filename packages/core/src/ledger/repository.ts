import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { ProjectPayload } from "./facts.ts";
import { createRepositoryId } from "./projections/projects.ts";

export interface GitResult { status: number; stdout: string }
/** git の引数を受けて終了コードと標準出力を返す。導入側は自前の実行器を渡す。 */
export type GitRunner = (args: string[]) => GitResult;

export type ProjectLocation = ProjectPayload & {
  /** 登録しない理由。消えたリポジトリか、一時の場所の本体である。 */
  reason?: "missing" | "temporary";
};

/** 台帳に書く列だけを取り出す。登録しない理由は事実に含めない。 */
export function toProjectPayload(location: ProjectLocation): ProjectPayload {
  const { repository_id, root_path, display_name, name_prefix, state } = location;
  return { repository_id, root_path, display_name, name_prefix, state };
}

const SYSTEM_TEMPORARY_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

function runGit(args: string[]): GitResult {
  try {
    return { status: 0, stdout: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
  } catch (error) {
    return { status: typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 1, stdout: "" };
  }
}

function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/** OS の一時ディレクトリ、/tmp と /var/folders、agent-graph の作業ツリーの置き場を返す。 */
export function defaultTemporaryRoots(env: Record<string, string | undefined> = process.env, home = homedir()): string[] {
  const cache = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, ".cache");
  return [env.TMPDIR || tmpdir(), ...SYSTEM_TEMPORARY_ROOTS, join(cache, "agent-graph", "worktrees")];
}

export function normalizeTemporaryRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.flatMap((root) => [resolve(root), canonical(root)]))].sort();
}

function isUnder(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep));
}

function readMainWorktree(root: string, git: GitRunner): { path: string; bare: boolean } | undefined {
  const result = git(["-C", root, "worktree", "list", "--porcelain"]);
  if (result.status !== 0) return undefined;
  // 先頭の項目が本体である。本体は git の共通のディレクトリの持ち主になる。
  const block = result.stdout.split(/\n\n/)[0].split("\n");
  const head = block.find((line) => line.startsWith("worktree "));
  return head ? { path: head.slice("worktree ".length), bare: block.includes("bare") } : undefined;
}

/**
 * 旧い DB の行や導入の対象のパスから、所属するプロジェクトを決める。
 * 作業ツリーは本体のプロジェクトに寄せ、表示名は本体のディレクトリ名にする。
 * 消えたリポジトリと、本体が一時の場所にあるリポジトリは登録しない。
 */
export function resolveProjectLocation(
  root: string, options: { temporaryRoots?: readonly string[]; git?: GitRunner } = {},
): ProjectLocation {
  const git = options.git ?? runGit;
  const temporaryRoots = normalizeTemporaryRoots(options.temporaryRoots ?? defaultTemporaryRoots());
  const common = git(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonPath = common.status === 0 ? common.stdout.trim() : "";
  const main = commonPath && existsSync(commonPath) ? readMainWorktree(root, git) : undefined;
  if (!commonPath || !existsSync(commonPath) || !main) {
    // 消えた旧リポジトリは推定の git パスを確定 ID にせず、旧パスの名前空間に残す。
    const repository_id = createHash("sha256").update(JSON.stringify(["legacy-repository", root])).digest("hex");
    const root_path = canonical(root);
    return { repository_id, root_path, display_name: basename(root_path), name_prefix: basename(root_path),
      state: "unregistered", reason: "missing" };
  }
  const commonDirectory = realpathSync(commonPath);
  const repository_id = createRepositoryId(commonDirectory);
  // 作業ツリーの無い bare は共通のディレクトリを本体として扱う。
  const body = main.bare ? commonDirectory : main.path;
  const root_path = canonical(body);
  const name = main.bare ? basename(root_path).replace(/\.git$/, "") || basename(root_path) : basename(root_path);
  const base = { repository_id, root_path, display_name: name, name_prefix: name };
  if (!existsSync(body)) return { ...base, state: "unregistered", reason: "missing" };
  if (isUnder(root_path, temporaryRoots) || isUnder(resolve(body), temporaryRoots)) {
    return { ...base, state: "unregistered", reason: "temporary" };
  }
  return { ...base, state: "registered" };
}
