// プロジェクトの開発の流れ。既定のブランチの一次の親をたどり、各コミットを作ったセッションを添える。
// 結び付けは、会話の記録に残る git commit のコマンドで行う。件名を含むコマンドを優先し、無ければ時刻の近さで選ぶ
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIELD = "\x1f";
const RECORD = "\x1e";
const FORMAT = `${RECORD}%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI${FIELD}%P`;
// 件名を含むコマンドは前後 30 分まで、件名を含まないコマンドは前後 2 分までを同じコミットとみなす
const SUBJECT_WINDOW_MS = 30 * 60_000;
const TIME_WINDOW_MS = 2 * 60_000;
const MERGE_CHILD_LIMIT = 30;
const BRANCH_LIMIT = 12;
const INTERNAL_BRANCH = /^(worktree-|agent\/)/;

export interface CommitCommand { sessionId: string; at: string; command: string }
export interface SessionRef { id: string; name: string; client: string; startedAt?: string }
export interface ChangeCommit {
  sha: string; short: string; subject: string; author: string; at: string;
  files: number; insertions: number; deletions: number;
  sessions: SessionRef[];
  merge?: { branch: string; commits: ChangeCommit[] };
}
export interface ChangeBranch { name: string; ahead: number; at: string; subject: string; sessions: SessionRef[] }
export interface Changes { branch: string; commits: ChangeCommit[]; branches: ChangeBranch[]; hasMore: boolean }
type LogEntry = Omit<ChangeCommit, "sessions" | "merge"> & { parents: string[] };

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

// git log --shortstat の出力を、コミットごとの件名と増減に分ける
export function parseLog(output: string): LogEntry[] {
  const commits: LogEntry[] = [];
  for (const chunk of output.split(RECORD).slice(1)) {
    const [head, ...rest] = chunk.split("\n");
    const [sha, short, subject, author, at, parents] = head.split(FIELD);
    const stat = rest.join(" ");
    const number = (pattern: RegExp) => Number(pattern.exec(stat)?.[1] || 0);
    commits.push({ sha, short, subject, author, at, parents: parents ? parents.split(" ") : [],
      files: number(/(\d+) files? changed/), insertions: number(/(\d+) insertions?\(\+\)/), deletions: number(/(\d+) deletions?\(-\)/) });
  }
  return commits;
}

// マージの件名から取り込んだブランチの名前を読む
export function mergedBranch(subject: string): string {
  const pull = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(subject);
  if (pull) return pull[1];
  const branch = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(subject);
  return branch ? branch[1] : "";
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
  { limit = 40, skip = 0 } = {}): Promise<Changes> {
  const branch = await defaultBranch(root);
  const log = parseLog(await git(root, ["log", "--first-parent", `--format=${FORMAT}`, "--shortstat", `--max-count=${limit + 1}`, `--skip=${skip}`, branch]));
  const hasMore = log.length > limit;
  const commits: ChangeCommit[] = [];
  for (const entry of log.slice(0, limit)) {
    const { parents, ...rest } = entry;
    const commit: ChangeCommit = { ...rest, sessions: sessionsFor(rest, commands, names) };
    if (parents.length > 1) {
      // マージは取り込んだ側のコミットを並べ、関わったセッションをまとめて添える
      const children = parseLog(await git(root, ["log", `--format=${FORMAT}`, "--shortstat", `--max-count=${MERGE_CHILD_LIMIT}`, `${parents[0]}..${parents[1]}`]))
        .map(({ parents: _parents, ...child }) => ({ ...child, sessions: sessionsFor(child, commands, names) }));
      commit.merge = { branch: mergedBranch(commit.subject), commits: children };
      const seen = new Map(commit.sessions.map((ref) => [ref.id, ref]));
      for (const child of children) for (const ref of child.sessions) seen.set(ref.id, ref);
      commit.sessions = [...seen.values()];
      commit.files = commit.files || children.reduce((sum, child) => sum + child.files, 0);
      commit.insertions = commit.insertions || children.reduce((sum, child) => sum + child.insertions, 0);
      commit.deletions = commit.deletions || children.reduce((sum, child) => sum + child.deletions, 0);
    }
    commits.push(commit);
  }
  return { branch, commits, branches: skip ? [] : await openBranches(root, branch, commands, names), hasMore };
}

// 既定のブランチにまだ入っていない手元のブランチ。作業中の機能として出す
async function openBranches(root: string, base: string, commands: CommitCommand[], names: Map<string, SessionRef>): Promise<ChangeBranch[]> {
  const output = await git(root, ["for-each-ref", "--sort=-committerdate", `--format=%(refname:short)${FIELD}%(committerdate:iso-strict)${FIELD}%(subject)`, "refs/heads"]);
  const branches: ChangeBranch[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    if (branches.length >= BRANCH_LIMIT) break;
    const [name, at, subject] = line.split(FIELD);
    // 子エージェントやタスクグラフの作業用のブランチは機能の単位ではないので出さない
    if (name === base || INTERNAL_BRANCH.test(name)) continue;
    const ahead = Number((await git(root, ["rev-list", "--count", `${base}..${name}`]).catch(() => "0")).trim());
    if (!ahead) continue;
    const own = parseLog(await git(root, ["log", `--format=${FORMAT}`, `--max-count=${MERGE_CHILD_LIMIT}`, `${base}..${name}`]));
    const seen = new Map<string, SessionRef>();
    for (const commit of own) for (const ref of sessionsFor(commit, commands, names)) seen.set(ref.id, ref);
    branches.push({ name, ahead, at, subject, sessions: [...seen.values()] });
  }
  return branches;
}
