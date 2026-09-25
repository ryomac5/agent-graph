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
import { childContext, newSpanId, newTraceId, type TraceContext } from "../trace.ts";
import { ulid } from "../ulid.ts";
import type { AcceptanceResult, Assignment, DelegateRequest, DelegateResult, ModelFamily } from "./types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_SEC = 1800;
const EMPTY_ACCEPTANCE: AcceptanceResult = { passed: false, results: [], scopeViolations: [] };
const EMPTY_USAGE = { inputTokens: 0, outputTokens: 0 };

export interface DelegationDeps {
  store: Store;
  decide?: typeof decide;
  policy?: DecisionInput["policy"];
  execute?: (request: ExecRequest) => Promise<ExecResult>;
  accept?: typeof runAcceptance;
  now?: () => Date;
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
  store.insertDelegation({ id: delegationId, repoKey: caller.repoKey,
    sessionId: caller.sessionId, parentId: caller.parentDelegationId,
    role: req.role, title: req.title, status: "requested" });
  store.insertSpan({ trace, name: "delegate", startedAt: now().toISOString(), status: "unset",
    attributes: { "agent.role": req.role, "agent.executor": "", "agent.model": "",
      "agent.session": caller.sessionId, "agent.delegation": delegationId } });
  try {
    event("delegation.requested", { delegationId, task: req.task });
    const samples = store.latestUsageSamples();
    const performance = aggregatePerformance(store.db, { role: req.role });
    const decision = (deps.decide ?? decide)(req, {
      policy: deps.policy ?? loadPolicy(),
      quota: (candidate) => {
        const scoped = candidate.family === "anthropic"
          ? samples.filter((sample) => sample.provider === "anthropic" && sample.model?.toLowerCase() === candidate.model.toLowerCase())
          : [];
        const relevant = scoped.length ? scoped : samples.filter((sample) =>
          sample.provider === candidate.family && sample.model === undefined);
        const highest = relevant.reduce((best, sample) => !best || sample.percent > best.percent ? sample : best, undefined as typeof samples[number] | undefined);
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
      const decidedPayload = { delegationId, executor: assignment.executor, model: assignment.model,
        reason: assignment.reason, policyVersion: assignment.policyVersion };
      event("assignment.decided", decidedPayload);
      store.updateSpanAttributes(trace.traceId, trace.spanId, {
        "agent.executor": assignment.executor, "agent.model": assignment.model,
      });
      const baseRef = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
      const workDir = await mkdtemp(join(tmpdir(), "agent-graph-delegate-"));
      let execution: ExecResult;
      try {
        event("execution.started", { delegationId });
        execution = await (deps.execute ?? runExecute)({
          executor: assignment.executor, model: assignment.model, task: req.task, cwd, trace,
          sessionId: caller.sessionId, delegationId,
          timeoutMs: (req.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000, workDir,
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
      output = execution.output;
      usage = execution.usage;
      store.insertTokenUsage(delegationId, usage, assignment.model);
      event("execution.finished", { delegationId, exitCode: execution.exitCode });
      if (execution.timedOut) {
        status = "timeout";
      } else {
        acceptance = await (deps.accept ?? runAcceptance)({
          commands: req.accept, cwd, scope: req.scope, baseRef,
          timeoutMs: (req.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000,
        });
        store.insertAcceptance(delegationId, acceptance);
        event("acceptance.evaluated", { delegationId, passed: acceptance.passed });
        status = execution.exitCode === 0 && acceptance.passed ? "done" : "failed";
        if (status === "done" && (req.review ?? req.role === "implement")) {
          const diff = (await execFileAsync("git", ["diff"], { cwd, maxBuffer: 10 * 1024 * 1024 })).stdout;
          const reviewResult = await runDelegation({
            role: "review", title: `Review: ${req.title}`, cwd,
            task: `元の依頼:\n${req.task}\n\n受け入れ結果:\n${JSON.stringify(acceptance)}\n\ngit diff:\n${diff}\n\n最終行に VERDICT: approve または VERDICT: request_changes を書いてください。`,
            accept: ["true"], review: false,
            constraints: { excludeFamily: [assignment.family] },
          }, { ...caller, trace, parentDelegationId: delegationId, implementerFamily: assignment.family }, deps);
          const verdict = reviewResult.status === "done"
            ? readVerdict(reviewResult.output) : "request_changes";
          review = { verdict, reviewer: reviewResult.assignment, comment: reviewResult.output };
          store.insertReview(delegationId, reviewResult.delegationId, verdict, reviewResult.output);
          event("review.evaluated", { delegationId, verdict });
          if (verdict === "request_changes") status = "failed";
        }
      }
    }
    store.finishDelegation(delegationId, status);
    event("delegation.finished", { delegationId, status });
    finished = true;
    return { delegationId, traceId: trace.traceId, spanId: trace.spanId, status,
      assignment, output, acceptance, ...(review ? { review } : {}), usage, roundTrips: 0 };
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
