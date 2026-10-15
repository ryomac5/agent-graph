import { compareText, decide, selectEvidence } from "./evidence.ts";
import type { Decision, Evidence, Reason, Scan } from "./types.ts";

export type DeliveryState = "accepted" | "emitting" | "emitted" | "received" | "received_candidate" | "terminal_handled" | "rejected" | "unverifiable";
export interface Operation extends Evidence {
  kind: "operation";
  cmdId: string;
  // 対象は会話・実行・端末の版まで含む、外部で解決済みの鍵。
  target: string;
  bodyKey: string;
  phase: "accepted" | "emitting" | "emitted" | "rejected" | "aborted" | "owner_lost" | "legacy_failed" | "legacy_closed";
}
export interface Correlation { protocol: "codex" | "verified_sdk" | "unverified_sdk" | "peer"; id: string }
export interface Binding extends Evidence {
  kind: "binding";
  cmdId: string;
  target: string;
  correlation: Correlation;
}
export interface Receipt extends Evidence {
  kind: "receipt";
  target: string;
  inputId: string;
  bodyKey?: string;
  phase: "queued" | "consumed";
  correlation?: Correlation;
}
export interface TerminalEvidence extends Evidence { kind: "terminal"; cmdId: string; target: string }
export interface Tombstone extends Evidence {
  kind: "tombstone";
  cmdId: string;
  target: string;
  bodyKey: string;
  // 確定した受領／送出前拒否だけを保存済みの事実として使う。
  value: "received" | "rejected" | "unverifiable";
}
export type DeliveryEvidence = Operation | Binding | Receipt | TerminalEvidence | Tombstone | Scan;
export interface DeliveryInput { cmdId: string; evidence: readonly DeliveryEvidence[] }
export interface DeliveryPolicy { deadlineMs: number; clockSkewMs: number }
export const DEFAULT_DELIVERY_POLICY: Readonly<DeliveryPolicy> = Object.freeze({ deadlineMs: 60_000, clockSkewMs: 0 });
export interface DeliveryDecision extends Decision<DeliveryState> {
  evaluatedAt: number;
  display: "Sending" | "Delivered" | "Queued" | "Likely delivered" | "Likely queued" | "Unconfirmed" | "Not delivered" | "Handled in terminal";
  resendAutomatically: false;
  observation: "healthy" | "failed" | "delayed" | "out_of_scope";
}

function matchCorrelation(a: Correlation | undefined, b: Correlation | undefined): boolean {
  return !!a && !!b && a.id === b.id && a.protocol === b.protocol && (a.protocol === "codex" || a.protocol === "verified_sdk");
}

