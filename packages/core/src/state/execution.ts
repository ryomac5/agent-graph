import { compareText, decide, selectEvidence, selectLatest } from "./evidence.ts";
import { DEFAULT_STATE_POLICY } from "./types.ts";
import type { ClosureState, Decision, HostingState, ProcessState, Scan, Signal, Stage, StateDecision, StateInput, StatePolicy, TurnState } from "./types.ts";

const STAGES: readonly Stage[] = ["launched", "responded", "reported", "verified", "reviewed"];
const TURN_EVENTS = new Set(["start", "progress", "approval", "input", "complete", "stop_attempt", "child_stopped"]);

function decideProcess(input: StateInput, signals: Signal[], scans: Scan[], now: number): Decision<ProcessState> {
  const process = input.process;
  if (!process) return decide("unverified", "missing_evidence", [], null, "unknown");
  const parent = input.parentProcessAtLaunch;
  // 現在の親の生存を、別の起動回の子へ貸さない。
  if (parent !== "independent" && (!parent || parent.pid !== process.pid || parent.procStart !== process.procStart)) {
    return decide("unverified", parent ? "owner_restarted" : "missing_evidence", [], null, "unknown");
  }
  const exits = signals.filter(e => e.event === "exit" && e.process?.pid === process.pid && e.process.procStart === process.procStart);
  const checks = scans.filter(e => e.status === "succeeded" && e.processes &&
    !e.processes.some(p => p.pid === process.pid && p.procStart === null));
  const absent = checks.filter(e => !e.processes!.some(p => p.pid === process.pid && p.procStart === process.procStart));
  // 物理世代の終了は履歴の事実。同じ PID が再登場しても復活させない。
  if (exits.length || absent.length) return decide("exited_confirmed", "process_exited", [...exits, ...absent]);
  const latest = selectLatest(checks);
  const until = latest.length ? Math.min(...latest.map(e => e.at + e.validForMs)) : null;
  if (until !== null && now < until) return decide("alive_confirmed", "process_observed", latest, until);
  return decide("unverified", latest.length ? "liveness_expired" : scans.length ? "scan_failed" : "missing_evidence", latest, until, "unknown");
}

function decideHosting(scans: Scan[], runId: string | null, now: number): Decision<HostingState> {
  const latest = selectLatest(scans.filter(e => e.status === "succeeded" && e.hosted));
  if (!latest.length) return decide("unknown", scans.length ? "scan_failed" : "missing_evidence", [], null, "unknown");
  const until = Math.min(...latest.map(e => e.at + e.validForMs));
  if (now >= until) return decide("unknown", "scan_expired", latest, until, "unknown");
  const values = new Set(latest.map(e => e.hosted!.includes(runId!) ? "hosted" : "not_hosted"));
  if (values.size !== 1) return decide("unknown", "evidence_conflict", latest, until, "unknown");
  return decide([...values][0], "hosting_observed", latest, until);
}

function decideClosure(signals: Signal[], process: ProcessState): Decision<ClosureState> {
  const latest = selectLatest(signals.filter(e => ["open", "close", "archive"].includes(e.event) ||
    (e.event === "start" && e.turnId && e.confidence !== "inferred" && process !== "exited_confirmed")));
  if (!latest.length) return decide("unknown", "missing_evidence", [], null, "unknown");
  const values = new Set(latest.map(e => e.event === "close" || e.event === "archive" ? "closed" : "open"));
  if (values.size !== 1) return decide("unknown", "evidence_conflict", latest, null, "unknown");
  const value = [...values][0];
  return decide(value, value === "open" ? "run_opened" : "run_closed", latest);
}

function selectRunningTools(events: Signal[]): Signal[] {
  const boundaryAt = Math.max(-Infinity, ...events.filter(e => e.event !== "progress" && e.event !== "start").map(e => e.at));
  const finished = new Map<string | null, number>();
  let lastFinish = -Infinity;
  for (const e of events) for (const tool of e.tools ?? []) {
    if (tool.phase !== "finished") continue;
    finished.set(tool.id, Math.max(finished.get(tool.id) ?? -Infinity, e.at));
    lastFinish = Math.max(lastFinish, e.at);
  }
  // ID のない開始は、いずれかの結果で閉じる。停止・待ちの境界を越えて持ち越さない。
  return events.filter(e => e.at > boundaryAt && e.tools?.some(tool => tool.phase === "started" &&
    e.at > (tool.id === null ? lastFinish : Math.max(finished.get(tool.id) ?? -Infinity, finished.get(null) ?? -Infinity))));
}

