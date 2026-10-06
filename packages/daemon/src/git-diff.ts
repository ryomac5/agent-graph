// 1 つのコミットの差分。ファイルごとに塊と行に分け、行番号を付けて返す。
// マージは一次の親との差分、最初のコミットは空の木との差分にする。大きすぎる差分は途中で切る
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIELD = "\x1f";
const SHA = /^[0-9a-f]{7,40}$/;
// 差分全体と 1 ファイルの行の上限。これを超えたら切って truncated を立てる
const TOTAL_LINE_LIMIT = 8000;
const FILE_LINE_LIMIT = 1500;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface DiffLine { kind: "add" | "del" | "ctx"; old?: number; new?: number; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile {
  path: string; oldPath?: string; status: "added" | "deleted" | "modified" | "renamed";
  additions: number; deletions: number; binary: boolean; truncated: boolean; hunks: DiffHunk[];
}
export interface CommitDiff {
  sha: string; short: string; subject: string; body: string; author: string; at: string; parents: string[];
  base: string; files: DiffFile[]; truncated: boolean;
}

// git diff の出力をファイルと塊と行に分ける
export function parseDiff(output: string): { files: DiffFile[]; truncated: boolean } {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let total = 0;
  let truncated = false;
  const lineCount = (target: DiffFile) => target.hunks.reduce((sum, item) => sum + item.lines.length, 0);
  for (const line of output.split("\n")) {
    const start = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (start) {
      file = { path: start[2], status: "modified", additions: 0, deletions: 0, binary: false, truncated: false, hunks: [] };
      if (start[1] !== start[2]) file.oldPath = start[1];
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = line.slice(12); }
      else if (line.startsWith("rename to ")) file.path = line.slice(10);
      else if (line.startsWith("Binary files ")) file.binary = true;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith("\\")) continue;
    const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : line[0] === " " ? "ctx" : undefined;
    if (!kind) continue;
    if (kind === "add") file.additions++;
    if (kind === "del") file.deletions++;
    // 数は全部数え、行は上限まで残す
    if (total >= TOTAL_LINE_LIMIT || lineCount(file) >= FILE_LINE_LIMIT) { file.truncated = true; truncated = true; continue; }
    total++;
    if (kind === "add") hunk.lines.push({ kind, new: newLine++, text: line.slice(1) });
    else if (kind === "del") hunk.lines.push({ kind, old: oldLine++, text: line.slice(1) });
    else hunk.lines.push({ kind, old: oldLine++, new: newLine++, text: line.slice(1) });
  }
  return { files, truncated };
}

export async function commitDiff(root: string, sha: string): Promise<CommitDiff> {
  if (!SHA.test(sha)) throw new TypeError("Invalid commit");
  const git = async (args: string[]) => (await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const [full, short, subject, author, at, parents, ...body] = (await git(["show", "-s", `--format=%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI${FIELD}%P${FIELD}%b`, sha, "--"])).split(FIELD);
  const parentList = parents ? parents.split(" ").filter(Boolean) : [];
  const base = parentList[0] || EMPTY_TREE;
  const output = await git(["diff", "--no-color", "--no-ext-diff", "-M", "--unified=3", base, full, "--"]);
  const { files, truncated } = parseDiff(output);
  return { sha: full, short, subject, body: body.join(FIELD).trim(), author, at, parents: parentList, base, files, truncated };
}