export function evaluateDelivery(input: DeliveryInput, evaluatedAt: number, policy: Readonly<DeliveryPolicy> = DEFAULT_DELIVERY_POLICY): DeliveryDecision {
  if (!(policy.deadlineMs > 0 && Number.isFinite(policy.deadlineMs) && policy.clockSkewMs >= 0 && Number.isFinite(policy.clockSkewMs))) throw new RangeError("invalid delivery policy");
  const evidence = selectEvidence(input.evidence, evaluatedAt);
  const operations = evidence.filter((e): e is Operation => e.kind === "operation");
  const own = operations.filter(e => e.cmdId === input.cmdId);
  const tombstones = evidence.filter((e): e is Tombstone => e.kind === "tombstone" && e.cmdId === input.cmdId);
  const records = [...own, ...tombstones];
  const target = records[0]?.target;
  const scans = evidence.filter((e): e is Scan => e.kind === "scan" && !!target && e.subjects.includes(target));
  const scanAt = Math.max(-Infinity, ...scans.map(e => e.at));
  const latestScans = scans.filter(e => e.at === scanAt);
  const observation: DeliveryDecision["observation"] = !latestScans.length ? "out_of_scope" : latestScans.some(e => e.status !== "succeeded") ? "failed"
    : latestScans.some(e => evaluatedAt >= e.at + e.validForMs) ? "delayed" : "healthy";
  const finish = (value: DeliveryState, reason: Reason, proof: readonly Evidence[], until: number | null = null, queued = false): DeliveryDecision => {
    const labels = { accepted: "Sending", emitting: "Sending", emitted: "Sending", received: queued ? "Queued" : "Delivered",
      received_candidate: queued ? "Likely queued" : "Likely delivered", terminal_handled: "Handled in terminal", rejected: "Not delivered", unverifiable: "Unconfirmed" } as const;
    const confidence = value === "received_candidate" || value === "terminal_handled" ? "inferred" : value === "unverifiable" ? "unknown" : "confirmed";
    return { ...decide(value, reason, proof, until, confidence), evaluatedAt, display: labels[value], resendAutomatically: false, observation };
  };
  if (!records.length) return finish("unverifiable", "missing_evidence", []);
  if (new Set(records.map(e => JSON.stringify([e.target, e.bodyKey]))).size !== 1) return finish("unverifiable", "cmd_id_conflict", records);
  const sent = own.filter(e => ["emitting", "emitted", "aborted", "legacy_failed", "legacy_closed"].includes(e.phase));
  const rejected = [...own.filter(e => e.phase === "rejected"), ...tombstones.filter(e => e.value === "rejected")];
  const delivered = tombstones.filter(e => e.value === "received");
  if (rejected.length) return sent.length || delivered.length ? finish("unverifiable", "evidence_conflict", records) : finish("rejected", "not_emitted", rejected);
  if (delivered.length) return finish("received", "correlated_receipt", delivered);
  const bindings = evidence.filter((e): e is Binding => e.kind === "binding");
  const receipts = evidence.filter((e): e is Receipt => e.kind === "receipt" && e.target === target);
  const ownBindings = bindings.filter(e => e.cmdId === input.cmdId && e.target === target);
  const correlated = receipts.filter(r => ownBindings.some(b => matchCorrelation(b.correlation, r.correlation)));
  if (correlated.length && (sent.length || tombstones.some(e => e.value === "unverifiable"))) {
    const shared = correlated.some(r => bindings.some(b => b.target === target && b.cmdId !== input.cmdId && matchCorrelation(b.correlation, r.correlation)));
    if (shared) return finish("unverifiable", "evidence_conflict", correlated);
    return finish("received", "correlated_receipt", [...ownBindings, ...correlated], null, !correlated.some(r => r.phase === "consumed"));
  }
  const lost = own.filter(e => e.phase === "owner_lost");
  if (!sent.length) {
    if (tombstones.length) return finish("unverifiable", "missing_evidence", tombstones);
    if (lost.length) return finish("rejected", "not_emitted", [...own, ...lost]);
    const until = Math.min(...own.map(e => e.at)) + policy.deadlineMs;
    return evaluatedAt >= until ? finish("unverifiable", "delivery_expired", own, until) : finish("accepted", "accepted", own, until);
  }
  // 上限は永続化された最初の送出開始から数える。turn や再接続で延ばさない。
  const start = Math.min(...sent.map(e => e.at));
  const until = start + policy.deadlineMs;
  const eligible = new Map<string, Operation[]>();
  for (const op of operations) {
    if (op.target === target) eligible.set(op.cmdId, [...(eligible.get(op.cmdId) ?? []), op]);
  }
  const candidates = new Map<string, Set<string>>();
  const candidateRows = new Map<string, Receipt[]>();
  for (const r of receipts) {
    // 他の操作に相関済みの入力を本文一致で奪わない。
    if (bindings.some(b => b.target === target && matchCorrelation(b.correlation, r.correlation))) continue;
    const owners = new Set<string>();
    for (const [cmdId, ops] of eligible) {
      const starts = ops.filter(e => ["emitting", "emitted", "aborted", "legacy_failed", "legacy_closed"].includes(e.phase));
      if (ops.some(e => e.phase === "rejected") || !starts.length || new Set(ops.map(e => e.bodyKey)).size !== 1) continue;
      if (r.bodyKey === ops[0].bodyKey && r.at >= Math.min(...starts.map(e => e.at)) - policy.clockSkewMs) owners.add(cmdId);
    }
    candidates.set(r.inputId, new Set([...(candidates.get(r.inputId) ?? []), ...owners]));
    candidateRows.set(r.inputId, [...(candidateRows.get(r.inputId) ?? []), r]);
  }
  const matching = [...candidates].filter(([, owners]) => owners.has(input.cmdId));
  if (matching.length) {
    const rows = matching.flatMap(([id]) => candidateRows.get(id)!).sort((a, b) => compareText(a.id, b.id));
    const ambiguous = matching.length !== 1 || matching.some(([, owners]) => owners.size !== 1) || new Set(rows.map(r => r.bodyKey)).size !== 1;
    if (ambiguous) return finish("unverifiable", "ambiguous_candidates", rows);
    return finish("received_candidate", "unique_candidate", rows, null, !rows.some(r => r.phase === "consumed"));
  }
  const terminal = evidence.filter((e): e is TerminalEvidence => e.kind === "terminal" && e.cmdId === input.cmdId && e.target === target && e.at >= start);
  if (terminal.length) return finish("terminal_handled", "terminal_handled", terminal);
  if (lost.length) return finish("unverifiable", "owner_restarted", [...sent, ...lost], until);
  if (own.some(e => e.phase === "aborted")) return finish("unverifiable", "aborted_after_write", sent, until);
  if (ownBindings.some(b => b.correlation.protocol === "unverified_sdk" || b.correlation.protocol === "peer")) return finish("unverifiable", "unsupported_correlation", ownBindings, until);
  if (evaluatedAt >= until || own.some(e => e.phase.startsWith("legacy_"))) return finish("unverifiable", "delivery_expired", sent, until);
  return own.some(e => e.phase === "emitted") ? finish("emitted", "emitted", sent, until) : finish("emitting", "emitting", sent, until);
}
