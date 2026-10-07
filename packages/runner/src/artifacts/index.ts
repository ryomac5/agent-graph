import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ArtifactPayload, Fact, JsonValue, Provider, RunPayload } from "../../../core/src/ledger/facts.ts";
import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import { redact, redactValue, type RedactionRules } from "../../../core/src/ledger/redact.ts";
import { classifyGitAttribution, projectArtifacts, type GitAttributionEvidence } from "../../../core/src/ledger/projections/artifacts.ts";
import { projectEntityRecords } from "../../../core/src/ledger/projections/delegations.ts";
import type { WorktreeRecord } from "../worktree.ts";

const READ_BATCH_SIZE = 1000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
export interface ArtifactOptions {
  blobDirectory?: string;
  redactionRules?: RedactionRules;
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
  artifactId?: string;
}
export interface CommitRelation { kind: "amend" | "cherry-pick"; original_sha: string; head_sha: string }
export interface FinalizedArtifact extends ArtifactPayload {
  id: string;
  attribution_evidence: GitAttributionEvidence[];
  commit_relations: CommitRelation[];
}

function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}
function checkAncestor(cwd: string, base: string, head: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error("Cannot inspect commit ancestry");
  return result.status === 0;
}
function hasCommit(cwd: string, sha: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
  if (result.error) throw result.error;
  return result.status === 0;
}
function readFacts(ledger: Ledger): Fact[] {
  const facts: Fact[] = [];
  for (;;) {
    const batch = ledger.readSince(facts.at(-1)?.seq ?? 0, READ_BATCH_SIZE);
    facts.push(...batch);
    if (batch.length < READ_BATCH_SIZE) return facts;
  }
}
function readBinaryChange(cwd: string, base: string, file: string, rules?: RedactionRules): string {
  const original = spawnSync("git", ["cat-file", "blob", `${base}:${file}`], { cwd, maxBuffer: GIT_MAX_BUFFER });
  if (original.error) throw original.error;
  if (original.status !== 0 && original.status !== 128) throw new Error("Cannot read original binary content");
  function encodeContent(content: Buffer | null): string | null {
    if (content === null) return null;
    const encoding = Buffer.from(content.toString("utf8")).equals(content) ? "utf8" : "latin1";
    return Buffer.from(redact(content.toString(encoding), rules).text, encoding).toString("base64");
  }
  // Git の圧縮済み binary patch は秘匿を迂回するため、伏せた内容を別の差分レコードにする。
  return `agent-graph-binary ${JSON.stringify({ file, encoding: "base64",
    old: encodeContent(original.status === 0 ? original.stdout : null),
    new: encodeContent(existsSync(join(cwd, file)) ? readFileSync(join(cwd, file)) : null) })}\n`;
}
function readPatch(cwd: string, base: string, rules?: RedactionRules): { patch: string; untracked: string[] } {
  // index を書き換えず、追跡済みの最終状態と未追跡の新規ファイルを固定する。
  const args = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"];
  let patch = runGit(cwd, "diff", ...args, base, "--");
  // -z で改行やタブを含むファイル名も保持する。
  const binaryEntries = runGit(cwd, "diff", "--numstat", "-z", "--no-renames", base, "--").split("\0");
  for (const entry of binaryEntries) {
    if (entry.startsWith("-\t-\t")) patch += readBinaryChange(cwd, base, entry.slice(4), rules);
  }
  const untracked = runGit(cwd, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).sort();
  for (const file of untracked) {
    const result = spawnSync("git", ["diff", "--no-index", ...args, "--", "/dev/null", file],
      { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1) throw new Error("Cannot snapshot untracked file");
    patch += result.stdout;
    if (result.stdout.includes("Binary files ")) patch += readBinaryChange(cwd, base, file, rules);
  }
  return { patch, untracked };
}

function findCherryPickOrigin(cwd: string, head: string, commits: string[]): string | undefined {
  const entry = runGit(cwd, "reflog", "show", "--format=%H%x00%gs", "HEAD").split("\n")
    .find((line) => line.startsWith(`${head}\0cherry-pick:`));
  if (!entry) return undefined;
  const patches = runGit(cwd, "log", "--all", head, "-p", "--no-merges", "--pretty=medium", "--no-ext-diff", "--no-textconv", "--");
  const entries = execFileSync("git", ["patch-id", "--stable"],
    { cwd, input: patches, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER }).trim().split("\n")
    .map((line) => line.split(/\s+/));
  const patchId = entries.find(([, sha]) => sha === head)?.[0];
  if (!patchId) return undefined;
  const range = new Set(commits);
  const originals = [...new Set(entries.filter(([id, sha]) => id === patchId && !range.has(sha)).map(([, sha]) => sha))];
  // 同じ差分の候補が複数ある場合は、元の SHA を断定しない。
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

// 呼び出し元は成功結果の SHA を渡す。コマンド本文や時刻からは生成しない。
export function recordCommitResult(ledger: Ledger, request: ArtifactRequest, result: CommitResult): void {
  const appended = ledger.append({ source: `host-${request.provider}`, source_event_id: request.sourceEventId,
    source_ts: request.sourceTs, kind: "run.updated", subject: `run:${request.runId}`, confidence: "confirmed",
    payload: { git_commit_result: result } } as Parameters<Ledger["append"]>[0]);
  if (appended.status === "conflict") throw new Error("Conflicting commit result");
}

export function finalizeArtifacts(ledger: Ledger, request: ArtifactRequest, options: ArtifactOptions = {}): FinalizedArtifact | undefined {
  const facts = readFacts(ledger);
  const runs = projectEntityRecords<RunPayload & WorktreeRecord>(facts, "run");
  const run = runs.find((item) => item.id === request.runId);
  if (!run?.cwd || !run.base_sha || !run.repository_id || !run.worktree_id) return undefined;
  const head = runGit(run.cwd, "rev-parse", "HEAD").trim();
  const commits = runGit(run.cwd, "rev-list", "--reverse", `${run.base_sha}..${head}`, "--").trim().split("\n").filter(Boolean);
  const snapshot = readPatch(run.cwd, run.base_sha, options.redactionRules);
  if (runGit(run.cwd, "rev-parse", "HEAD").trim() !== head) throw new Error("HEAD changed during artifact capture");
  const patch = redact(snapshot.patch, options.redactionRules).text;
  const patchHash = hashText(patch);
  const previous = projectArtifacts(facts).filter((item) => item.run_id === request.runId).at(-1) as FinalizedArtifact | undefined;
  const resultFacts = facts.filter((fact) => fact.kind === "run.updated" && fact.confidence === "confirmed"
    && (fact.source === "host-claude" || fact.source === "host-codex"));
  const conversations = projectEntityRecords<{ origin: string }>(facts, "conversation");
  const isExternal = (conversationId: string | undefined) => conversations.some((item) => item.id === conversationId && item.origin === "observed");
  const evidence: GitAttributionEvidence[] = [{ run_id: run.id, repository_id: run.repository_id,
    worktree_id: run.worktree_id, base_sha: run.base_sha, head_sha: head,
    dedicated_worktree: run.isolation === "worktree" && checkAncestor(run.cwd, run.base_sha, head),
    range_commits: commits, concurrent_run_ids: run.joint_run_ids ?? [], external: isExternal(run.conversation_id) }];
  const relations: CommitRelation[] = previous?.head_sha === head ? [...(previous.commit_relations ?? [])] : [];
  for (const fact of resultFacts) {
    const owner = runs.find((item) => fact.subject === `run:${item.id}`);
    const result = (fact.payload as { git_commit_result?: CommitResult } | null)?.git_commit_result;
    if (!owner || !result || owner.repository_id !== run.repository_id || owner.worktree_id !== run.worktree_id) continue;
    evidence.push({ run_id: owner.id, repository_id: run.repository_id, worktree_id: run.worktree_id,
      base_sha: owner.base_sha!, head_sha: head, dedicated_worktree: owner.isolation === "worktree", commit_result: result,
      external: isExternal(owner.conversation_id) });
    if (owner.id === run.id && result.success && !result.help && result.head_sha === head && result.operation && result.original_sha) {
      if (!relations.some((relation) => relation.kind === result.operation && relation.original_sha === result.original_sha)) {
        relations.push({ kind: result.operation, original_sha: result.original_sha, head_sha: head });
      }
    }
  }
  if (previous?.head_sha !== head && !relations.some((relation) => relation.kind === "cherry-pick")) {
    const original = findCherryPickOrigin(run.cwd, head, commits);
    if (original) relations.push({ kind: "cherry-pick", original_sha: original, head_sha: head });
  }
  if (previous && previous.head_sha !== head && hasCommit(run.cwd, previous.head_sha) && !checkAncestor(run.cwd, previous.head_sha, head)
    && runGit(run.cwd, "reflog", "show", "--format=%H%x00%gs", "HEAD").split("\n")
      .some((line) => line.startsWith(`${head}\0commit (amend):`))
    && runGit(run.cwd, "show", "-s", "--format=%P", previous.head_sha) === runGit(run.cwd, "show", "-s", "--format=%P", head)
    && !relations.some((relation) => relation.original_sha === previous.head_sha)) {
    relations.push({ kind: "amend", original_sha: previous.head_sha, head_sha: head });
  }
  const attribution = classifyGitAttribution({ run_id: run.id, repository_id: run.repository_id,
    worktree_id: run.worktree_id, base_sha: run.base_sha, head_sha: head }, evidence);
  const untracked = redactValue(snapshot.untracked, options.redactionRules) as string[];
  if (previous && previous.head_sha === head && previous.patch_hash === patchHash
    && JSON.stringify(previous.untracked) === JSON.stringify(untracked) && previous.attribution === attribution
    && JSON.stringify(previous.verification) === JSON.stringify(request.verification ?? previous.verification)) return previous;
  const version = (previous?.version ?? 0) + 1;
  const id = request.artifactId ?? hashText(JSON.stringify([run.id, version]));
  const artifact: FinalizedArtifact = { id, run_id: run.id, version, repository_id: run.repository_id,
    worktree_id: run.worktree_id, base_sha: run.base_sha, head_sha: head, commits, patch_hash: patchHash,
    untracked, attribution, attribution_evidence: evidence, commit_relations: relations, diff: patch,
    ...(previous ? { previous_artifact_id: previous.id } : {}),
    ...((request.verification ?? previous?.verification) === undefined ? {} : { verification: request.verification ?? previous?.verification }) };
  const directory = options.blobDirectory ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-graph", "blobs");
  saveBlob(directory, patchHash, patch);
  const appended = ledger.append({ source: `host-${request.provider}`, source_event_id: `artifact:${run.id}:${version}`,
    source_ts: request.sourceTs, kind: "artifact.version_created", subject: `artifact:${id}`, confidence: "confirmed", payload: artifact });
  if (appended.status === "conflict") throw new Error("Conflicting artifact version");
  return artifact;
}
