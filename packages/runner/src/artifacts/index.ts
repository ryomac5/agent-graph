import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ArtifactPayload, Fact, JsonValue, Provider, RunPayload } from "../../../core/src/ledger/facts.ts";
import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import { redact, redactValue, type RedactionRules } from "../../../core/src/ledger/redact.ts";
import { classifyGitAttribution, projectArtifacts, type GitAttributionEvidence } from "../../../core/src/ledger/projections/artifacts.ts";
import { projectDelegations, projectEntityRecords } from "../../../core/src/ledger/projections/delegations.ts";
import type { WorktreeRecord } from "../worktree.ts";

const READ_BATCH_SIZE = 1000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
export interface ArtifactOptions {
  blobDirectory?: string;
}
export interface CommitResult {
  success: boolean;
  head_sha?: string;
  help?: boolean;
  operation?: "amend" | "cherry-pick";
  original_sha?: string;
}
export interface ArtifactRequest {
  runId: string;
  provider: Provider;
  sourceEventId: string;
  sourceTs: string;
  verification?: JsonValue;
}
export interface CommitRelation { kind: "amend" | "cherry-pick"; original_sha: string; head_sha: string }
export interface FinalizedArtifact extends ArtifactPayload {
  id: string;
  attribution_evidence: GitAttributionEvidence[];
  commit_relations: CommitRelation[];
  file_attribution: { file: string; attribution: ReturnType<typeof classifyGitAttribution>; line_attribution?: { line: number; side: "old" | "new"; attribution: ReturnType<typeof classifyGitAttribution> }[] }[];
}

