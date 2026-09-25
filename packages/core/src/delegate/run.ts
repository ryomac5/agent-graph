import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type DecisionInput } from "../assign/assign.ts";
import { loadPolicy } from "../assign/policy.ts";
import { aggregatePerformance } from "../store/performance.ts";
import { runAcceptance } from "../accept/run.ts";
import { execute as runExecute, type ExecRequest, type ExecResult } from "../exec/types.ts";
import type { Event, EventKind, EventPayload } from "../events.ts";
import type { Store } from "../store/store.ts";
import type { UsageSample } from "../usage/types.ts";
import { childContext, newSpanId, newTraceId, type TraceContext } from "../trace.ts";
import { ulid } from "../ulid.ts";
import type { AcceptanceResult, Assignment, DelegateRequest, DelegateResult, ModelFamily } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_SEC = 1800;
const REVIEW_DIFF_CHAR_LIMIT = 30000;
const REVIEW_DIFF_TRUNCATED = "\n…(以降省略)";
const EMPTY_ACCEPTANCE: AcceptanceResult = { passed: false, results: [], scopeViolations: [] };
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 };

export interface DelegationDeps {
  store: Store;
  decide?: typeof decide;
  policy?: DecisionInput["policy"];
  execute?: (request: ExecRequest) => Promise<ExecResult>;
  accept?: typeof runAcceptance;
  now?: () => Date;
  usageSamples?: UsageSample[];
}

export interface DelegationCaller {
  repoKey: string;
  repoRoot: string;
  sessionId: string;
  trace?: TraceContext;
  parentDelegationId?: string;
  orchestratorModel?: string;
  implementerFamily?: ModelFamily;
}

function readVerdict(output: string): "approve" | "request_changes" {
  const line = output.trimEnd().split(/\r?\n/).at(-1)?.trim();
  return line === "VERDICT: approve" ? "approve" : "request_changes";
}

