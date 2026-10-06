import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactPayload, Fact, FactInput, FindingPayload } from "../../src/ledger/facts.ts";
import { classifyGitAttribution, projectArtifacts } from "../../src/ledger/projections/artifacts.ts";
import type { GitAttributionEvidence } from "../../src/ledger/projections/artifacts.ts";
import { projectApprovals } from "../../src/ledger/projections/approvals.ts";
import { projectFindings, remapFinding } from "../../src/ledger/projections/findings.ts";

function createFact(input: FactInput): Fact {
  return { ...input, seq: 1, fact_id: input.source_event_id, payload_hash: "hash", observed_ts: "2030-01-01T00:00:00Z",
    schema_version: 1, cursor: null, supersedes: input.supersedes ?? null } as Fact;
}
const ARTIFACT: ArtifactPayload = { run_id: "r1", version: 1, repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "head", patch_hash: "patch", untracked: ["new.ts"], verification: { passed: true } };
function createArtifact(version = 1, patchHash = "patch", extra = {}): Fact {
  return createFact({ source: "host-codex", source_event_id: `artifact${version}`, kind: "artifact.version_created", subject: `artifact:a${version}`,
    source_ts: `2026-01-0${version}T00:00:00Z`, confidence: "confirmed", payload: { ...ARTIFACT, version, patch_hash: patchHash, ...extra } });
}
function createApproval(): Fact {
  return createFact({ source: "host-codex", source_event_id: "approval", kind: "approval.created", subject: "approval:ap1",
    source_ts: "2026-01-01T01:00:00Z", confidence: "confirmed", payload: { run_id: "r1", request_id: "req", state: "pending", artifact_id: "a1", patch_hash: "patch", available_decisions: ["accept", "deny"] } });
}
const FINDING: FindingPayload = { artifact_id: "a1", version: 1, file: "main.ts", start_line: 2, end_line: 3, side: "new", context_hash: "context", body: "Fix this", severity: "high", state: "sent" };

test("承認は patch_hash の変化で stale になり、同じなら回答を保つ", () => {
  const answer = createFact({ source: "ui", source_event_id: "answer", kind: "approval.answered", subject: "approval:ap1",
    source_ts: "2026-01-01T02:00:00Z", confidence: "confirmed", payload: { decision: "accept" } });
  const resolved = createFact({ source: "host-codex", source_event_id: "resolved", kind: "approval.resolved", subject: "approval:ap1",
    source_ts: "2026-01-01T03:00:00Z", confidence: "confirmed", payload: { state: "approved" } });
  const facts = [createArtifact(), createApproval(), answer, resolved];
  assert.equal(projectApprovals([...facts, createArtifact(2)])[0].state, "approved");
  assert.equal(projectApprovals([...facts, createArtifact(2, "changed")])[0].state, "stale");
  assert.equal(projectApprovals([...facts, createArtifact(2, "patch", { run_id: "retry", previous_artifact_id: "a1" })])[0].decision, "accept");
  const changed = [...facts, createArtifact(2, "changed", { run_id: "retry", previous_artifact_id: "a1" })];
  assert.equal(projectApprovals(changed)[0].state, "stale");
  assert.deepEqual(projectApprovals(changed.reverse()), projectApprovals(changed));
});

test("やり直し先の前版指定がない後続版も追い、ハッシュが変われば承認を stale にする", () => {
  const approval = createApproval();
  const resolved = createFact({ source: "host-codex", source_event_id: "resolved", kind: "approval.resolved", subject: "approval:ap1",
    source_ts: "2026-01-01T03:00:00Z", confidence: "confirmed", payload: { state: "approved" } });
  const retry = createFact({ source: "host-codex", source_event_id: "retry-first", kind: "artifact.version_created", subject: "artifact:b1",
    source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed",
    payload: { ...ARTIFACT, run_id: "r2", version: 1, previous_artifact_id: "a1" } });
  const facts = [createArtifact(), approval, resolved, retry];
  assert.equal(projectApprovals(facts)[0].state, "approved");
  for (const patchHash of ["patch", "changed"]) {
    const next = createFact({ source: "host-codex", source_event_id: "retry-second", kind: "artifact.version_created", subject: "artifact:b2",
      source_ts: "2026-01-03T00:00:00Z", confidence: "confirmed",
      payload: { ...ARTIFACT, run_id: "r2", version: 2, patch_hash: patchHash } });
    const input = [...facts, next];
    const expected = projectApprovals(input);
    assert.equal(expected[0].state, patchHash === "patch" ? "approved" : "stale");
    for (let offset = 0; offset < input.length; offset += 1) {
      assert.deepEqual(projectApprovals([...input.slice(offset), ...input.slice(0, offset)].reverse()), expected);
    }
  }
});