function decideTurn(input: StateInput, signals: Signal[], process: Decision<ProcessState>, now: number, policy: StatePolicy): Decision<TurnState> {
  if (!input.turnId) return decide("unknown", "identity_unresolved", [], null, "unknown");
  const events = signals.filter(e => e.turnId === input.turnId && (TURN_EVENTS.has(e.event) || e.event === "close" || e.event === "archive") &&
    (e.activity !== "session_busy" || e.process?.pid === input.process?.pid && e.process?.procStart === input.process?.procStart));
  const latest = selectLatest(events);
  if (!latest.length) return decide("unknown", "missing_evidence", [], null, "unknown");
  const isComplete = (e: Signal) => e.event === "complete" || e.event === "close" || e.event === "archive";
  const values = new Set(latest.map(e => isComplete(e) ? "complete" : e.event === "start" ? "progress" : e.event));
  const completed = events.filter(isComplete);
  if (values.size !== 1 || (completed.length && latest.some(e => !isComplete(e)))) {
    return decide("unknown", "evidence_conflict", [...completed, ...latest], null, "unknown");
  }
  const event = [...values][0];
  const confidence = latest.some(e => e.confidence === "inferred") ? "inferred" : "confirmed";
  if (event === "complete") return decide("completed", "turn_finished", latest, null, confidence);
  if (event === "stop_attempt" || event === "child_stopped") return decide("unknown", "boundary_unavailable", latest, null, "unknown");
  if (process.value === "exited_confirmed") return decide("unknown", "process_exited", latest, null, "unknown");
  const waiting = event === "approval" || event === "input";
  const runningTools = waiting ? [] : selectRunningTools(events);
  if (runningTools.length && process.value === "alive_confirmed") {
    const proof = [...runningTools, ...latest];
    const decision = decide<TurnState>("running", "running_tool", proof, process.validUntil,
      proof.some(e => e.confidence === "inferred") ? "inferred" : confidence);
    decision.evidenceIds = [...new Set([...decision.evidenceIds, ...process.evidenceIds])].sort(compareText);
    return decision;
  }
  const until = latest[0].at + (waiting ? policy.waitingMs : policy.progressMs);
  if (now >= until) return decide("unknown", waiting ? "waiting_expired" : "progress_expired", latest, until, "unknown");
  if (event === "approval") return decide("waiting_approval", "approval_requested", latest, until, confidence);
  if (event === "input") return decide("waiting_input", "input_requested", latest, until, confidence);
  return decide("running", "turn_progress", latest, until, confidence);
}

function decideResult(input: StateInput, signals: Signal[], process: ProcessState): StateDecision["result"] {
  const attempt = input.attempt;
  const events = attempt?.id ? signals.filter(e => e.attemptId === attempt.id) : [];
  const stages = STAGES.filter(stage => events.some(e => e.event === stage && e.confidence !== "inferred"));
  const extra = { attemptId: attempt?.id ?? null, requiredStage: attempt?.requiredStage ?? null,
    stages, stage: stages.at(-1) ?? null, reportFailures: events.filter(e => e.event === "report_failure").map(e => e.id).sort(compareText) };
  if (!attempt) return { ...decide("not_applicable" as const, "not_applicable"), ...extra };
  if (!attempt.id || attempt.requiredStage === "unknown") return { ...decide("unknown" as const, "required_stage_unknown", events, null, "unknown"), ...extra };
  const requests = events.filter(e => e.event === "interrupt_request");
  const isInterrupted = (e: Signal) => !!e.interruptId && requests.some(r => r.id === e.interruptId && r.at <= e.at && r.turnId === e.turnId);
  const interruptions = events.filter(e => (e.event === "failure" || e.event === "interrupted") && isInterrupted(e));
  const failures = events.filter(e => e.event === "failure" && !isInterrupted(e));
  const succeeded = stages.includes(attempt.requiredStage);
  const outcomes = Number(succeeded) + Number(failures.length > 0) + Number(interruptions.length > 0);
  if (outcomes > 1) return { ...decide("unknown" as const, "evidence_conflict", events, null, "unknown"), ...extra };
  if (failures.length) return { ...decide("failed" as const, "attempt_failed", failures), ...extra };
  if (interruptions.length) return { ...decide("interrupted" as const, "attempt_interrupted", [...requests, ...interruptions]), ...extra };
  if (succeeded) return { ...decide("succeeded" as const, "stage_reached", events.filter(e => STAGES.includes(e.event as Stage))), ...extra };
  if (process === "exited_confirmed") return { ...decide("unknown" as const, "process_exited", events, null, "unknown"), ...extra };
  return { ...decide("incomplete" as const, "stage_missing", events), ...extra };
}