async function readReviewDiff(cwd: string, baseRef: string): Promise<string> {
  let diff = (await execFileAsync("git", ["diff", baseRef, "--"], { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
  const untracked = (await execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd })).stdout;
  for (const file of untracked.split("\0").filter(Boolean)) {
    try {
      await execFileAsync("git", ["diff", "--no-index", "--", "/dev/null", file], { cwd, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string };
      if (result.code !== 1 || result.stdout === undefined) throw error;
      diff += result.stdout;
    }
  }
  return diff.length > REVIEW_DIFF_CHAR_LIMIT
    ? diff.slice(0, REVIEW_DIFF_CHAR_LIMIT) + REVIEW_DIFF_TRUNCATED : diff;
}

export async function runDelegation(
  req: DelegateRequest, caller: DelegationCaller, deps: DelegationDeps,
): Promise<DelegateResult> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const cwd = req.cwd ?? caller.repoRoot;
  const delegationId = ulid();
  const trace = caller.trace
    ? childContext(caller.trace)
    : { traceId: newTraceId(), spanId: newSpanId() };
  const event = <K extends EventKind>(kind: K, payload: EventPayload[K]): void => {
    store.appendEvent({ id: ulid(), ts: now().toISOString(), kind, repo: caller.repoKey,
      session: caller.sessionId, trace, payload } as Event);
  };
  const deniedAssignment: Assignment = {
    executor: "codex", model: "", family: "openai", tier: "low",
    reason: [], policyVersion: "",
  };
  let assignment = deniedAssignment;
  let output = "";
  let acceptance = EMPTY_ACCEPTANCE;
  let usage = EMPTY_USAGE;
  let status: DelegateResult["status"] = "failed";
  let review: DelegateResult["review"];
  let finished = false;
  let roundTrips = 0;
  // 依頼の詳細と往復は表に残し、詳細パネルが events を辿らずに読めるようにする
  store.insertDelegation({ id: delegationId, repoKey: caller.repoKey,
    sessionId: caller.sessionId, parentId: caller.parentDelegationId,
    role: req.role, title: req.title, status: "requested",
    task: req.task, scope: req.scope, outputs: req.outputs, worktree: cwd });
  store.insertDelegationRound(delegationId, "request", req.task, now().toISOString());
  store.insertSpan({ trace, name: "delegate", startedAt: now().toISOString(), status: "unset",
    attributes: { "agent.role": req.role, "agent.executor": "", "agent.model": "",
      "agent.session": caller.sessionId, "agent.delegation": delegationId } });
  try {
    event("delegation.requested", { delegationId, task: req.task });
    const samples = new Map<string, UsageSample>();
    for (const sample of [...store.latestUsageSamples(), ...(deps.usageSamples ?? [])]) {
      const key = `${sample.provider}\0${sample.model ?? ""}\0${sample.window}`;
      const previous = samples.get(key);
      if (!previous || sample.ts > previous.ts) samples.set(key, sample);
    }
    const latestSamples = [...samples.values()];
    const performance = aggregatePerformance(store.db, { role: req.role });
    const policy = deps.policy ?? loadPolicy();
    const decision = (deps.decide ?? decide)(req, {
      policy,
      quota: (candidate) => {
        const modelWords = candidate.model.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        const scoped = candidate.family === "anthropic"
          ? latestSamples.filter((sample) => sample.provider === "anthropic" && sample.model &&
            modelWords.every((word) => sample.model!.toLowerCase().split(/[^a-z0-9]+/).includes(word)))
          : [];
        const relevant = scoped.length ? scoped : latestSamples.filter((sample) =>
          sample.provider === candidate.family && sample.model === undefined);
        const highest = relevant.reduce((best, sample) => !best || sample.percent > best.percent ? sample : best, undefined as UsageSample | undefined);
        return highest && { percent: highest.percent, source: `${highest.provider} ${highest.model ?? highest.window}` };
      },
      performance: (role, model) => performance.find((item) => item.role === role && item.model === model),
      orchestratorModel: caller.orchestratorModel,
      implementerFamily: caller.implementerFamily,
    });
    if (!decision.ok) {
      assignment = { ...deniedAssignment, reason: decision.reason };
      status = "denied";
    } else {
      assignment = decision.assignment;
      store.insertAssignment(delegationId, assignment);
      event("assignment.decided", { delegationId, executor: assignment.executor, model: assignment.model,
        reason: assignment.reason, policyVersion: assignment.policyVersion });
      store.updateSpanAttributes(trace.traceId, trace.spanId, {
        "agent.executor": assignment.executor, "agent.model": assignment.model,
      });
      const baseRef = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
      let task = req.task;
      while (true) {
        const executeTrace = childContext(trace);
        store.insertSpan({ trace: executeTrace, name: "execute", startedAt: now().toISOString(), status: "unset", attributes: { "agent.role": req.role, "agent.executor": assignment.executor, "agent.model": assignment.model, "agent.session": caller.sessionId, "agent.delegation": delegationId, "agent.roundTrips": roundTrips } });
        const workDir = await mkdtemp(join(tmpdir(), "agent-graph-delegate-"));
        let execution: ExecResult;
        try {
          event("execution.started", { delegationId });
          execution = await (deps.execute ?? runExecute)({
            executor: assignment.executor, model: assignment.model, task, cwd, trace: executeTrace,
            sessionId: caller.sessionId, delegationId,
            timeoutMs: (req.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000, workDir,
          });
          store.endSpan(executeTrace.traceId, executeTrace.spanId, now().toISOString(), execution.exitCode === 0 ? "ok" : "error");
        } catch (error) {
          store.endSpan(executeTrace.traceId, executeTrace.spanId, now().toISOString(), "error");
          throw error;
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
        output = execution.output;
        store.insertDelegationRound(delegationId, "report", output, now().toISOString());
        usage = { inputTokens: usage.inputTokens + execution.usage.inputTokens, outputTokens: usage.outputTokens + execution.usage.outputTokens };
        if (roundTrips === 0) store.insertTokenUsage(delegationId, usage, assignment.model);
        else store.db.prepare("UPDATE token_usage SET input_tokens = ?, output_tokens = ? WHERE delegation_id = ?").run(usage.inputTokens, usage.outputTokens, delegationId);
        event("execution.finished", { delegationId, exitCode: execution.exitCode });
        if (execution.timedOut) {
          status = "timeout";
        } else {
          acceptance = await (deps.accept ?? runAcceptance)({
            commands: req.accept, cwd, scope: req.scope, baseRef,
            timeoutMs: (req.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
          });
          if (roundTrips === 0) store.insertAcceptance(delegationId, acceptance);
          else store.db.prepare("UPDATE acceptances SET passed = ?, results = ?, scope_violations = ? WHERE delegation_id = ?").run(Number(acceptance.passed), JSON.stringify(acceptance.results), JSON.stringify(acceptance.scopeViolations), delegationId);
          event("acceptance.evaluated", { delegationId, passed: acceptance.passed });
          status = execution.exitCode === 0 && acceptance.passed ? "done" : "failed";
          if (status === "done" && (req.review ?? req.role === "implement")) {
            const diff = await readReviewDiff(cwd, baseRef);
            const reviewResult = await runDelegation({
              role: "review", title: `Review: ${req.title}`, cwd,
              task: `元の依頼:\n${req.task}\n\n受け入れ結果:\n${JSON.stringify(acceptance)}\n\ngit diff:\n${diff}\n\n最終行に VERDICT: approve または VERDICT: request_changes を書いてください。`,
              accept: ["true"], review: false,
              constraints: { excludeFamily: [assignment.family] },
            }, { ...caller, trace, parentDelegationId: delegationId, implementerFamily: assignment.family }, deps);
            const verdict = reviewResult.status === "done"
              ? readVerdict(reviewResult.output) : "request_changes";
            review = { verdict, reviewer: reviewResult.assignment, comment: reviewResult.output };
            if (!store.db.prepare("SELECT 1 FROM reviews WHERE delegation_id = ?").get(delegationId)) store.insertReview(delegationId, reviewResult.delegationId, verdict, reviewResult.output);
            else store.db.prepare("UPDATE reviews SET reviewer_delegation_id = ?, verdict = ?, comment = ? WHERE delegation_id = ?").run(reviewResult.delegationId, verdict, reviewResult.output, delegationId);
            event("review.evaluated", { delegationId, verdict });
            if (verdict === "request_changes") status = "failed";
          }
        }
        if (status === "done" || status === "timeout" || roundTrips >= policy.maxRoundTrips) break;
        const feedback = !acceptance.passed || execution.exitCode !== 0
          ? `受け入れ失敗 (exitCode: ${execution.exitCode}):\n${JSON.stringify(acceptance)}`
          : `レビューの修正依頼:\n${review?.comment ?? ""}`;
        const reinstruction = `前回の結果を踏まえて修正してください。\n${feedback}`;
        task = `${req.task}\n\n${reinstruction}`;
        roundTrips++;
        store.insertDelegationRound(delegationId, "reinstruct", reinstruction, now().toISOString());
        store.db.prepare("UPDATE delegations SET round_trips = ? WHERE id = ?").run(roundTrips, delegationId);
      }
    }
    store.finishDelegation(delegationId, status, output);
    event("delegation.finished", { delegationId, status });
    finished = true;
    return { delegationId, traceId: trace.traceId, spanId: trace.spanId, status,
      assignment, output, acceptance, ...(review ? { review } : {}), usage, roundTrips };
  } catch (error) {
    if (!finished) {
      status = "failed";
      store.finishDelegation(delegationId, status);
      event("delegation.finished", { delegationId, status });
    }
    throw error;
  } finally {
    store.endSpan(trace.traceId, trace.spanId, now().toISOString(), status === "done" ? "ok" : "error");
  }
}