test("再起動と中断は未解決の承認を expired にし、経過時間や api 切断では失効しない", () => {
  const facts = [createApproval()];
  assert.equal(projectApprovals(facts)[0].state, "pending");
  for (const cause of ["restart", "interrupted"]) {
    const event = createFact({ source: "host-codex", source_event_id: cause, kind: "run.state_changed", subject: "run:r1",
      source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed", payload: { state: "unknown", cause } });
    assert.equal(projectApprovals([...facts, event])[0].state, "expired");
    assert.deepEqual(projectApprovals([event, ...facts]), projectApprovals([...facts, event]));
  }
  const interrupt = createFact({ source: "ui", source_event_id: "interrupt", kind: "run.interrupt_requested", subject: "run:r1",
    source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed", payload: { turn_id: "turn" } });
  assert.equal(projectApprovals([...facts, interrupt])[0].state, "expired");
  const disconnect = createFact({ source: "hook", source_event_id: "disconnect", kind: "connection.state_changed", subject: "connection:ws",
    source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed", payload: { state: "disconnected" } });
  assert.equal(projectApprovals([...facts, disconnect])[0].state, "pending");
});

test("文脈のハッシュで行を写し、一致なしや複数一致は needs_check にする", () => {
  const target = { artifact_id: "a2", version: 2 };
  const context = { file: "main.ts", side: "new" as const, context_hash: "context", start_line: 12, end_line: 13 };
  assert.deepEqual(remapFinding(FINDING, target, [context]), { ...FINDING, ...target, start_line: 12, end_line: 13 });
  assert.equal(remapFinding(FINDING, target, []).state, "needs_check");
  assert.equal(remapFinding(FINDING, target, [context, { ...context, start_line: 20 }]).state, "needs_check");
  assert.equal(remapFinding(FINDING, target, [{ ...context, file: "other.ts" }]).state, "needs_check");
  assert.equal(FINDING.version, 1);
});

test("指摘の状態と訂正は順序に依存せず全状態を保持する", () => {
  const creation = createFact({ source: "ui", source_event_id: "finding", kind: "finding.created", subject: "finding:f1",
    source_ts: "2026-01-01T00:00:00Z", confidence: "confirmed", payload: FINDING });
  for (const state of ["open", "sent", "fixed", "verified", "dismissed", "needs_check"] as const) {
    const change = createFact({ source: "ui", source_event_id: state, kind: "finding.state_changed", subject: "finding:f1",
      source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed", payload: { state } });
    assert.equal(projectFindings([change, creation])[0].state, state);
    assert.deepEqual(projectFindings([change, creation]), projectFindings([creation, change]));
  }
});

test("Git の帰属は確定と推定と共同と不明を区別する", () => {
  const evidence: GitAttributionEvidence = { run_id: "r1", repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "head" };
  assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, dedicated_worktree: true, range_commits: ["head"] }]), "confirmed");
  assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, commit_result: { success: true, head_sha: "head" } }]), "confirmed");
  assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, shared_command: { success: true, matched_run_id: "r1", head_sha: "head" } }]), "inferred");
  assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, concurrent_run_ids: ["r1", "r2"] }]), "joint");
  assert.equal(classifyGitAttribution(ARTIFACT, []), "unknown");
  assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, commit_result: { success: true, head_sha: "different" } }]), "unknown");
  assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, worktree_id: "other", dedicated_worktree: true, range_commits: ["head"] }]), "unknown");
});

test("失敗した commit とヘルプの表示とコマンド文字列は帰属の根拠にならない", () => {
  const evidence: GitAttributionEvidence = { run_id: "r1", repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "head" };
  for (const result of [{ success: false, head_sha: "head" }, { success: true, head_sha: "head", help: true }]) {
    assert.equal(classifyGitAttribution(ARTIFACT, [{ ...evidence, commit_result: result, shared_command: { ...result, matched_run_id: "r1" } }]), "unknown");
  }
  const command = createFact({ source: "hook", source_event_id: "command", kind: "message.created", subject: "message:cmd",
    source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed",
    payload: { provider: "codex", native_id: "cmd", version: 1, role: "tool", body: "git commit --help", body_state: "stored" } });
  const projected = projectArtifacts([createArtifact(), command]);
  assert.equal(projected[0].attribution, "unknown");
  assert.deepEqual(projected[0].verification, { passed: true });
  assert.deepEqual(projected[0].untracked, ["new.ts"]);
  assert.deepEqual(projectArtifacts([command, createArtifact()]), projected);
  assert.equal(projectArtifacts([createFact({ source: "hook", source_event_id: "inferred", kind: "artifact.created", subject: "artifact:inferred",
    source_ts: "2026-01-02T00:00:00Z", confidence: "inferred", payload: { ...ARTIFACT, attribution: "confirmed" } })])[0].attribution, "inferred");
});

test("新しい版への承認は古い版の異なるハッシュで stale にならない", () => {
  const approval = createFact({ source: "ui", source_event_id: "new-approval", kind: "approval.created", subject: "approval:ap2",
    source_ts: "2026-01-03T00:00:00Z", confidence: "confirmed", payload: { run_id: "r1", request_id: "new-req", state: "approved", artifact_id: "a2", patch_hash: "changed" } });
  assert.equal(projectApprovals([createArtifact(), createArtifact(2, "changed"), approval])[0].state, "approved");
});

test("成果物の版は全て残り、部分訂正と null の本文を扱う", () => {
  const first = createArtifact();
  const second = createArtifact(2, "changed");
  const correction = createFact({ source: "host-codex", source_event_id: "artifact-correction", kind: "artifact.corrected", subject: "artifact:a2",
    source_ts: "2026-01-03T00:00:00Z", confidence: "confirmed", supersedes: "artifact2", payload: { verification: { passed: false } } });
  const projected = projectArtifacts([correction, first, second]);
  assert.equal(projected.length, 2);
  assert.equal(projected[1].patch_hash, "changed");
  assert.deepEqual(projected[1].verification, { passed: false });
  assert.deepEqual(projectArtifacts([first, second, correction]), projected);
  assert.deepEqual(projectArtifacts([{ ...first, payload: null }]), []);
  const sameSubject = { ...second, subject: first.subject };
  assert.equal(new Set(projectArtifacts([first, sameSubject]).map((artifact) => artifact.id)).size, 2);
});

test("行の写しは検証済みを自動判定しない", () => {
  const target = { artifact_id: "a2", version: 2 };
  const context = { file: FINDING.file, side: FINDING.side, context_hash: FINDING.context_hash, start_line: 7, end_line: 8 };
  assert.equal(remapFinding({ ...FINDING, state: "fixed" }, target, [context]).state, "fixed");
  assert.equal(remapFinding(FINDING, target, [context, context]).start_line, 7);
});
