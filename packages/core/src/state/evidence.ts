import type { Confidence, Decision, Evidence, Reason } from "./types.ts";

export function selectEvidence<T extends Evidence>(evidence: readonly T[], now: number): T[] {
  if (!Number.isFinite(now)) throw new RangeError("evaluatedAt must be finite");
  const known = evidence.filter(e => Number.isFinite(e.at) && Number.isFinite(e.observedAt) && e.at <= now && e.observedAt <= now);
  const superseded = new Set(known.flatMap(e => e.supersedes ?? []));
  // 同じ証拠の再読は期限を延ばさず、取得時刻だけが異なる重複も一つにする。
  const unique = new Map<string, T>();
  for (const e of known) {
    if (superseded.has(e.id)) continue;
    const key = JSON.stringify({ ...e, observedAt: 0 });
    const previous = unique.get(key);
    if (!previous || e.observedAt < previous.observedAt) unique.set(key, e);
  }
  return [...unique.values()].sort((a, b) => a.at - b.at || compareText(a.id, b.id) || compareText(JSON.stringify(a), JSON.stringify(b)));
}

export function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export function selectLatest<T extends Evidence>(evidence: readonly T[]): T[] {
  const at = evidence.reduce((latest, e) => Math.max(latest, e.at), -Infinity);
  return evidence.filter(e => e.at === at);
}

export function decide<T>(value: T, reason: Reason, evidence: readonly Evidence[] = [], validUntil: number | null = null, confidence: Confidence = "confirmed"): Decision<T> {
  return { value, confidence, reason, at: evidence.length ? Math.max(...evidence.map(e => e.at)) : null,
    validUntil, evidenceIds: [...new Set(evidence.map(e => e.id))].sort(compareText) };
}
