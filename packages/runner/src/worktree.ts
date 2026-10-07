import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Fact, FactInput, RunPayload, Provider } from "../../core/src/ledger/facts.ts";
import type { Ledger } from "../../core/src/ledger/ledger.ts";
import { projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { prepareIntegration, createTaskWorktree } from "../../planner/src/worktree.ts";

const READ_BATCH_SIZE = 1000;
export interface WorktreeRecord {
  cwd: string;
  repository_id: string;
  worktree_id: string;
  // HEAD が指す枝の名前。HEAD が枝から外れているときは持たない。
  branch?: string;
  base_sha: string;
  dirty_state: string;
  isolation: "worktree" | "shared";
  attribution: "confirmed" | "joint";
  joint_run_ids: string[];
}
export interface WorktreeRequest {
  runId: string;
  generation: number;
  provider: Provider;
  cwd: string;
  isolation: WorktreeRecord["isolation"];
  sourceEventId: string;
  sourceTs: string;
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}
function hashText(text: string): string { return createHash("sha256").update(text).digest("hex"); }

export function inspectWorktree(cwd: string): Omit<WorktreeRecord, "isolation" | "attribution" | "joint_run_ids"> {
  const root = realpathSync(runGit(cwd, "rev-parse", "--show-toplevel").trim());
  const common = realpathSync(runGit(root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
  // HEAD の参照名を使うため、同じ枝でコミットしても作業ツリーの識別子は変わらない。
  const headRef = runGit(root, "rev-parse", "--symbolic-full-name", "HEAD").trim();
  const status = runGit(root, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  return {
    cwd: root, repository_id: hashText(common), worktree_id: hashText(JSON.stringify([root, headRef])),
    ...(headRef.startsWith("refs/heads/") ? { branch: headRef.slice("refs/heads/".length) } : {}),
    base_sha: runGit(root, "rev-parse", "HEAD").trim(), dirty_state: hashText(status),
  };
}

export function recordWorktree(ledger: Ledger, request: WorktreeRequest): WorktreeRecord {
  const facts: Fact[] = [];
  for (;;) {
    const batch = ledger.readSince(facts.at(-1)?.seq ?? 0, READ_BATCH_SIZE);
    facts.push(...batch);
    if (batch.length < READ_BATCH_SIZE) break;
  }
  const records = projectEntityRecords<RunPayload & WorktreeRecord>(facts, "run");
  const existing = records.find((run) => run.id === request.runId && run.generation === request.generation);
  if (!existing) throw new Error("Run must be created before recording its worktree");
  if (existing.dirty_state !== undefined) {
    const record = existing as RunPayload & WorktreeRecord;
    return { cwd: record.cwd, repository_id: record.repository_id, worktree_id: record.worktree_id,
      ...(record.branch === undefined ? {} : { branch: record.branch }), base_sha: record.base_sha, dirty_state: record.dirty_state, isolation: record.isolation,
      attribution: record.attribution, joint_run_ids: record.joint_run_ids };
  }
  let cwd = request.cwd;
  if (request.isolation === "worktree") {
    const base = runGit(cwd, "rev-parse", "HEAD").trim();
    const session = `run-${hashText(JSON.stringify([request.runId, request.generation]))}`;
    prepareIntegration(cwd, session, base);
    cwd = createTaskWorktree(cwd, session, "execution");
  }
  const snapshot = inspectWorktree(cwd);
  const live = projectRuns(facts);
  const peers = request.isolation === "shared" ? records.filter((run) => run.id !== request.runId
    && run.worktree_id === snapshot.worktree_id
    && live.some((state) => state.conversation_id === run.conversation_id && state.generation === run.generation
      && state.state !== "ended" && state.state !== "failed")) : [];
  const jointIds = [request.runId, ...peers.map((run) => run.id)].sort();
  const record: WorktreeRecord = { ...snapshot, isolation: request.isolation,
    attribution: peers.length ? "joint" : "confirmed", joint_run_ids: peers.length ? jointIds : [] };
  function appendRecord(runId: string, generation: number, payload: Partial<WorktreeRecord>): void {
    const fact: FactInput = { source: `host-${request.provider}`, source_event_id: `${request.sourceEventId}:${runId}:${generation}`,
      source_ts: request.sourceTs, kind: "run.updated", subject: `run:${runId}`, confidence: "confirmed",
      payload: { ...payload, generation } };
    if (ledger.append(fact).status === "conflict") throw new Error("Conflicting worktree record");
  }
  appendRecord(request.runId, request.generation, record);
  for (const peer of peers) appendRecord(peer.id, peer.generation!, {
    attribution: "joint", joint_run_ids: [...new Set([...jointIds, ...(peer.joint_run_ids ?? [])])].sort(),
  });
  return record;
}