function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
interface GitCommand { cwd: string; args: string[]; input?: string; allowed?: number[] }
interface BlobCommand { directory: string; patchHash: string; patch: string }
interface FileCommand { file: string }
interface GitResult { status: number; stdout: Buffer }
type GitSteps<T> = Generator<GitCommand | BlobCommand | FileCommand, T, GitResult>;
function* runGit(cwd: string, ...args: string[]): GitSteps<string> {
  const result = yield { cwd, args };
  return result.stdout.toString("utf8");
}
function* checkAncestor(cwd: string, base: string, head: string): GitSteps<boolean> {
  return (yield { cwd, args: ["merge-base", "--is-ancestor", base, head], allowed: [0, 1] }).status === 0;
}
function* hasCommit(cwd: string, sha: string): GitSteps<boolean> {
  return (yield { cwd, args: ["cat-file", "-e", `${sha}^{commit}`], allowed: [0, 1, 128] }).status === 0;
}
function readFacts(ledger: Ledger): Fact[] {
  const facts: Fact[] = [];
  for (;;) {
    const batch = ledger.readSince(facts.at(-1)?.seq ?? 0, READ_BATCH_SIZE);
    facts.push(...batch);
    if (batch.length < READ_BATCH_SIZE) return facts;
  }
}
function* readBinaryChange(cwd: string, base: string, file: string, rules?: RedactionRules): GitSteps<string> {
  const original = yield { cwd, args: ["cat-file", "blob", `${base}:${file}`], allowed: [0, 128] };
  const current = yield { file: join(cwd, file) };
  function encodeContent(content: Buffer | null): string | null {
    if (content === null) return null;
    const encoding = Buffer.from(content.toString("utf8")).equals(content) ? "utf8" : "latin1";
    return Buffer.from(redact(content.toString(encoding), rules).text, encoding).toString("base64");
  }
  // Git の圧縮済み binary patch は秘匿を迂回するため、伏せた内容を別の差分レコードにする。
  return `agent-graph-binary ${JSON.stringify({ file, encoding: "base64",
    old: encodeContent(original.status === 0 ? original.stdout : null),
    new: encodeContent(current.status === 0 ? current.stdout : null) })}\n`;
}
function* readPatch(cwd: string, base: string, rules?: RedactionRules): GitSteps<{ patch: string; untracked: string[] }> {
  // index を書き換えず、追跡済みの最終状態と未追跡の新規ファイルを固定する。
  const args = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
  let patch = (yield* runGit(cwd, "diff", ...args, base, "--"));
  // -z で改行やタブを含むファイル名も保持する。
  const binaryEntries = (yield* runGit(cwd, "diff", "--numstat", "-z", "--no-renames", base, "--")).split("\0");
  for (const entry of binaryEntries) {
    if (entry.startsWith("-\t-\t")) patch += (yield* readBinaryChange(cwd, base, entry.slice(4), rules));
  }
  const untracked = (yield* runGit(cwd, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean).sort();
  for (const file of untracked) {
    const result = yield { cwd, args: ["diff", "--no-index", ...args, "--", "/dev/null", file], allowed: [0, 1] };
    patch += result.stdout.toString("utf8");
    if (result.stdout.toString("utf8").includes("Binary files ")) patch += (yield* readBinaryChange(cwd, base, file, rules));
  }
  return { patch, untracked };
}

interface ChangedLine { line: number; side: "old" | "new" }
function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  // Git の引用は JSON と異なり、UTF-8 の八進数表記も含む。
  const escapes: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\x0b", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  const bytes: Buffer[] = [];
  for (const match of path.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/g)) {
    const escape = match[1];
    bytes.push(escape === undefined ? Buffer.from(match[0])
      : /^[0-7]{3}$/.test(escape) ? Buffer.from([parseInt(escape, 8)]) : Buffer.from(escapes[escape] ?? escape));
  }
  return Buffer.concat(bytes).toString("utf8");
}
function collectChangedLines(patch: string): Map<string, ChangedLine[]> {
  const files = new Map<string, ChangedLine[]>();
  let file = "";
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const entry of patch.split("\n")) {
    if (entry.startsWith("diff --git ")) { file = ""; inHunk = false; }
    else if (!inHunk && (entry.startsWith("--- ") || entry.startsWith("+++ "))) {
      const path = entry.slice(4);
      if (path !== "/dev/null") {
        file = decodeGitPath(path).slice(2);
        if (!files.has(file)) files.set(file, []);
      }
    } else if (entry.startsWith("@@ ")) {
      const hunk = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(entry);
      inHunk = true;
      oldLine = Number(hunk?.[1] ?? 0); newLine = Number(hunk?.[2] ?? 0);
    } else if (entry.startsWith("+")) files.get(file)?.push({ line: newLine++, side: "new" });
    else if (entry.startsWith("-")) files.get(file)?.push({ line: oldLine++, side: "old" });
    else if (entry.startsWith(" ")) { oldLine++; newLine++; }
  }
  return files;
}
function mapBaseLine(line: number, committed: ChangedLine[]): number | undefined {
  if (committed.some((entry) => entry.side === "old" && entry.line === line)) return undefined;
  const removedBefore = committed.filter((entry) => entry.side === "old" && entry.line < line).length;
  let mapped = line - removedBefore;
  for (const entry of committed.filter((entry) => entry.side === "new").sort((a, b) => a.line - b.line)) {
    if (entry.line <= mapped) mapped++;
  }
  return mapped;
}
function* collectFileAttribution(cwd: string, base: string, head: string, untracked: string[], attribution: ReturnType<typeof classifyGitAttribution>): GitSteps<FinalizedArtifact["file_attribution"]> {
  const changed = (yield* runGit(cwd, "diff", "--name-only", "--no-renames", "-z", base, "--")).split("\0").filter(Boolean);
  const files = [...new Set([...changed, ...untracked])].sort();
  if (attribution !== "inferred") return files.map((file) => ({ file, attribution }));
  const args = ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"];
  const dirtyFiles = new Set((yield* runGit(cwd, "diff", "--name-only", "--no-renames", "-z", head, "--")).split("\0").filter(Boolean));
  const dirtyLines = collectChangedLines(yield* runGit(cwd, ...args, head, "--"));
  const committedLines = collectChangedLines(yield* runGit(cwd, ...args, base, head, "--"));
  const allLines = collectChangedLines(yield* runGit(cwd, ...args, base, "--"));
  return files.map((file) => {
    if (untracked.includes(file)) return { file, attribution: "unknown" as const };
    if (!dirtyFiles.has(file)) return { file, attribution };
    const dirty = dirtyLines.get(file) ?? [];
    const lines = (allLines.get(file) ?? []).map((entry) => {
      const line = entry.side === "new" ? entry.line : mapBaseLine(entry.line, committedLines.get(file) ?? []);
      const unknown = dirty.some((item) => item.side === entry.side && item.line === line);
      return { ...entry, attribution: unknown ? "unknown" as const : attribution };
    });
    const mixed = new Set(lines.map((item) => item.attribution)).size > 1;
    return { file, attribution: mixed ? "unknown" as const : lines[0]?.attribution ?? "unknown" as const,
      ...(mixed ? { line_attribution: lines } : {}) };
  });
}

