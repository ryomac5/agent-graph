// プロジェクトの開発の流れ。既定のブランチと作業中のブランチのコミットを、親つきでトポロジー順に返す。
// 画面はこれをツリーに描く。各コミットには作ったセッションを添える。
// 結び付けは、会話の記録に残る git commit のコマンドで行う。件名を含むコマンドを優先し、無ければ時刻の近さで選ぶ
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIELD = "\x1f";
const RECORD = "\x1e";
const FORMAT = `${RECORD}%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI${FIELD}%P${FIELD}%D`;
// 件名を含むコマンドは前後 30 分まで、件名を含まないコマンドは前後 2 分までを同じコミットとみなす
const SUBJECT_WINDOW_MS = 30 * 60_000;
const TIME_WINDOW_MS = 2 * 60_000;
const BRANCH_LIMIT = 12;
const INTERNAL_BRANCH = /^(worktree-|agent\/)/;

export interface CommitCommand { sessionId: string; at: string; command: string }
export interface SessionRef { id: string; name: string; client: string; startedAt?: string }
export interface ChangeCommit {
  sha: string; short: string; subject: string; author: string; at: string; parents: string[];
  // このコミットを指す手元のブランチ。作業用のブランチは除く
  refs: string[];
  files: number; insertions: number; deletions: number;
  sessions: SessionRef[];
}
export interface Changes { branch: string; branches: string[]; commits: ChangeCommit[]; hasMore: boolean }
type LogEntry = Omit<ChangeCommit, "sessions">;

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

// git log --shortstat の出力を、コミットごとの件名と増減に分ける
export function parseLog(output: string): LogEntry[] {
  const commits: LogEntry[] = [];
  for (const chunk of output.split(RECORD).slice(1)) {
    const [head, ...rest] = chunk.split("\n");
    const [sha, short, subject, author, at, parents, decoration] = head.split(FIELD);
    const stat = rest.join(" ");
    const number = (pattern: RegExp) => Number(pattern.exec(stat)?.[1] || 0);
    const refs = (decoration || "").split(", ").map((ref) => ref.replace(/^HEAD -> /, "").trim())
      .filter((ref) => ref && ref !== "HEAD" && !ref.startsWith("tag: ") && !INTERNAL_BRANCH.test(ref));
    commits.push({ sha, short, subject, author, at, parents: parents ? parents.split(" ") : [], refs,
      files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?\(\+\)/), deletions: number(/(\d+) deletions?\(-\)/) });
  }
  return commits;
}

// コミットを作ったセッションを選ぶ。件名を含むコマンドがあればそれだけを使う
export function sessionsFor(commit: { subject: string; at: string }, commands: CommitCommand[], names: Map<string, SessionRef>): SessionRef[] {
  const at = Date.parse(commit.at);
  const near = (window: number) => (command: CommitCommand) => Math.abs(Date.parse(command.at) - at) <= window;
  const subject = commit.subject.trim();
  let matched = subject.length >= 4 ? commands.filter((command) => command.command.includes(subject) && near(SUBJECT_WINDOW_MS)(command)) : [];
  if (!matched.length) matched = commands.filter(near(TIME_WINDOW_MS));
  // 引き継いだ会話は元の記録の行を写すので、同じコマンドが複数のセッションに残る。最初に始まったセッションだけに付ける
  const owner = new Map<string, SessionRef>();
  for (const command of matched) {
    const ref = names.get(command.sessionId);
    if (!ref) continue;
    const key = `${command.at}\0${command.command}`;
    const current = owner.get(key);
    if (!current || (ref.startedAt || "") < (current.startedAt || "")) owner.set(key, ref);
  }
  return [...new Map([...owner.values()].map((ref) => [ref.id, { id: ref.id, name: ref.name, client: ref.client }])).values()];
}

async function defaultBranch(root: string): Promise<string> {
  const remote = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  const name = remote.trim().replace(/^origin\//, "");
  if (name && await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).then(() => true, () => false)) return name;
  for (const candidate of ["main", "master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]).then(() => true, () => false)) return candidate;
  }
  return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function buildChanges(root: string, commands: CommitCommand[], names: Map<string, SessionRef>,
  { limit = 60, skip = 0 } = {}): Promise<Changes> {
  const branch = await defaultBranch(root);
  const branches = [branch, ...await openBranches(root, branch)];
  const log = parseLog(await git(root, ["log", "--topo-order", "--decorate-refs=refs/heads/", `--format=${FORMAT}`, "--shortstat",
    `--max-count=${limit + 1}`, `--skip=${skip}`, ...branches, "--"]));
  const hasMore = log.length > limit;
  const commits = log.slice(0, limit).map((entry) => ({ ...entry, sessions: sessionsFor(entry, commands, names) }));
  return { branch, branches, commits, hasMore };
}

// 既定のブランチにまだ入っていない手元のブランチ。作業中の機能としてツリーに含める。新しい順
async function openBranches(root: string, base: string): Promise<string[]> {
  const output = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
  const names: string[] = [];
  for (const name of output.split("\n").filter(Boolean)) {
    if (names.length >= BRANCH_LIMIT) break;
    // 子エージェントやタスクグラフの作業用のブランチは機能の単位ではないので出さない
    if (name === base || INTERNAL_BRANCH.test(name)) continue;
    const ahead = Number((await git(root, ["rev-list", "--count", `${base}..${name}`]).catch(() => "0")).trim());
    if (ahead) names.push(name);
  }
  return names;
}