export function renderState(resolved: boolean, process: ProcessState, hosting: HostingState, closure: ClosureState, turn: TurnState): StateDecision["display"]["label"] {
  if (!resolved) return "Unresolved";
  if (process === "exited_confirmed") return "Stopped";
  if (turn === "waiting_approval") return "Needs approval";
  if (turn === "waiting_input") return "Waiting";
  if (turn === "running") return "Working";
  if (closure === "closed") return "Closed";
  if (hosting === "not_hosted") return "Not hosted";
  if (turn === "completed") return "Idle";
  return "Unknown";
}

export function evaluateState(input: StateInput, evaluatedAt: number, policy: Readonly<StatePolicy> = DEFAULT_STATE_POLICY): StateDecision {
  if (!(policy.progressMs > 0 && Number.isFinite(policy.progressMs) && policy.waitingMs > 0 && Number.isFinite(policy.waitingMs))) throw new RangeError("state windows must be positive and finite");
  const evidence = selectEvidence(input.evidence, evaluatedAt);
  const signals = evidence.filter((e): e is Signal => e.kind === "signal" && e.runId === input.runId);
  const scans = evidence.filter((e): e is Scan => e.kind === "scan" && input.runId !== null && e.subjects.includes(input.runId));
  const conflicts = evidence.filter(e => e.kind === "conflict" && e.runId === input.runId && (!e.turnId || e.turnId === input.turnId)).map(e => e.id).sort(compareText);
  const process = decideProcess(input, signals, scans, evaluatedAt);
  const hosting = decideHosting(scans, input.runId, evaluatedAt);
  const closure = decideClosure(signals, process.value);
  const turn = decideTurn(input, signals, process, evaluatedAt, policy);
  const runningTool = turn.reason === "running_tool";
  if (conflicts.length && turn.value !== "unknown") { turn.confidence = "inferred"; turn.reason = "history_conflict"; }
  const result = decideResult(input, signals, process.value);
  const groups = new Map<string, Scan[]>();
  for (const scan of scans) {
    const key = JSON.stringify([scan.source, scan.scope]);
    groups.set(key, [...(groups.get(key) ?? []), scan]);
  }
  const observation: StateDecision["observation"] = [...groups.entries()].sort(([a], [b]) => compareText(a, b)).map(([, group]) => {
    const last = selectLatest(group);
    return { source: last[0].source, scope: last[0].scope, at: last[0].at,
      state: last.some(e => e.status !== "succeeded") ? "failed" : last.some(e => evaluatedAt >= e.at + e.validForMs) ? "delayed" : "healthy" };
  });
  const details: string[] = [];
  if (runningTool) details.push("running tool");
  if (turn.confidence === "inferred") details.push("unconfirmed");
  if (process.value === "unverified") details.push("liveness unverified");
  if (turn.value === "completed" && process.value !== "alive_confirmed") details.push("last seen");
  if (conflicts.length) details.push("History conflict · unresolved");
  const badges = { succeeded: "Done", failed: "Failed", interrupted: "Interrupted", unknown: "No result", incomplete: null, not_applicable: null } as const;
  return { evaluatedAt, process, hosting, closure, turn, result, observation, conflicts,
    display: { label: renderState(input.runId !== null, process.value, hosting.value, closure.value, turn.value), details, result: badges[result.value] } };
}