const REFLOG_LIMIT = 128;
function* findCherryPickOrigin(cwd: string, head: string, commits: string[]): GitSteps<string | undefined> {
  const reflog = (yield* runGit(cwd, "reflog", "show", "--all", `--max-count=${REFLOG_LIMIT}`, "--format=%H%x00%gs"));
  if (!reflog.split("\n").some((line) => line.startsWith(`${head}\0cherry-pick:`))) return undefined;
  const range = new Set(commits);
  const candidates = [...new Set(reflog.split("\n").map((line) => line.split("\0")[0]).filter(Boolean))]
    .filter((sha) => sha === head || !range.has(sha)).slice(0, REFLOG_LIMIT);
  if (!candidates.includes(head)) candidates.unshift(head);
  const patches = yield* runGit(cwd, "show", "--no-merges", "--pretty=medium", "--no-ext-diff", "--no-textconv", ...candidates, "--");
  const output = yield { cwd, args: ["patch-id", "--stable"], input: patches };
  const entries = output.stdout.toString("utf8").trim().split("\n").map((line) => line.split(/\s+/));
  const patchId = entries.find(([, sha]) => sha === head)?.[0];
  const originals = entries.filter(([id, sha]) => patchId && id === patchId && sha !== head).map(([, sha]) => sha);
  return originals.length === 1 ? originals[0] : undefined;
}

function saveBlob(directory: string, patchHash: string, patch: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const blob = join(directory, patchHash);
  if (existsSync(blob) && statSync(blob).isFile() && readFileSync(blob, "utf8") === patch) return;
  // 完成した内容だけを公開し、以前の不完全な blob も置き換える。
  const temporary = join(directory, `.${patchHash}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, patch);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(temporary, blob);
  } finally { rmSync(temporary, { force: true }); }
}

async function saveBlobAsync(directory: string, patchHash: string, patch: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const blob = join(directory, patchHash);
  if (existsSync(blob) && (await fs.stat(blob)).isFile() && await fs.readFile(blob, "utf8") === patch) return;
  const temporary = join(directory, `.${patchHash}.${randomUUID()}.tmp`);
  try {
    const descriptor = await fs.open(temporary, "wx", 0o600);
    try {
      await descriptor.writeFile(patch);
      await descriptor.sync();
    } finally { await descriptor.close(); }
    await fs.rename(temporary, blob);
  } finally { await fs.rm(temporary, { force: true }); }
}

// 呼び出し元は成功結果の SHA を渡す。コマンド本文や時刻からは生成しない。
export function recordCommitResult(ledger: Ledger, request: ArtifactRequest, result: CommitResult): void {
  const appended = ledger.append({ source: `host-${request.provider}`, source_event_id: request.sourceEventId,
    source_ts: request.sourceTs, kind: "run.updated", subject: `run:${request.runId}`, confidence: "confirmed",
    payload: { git_commit_result: result } } as Parameters<Ledger["append"]>[0]);
  if (appended.status === "conflict") throw new Error("Conflicting commit result");
}

function* captureArtifacts(ledger: Ledger, request: ArtifactRequest, options: ArtifactOptions = {}): GitSteps<FinalizedArtifact | undefined> {
  const rules = ledger.getRedactionRules();
  const facts = readFacts(ledger);
  const runs = projectEntityRecords<RunPayload & WorktreeRecord>(facts, "run");
  const run = runs.find((item) => item.id === request.runId);
  if (!run?.cwd || !run.base_sha || !run.repository_id || !run.worktree_id) return undefined;
  const delegations = projectDelegations(facts);
  const delegation = delegations.find((item) => item.attempts?.some((attempt) => attempt.run_id === run.id));
  const conversations = projectEntityRecords<{ origin: string; task_id?: string }>(facts, "conversation");
  const taskId = conversations.find((item) => item.id === run.conversation_id)?.task_id;
  const taskConversations = new Set(conversations.filter((item) => taskId && item.task_id === taskId).map((item) => item.id));
  taskConversations.add(run.conversation_id!);
  const taskRuns = new Set(runs.filter((item) => taskConversations.has(item.conversation_id!)).map((item) => item.id));
  for (const attempt of delegation?.attempts ?? []) if (attempt.run_id) taskRuns.add(attempt.run_id);
  const previous = projectArtifacts(facts).filter((item) => taskRuns.has(item.run_id))
    .sort((left, right) => left.version - right.version).at(-1) as FinalizedArtifact | undefined;
  // 再開時の HEAD ではなく、作業の最初の基準で差分を比較する。
  const base = previous?.repository_id === run.repository_id ? previous.base_sha : run.base_sha;
  const head = (yield* runGit(run.cwd, "rev-parse", "HEAD")).trim();
  const commits = (yield* runGit(run.cwd, "rev-list", "--reverse", `${base}..${head}`, "--")).trim().split("\n").filter(Boolean);
  const snapshot = (yield* readPatch(run.cwd, base, rules));
  if ((yield* runGit(run.cwd, "rev-parse", "HEAD")).trim() !== head) throw new Error("HEAD changed during artifact capture");
  const patch = redact(snapshot.patch, rules).text;
  const patchHash = hashText(patch);
  const resultFacts = facts.filter((fact) => fact.kind === "run.updated" && fact.confidence === "confirmed"
    && (fact.source === "host-claude" || fact.source === "host-codex"));
  const isExternal = (conversationId: string | undefined) => conversations.some((item) => item.id === conversationId && item.origin === "observed");
  const jointRunIds = run.isolation === "worktree"
    ? runs.filter((item) => item.worktree_id === run.worktree_id && item.repository_id === run.repository_id).map((item) => item.id)
    : run.joint_run_ids ?? [];
  const evidence: GitAttributionEvidence[] = [{ run_id: run.id, repository_id: run.repository_id,
    worktree_id: run.worktree_id, base_sha: base, head_sha: head,
    dedicated_worktree: run.isolation === "worktree" && (yield* checkAncestor(run.cwd, base, head)),
    range_commits: commits, uncommitted_changes: head === run.base_sha || snapshot.patch.length > 0, concurrent_run_ids: jointRunIds, external: isExternal(run.conversation_id) }];
  const relations: CommitRelation[] = previous?.head_sha === head ? [...(previous.commit_relations ?? [])] : [];
  for (const fact of resultFacts) {
    const owner = runs.find((item) => fact.subject === `run:${item.id}`);
    const result = (fact.payload as { git_commit_result?: CommitResult } | null)?.git_commit_result;
    if (!owner || !result || owner.repository_id !== run.repository_id || owner.worktree_id !== run.worktree_id) continue;
    evidence.push({ run_id: owner.id, repository_id: run.repository_id, worktree_id: run.worktree_id,
      base_sha: owner.id === run.id ? base : owner.base_sha!, head_sha: head, dedicated_worktree: owner.isolation === "worktree", commit_result: result,
      external: isExternal(owner.conversation_id) });
    if (owner.id === run.id && result.success && !result.help && result.head_sha === head && result.operation && result.original_sha) {
      if (!relations.some((relation) => relation.kind === result.operation && relation.original_sha === result.original_sha)) {
        relations.push({ kind: result.operation, original_sha: result.original_sha, head_sha: head });
      }
    }
  }
  if (previous?.head_sha !== head && !relations.some((relation) => relation.kind === "cherry-pick")) {
    const original = (yield* findCherryPickOrigin(run.cwd, head, commits));
    if (original) relations.push({ kind: "cherry-pick", original_sha: original, head_sha: head });
  }
  if (previous && previous.head_sha !== head && (yield* hasCommit(run.cwd, previous.head_sha)) && !(yield* checkAncestor(run.cwd, previous.head_sha, head))
    && (yield* runGit(run.cwd, "reflog", "show", `--max-count=${REFLOG_LIMIT}`, "--format=%H%x00%gs", "HEAD")).split("\n")
      .some((line) => line.startsWith(`${head}\0commit (amend):`))
    && (yield* runGit(run.cwd, "show", "-s", "--format=%P", previous.head_sha)) === (yield* runGit(run.cwd, "show", "-s", "--format=%P", head))
    && !relations.some((relation) => relation.original_sha === previous.head_sha)) {
    relations.push({ kind: "amend", original_sha: previous.head_sha, head_sha: head });
  }
  const attribution = classifyGitAttribution({ run_id: run.id, repository_id: run.repository_id,
    worktree_id: run.worktree_id, base_sha: base, head_sha: head }, evidence);
  const untracked = redactValue(snapshot.untracked, rules) as string[];
  const fileAttribution = redactValue(yield* collectFileAttribution(run.cwd, base, head, snapshot.untracked, attribution), rules) as FinalizedArtifact["file_attribution"];
  if (previous?.patch_hash === patchHash) {
    if (previous.run_id !== run.id) {
      const sharedDedicatedTree = run.isolation === "worktree" && previous.worktree_id === run.worktree_id
        && previous.repository_id === run.repository_id && jointRunIds.length > 1;
      const originalExternal = isExternal(runs.find((item) => item.id === previous.run_id)?.conversation_id);
      const originalAttribution = originalExternal ? "unknown" as const : "joint" as const;
      const ownership = sharedDedicatedTree && previous.attribution !== originalAttribution ? {
        attribution_evidence: [...(previous.attribution_evidence ?? []), {
          run_id: previous.run_id, repository_id: previous.repository_id, worktree_id: previous.worktree_id,
          base_sha: previous.base_sha, head_sha: previous.head_sha, concurrent_run_ids: jointRunIds,
          external: originalExternal,
        }],
        attribution: originalAttribution,
        file_attribution: (previous.file_attribution ?? fileAttribution).map(({ file }) => ({ file, attribution: originalAttribution })),
      } : {};
      const update = { ...ownership, ...(request.verification === undefined ? {} : { verification: request.verification }) };
      if (Object.keys(update).length > 0) ledger.append({ source: `host-${request.provider}`, source_event_id: request.sourceEventId,
        source_ts: request.sourceTs, kind: "artifact.updated", subject: `artifact:${previous.id}`, confidence: "confirmed",
        payload: update });
      return { ...previous, ...update };
    }
    if (previous.run_id === run.id && (previous.attribution !== attribution || previous.head_sha !== head || request.verification !== undefined)) {
      ledger.append({ source: `host-${request.provider}`, source_event_id: request.sourceEventId,
        source_ts: request.sourceTs, kind: "artifact.updated", subject: `artifact:${previous.id}`, confidence: "confirmed",
        payload: { attribution, attribution_evidence: evidence, file_attribution: fileAttribution, head_sha: head, commits, commit_relations: relations, ...(request.verification === undefined ? {} : { verification: request.verification }) } } as Parameters<Ledger["append"]>[0]);
    }
    return { ...previous, attribution, attribution_evidence: evidence, head_sha: head, commits, commit_relations: relations, file_attribution: fileAttribution, ...(request.verification === undefined ? {} : { verification: request.verification }) };
  }
  const version = (previous?.version ?? 0) + 1;
  const id = hashText(JSON.stringify([run.id, version]));
  const artifact: FinalizedArtifact = { id, run_id: run.id, version, repository_id: run.repository_id,
    worktree_id: run.worktree_id, base_sha: base, head_sha: head, commits, patch_hash: patchHash,
    untracked, attribution, file_attribution: fileAttribution, attribution_evidence: evidence, commit_relations: relations, diff: patch,
    ...(previous ? { previous_artifact_id: previous.id } : {}),
    ...(request.verification === undefined ? {} : { verification: request.verification }) };
  const directory = options.blobDirectory ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-graph", "blobs");
  yield { directory, patchHash, patch };
  const appended = ledger.append({ source: `host-${request.provider}`, source_event_id: `artifact:${run.id}:${version}`,
    source_ts: request.sourceTs, kind: "artifact.version_created", subject: `artifact:${id}`, confidence: "confirmed", payload: artifact });
  if (appended.status === "conflict") throw new Error("Conflicting artifact version");
  return artifact;
}

function validateGitResult(command: GitCommand, result: GitResult): GitResult {
  if (!(command.allowed ?? [0]).includes(result.status)) throw new Error(`Git ${command.args[0]} failed with code ${result.status}`);
  return result;
}
export function finalizeArtifacts(ledger: Ledger, request: ArtifactRequest, options: ArtifactOptions = {}): FinalizedArtifact | undefined {
  const steps = captureArtifacts(ledger, request, options);
  let step = steps.next();
  while (!step.done) {
    const command = step.value;
    if ("directory" in command) {
      saveBlob(command.directory, command.patchHash, command.patch);
      step = steps.next({ status: 0, stdout: Buffer.alloc(0) });
      continue;
    }
    if ("file" in command) {
      step = steps.next({ status: existsSync(command.file) ? 0 : 1,
        stdout: existsSync(command.file) ? readFileSync(command.file) : Buffer.alloc(0) });
      continue;
    }
    const result = spawnSync("git", command.args, { cwd: command.cwd, input: command.input, maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (result.error) throw result.error;
    step = steps.next(validateGitResult(command, { status: result.status ?? -1, stdout: result.stdout }));
  }
  return step.value;
}
async function captureAsync(ledger: Ledger, request: ArtifactRequest, options: ArtifactOptions = {}): Promise<FinalizedArtifact | undefined> {
  const steps = captureArtifacts(ledger, request, options);
  let step = steps.next();
  while (!step.done) {
    const command = step.value;
    if ("directory" in command) {
      await saveBlobAsync(command.directory, command.patchHash, command.patch);
      step = steps.next({ status: 0, stdout: Buffer.alloc(0) });
      continue;
    }
    if ("file" in command) {
      let result: GitResult;
      try { result = { status: 0, stdout: await fs.readFile(command.file) }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        result = { status: 1, stdout: Buffer.alloc(0) };
      }
      step = steps.next(result);
      continue;
    }
    const result = await new Promise<GitResult>((resolve, reject) => {
      const child = spawn("git", command.args, { cwd: command.cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > GIT_MAX_BUFFER) { child.kill(); reject(new Error("Git output exceeds limit")); } else chunks.push(chunk); });
      child.stderr.resume();
      child.on("error", reject);
      child.on("close", (status) => resolve({ status: status ?? -1, stdout: Buffer.concat(chunks) }));
      child.stdin.on("error", reject);
      child.stdin.end(command.input);
    });
    step = steps.next(validateGitResult(command, result));
  }
  return step.value;
}

const captureQueues = new WeakMap<Ledger, Promise<unknown>>();
export function finalizeArtifactsAsync(ledger: Ledger, request: ArtifactRequest, options: ArtifactOptions = {}): Promise<FinalizedArtifact | undefined> {
  const previous = captureQueues.get(ledger) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => captureAsync(ledger, request, options));
  captureQueues.set(ledger, task);
  void task.finally(() => { if (captureQueues.get(ledger) === task) captureQueues.delete(ledger); }).catch(() => {});
  return task;
}
