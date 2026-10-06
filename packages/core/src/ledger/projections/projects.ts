import { createHash } from "node:crypto";
import type { Fact, Source } from "../facts.ts";
import { compareText, projectEntities } from "./relations.ts";
import type { ProjectedEntity } from "./relations.ts";

export type ProjectedProject = ProjectedEntity<"project">;

// 呼び出し側で git の共通ディレクトリを実パスに解決する。作業ツリーのパスは使わない。
export function createRepositoryId(realCommonDirectory: string): string {
  return createHash("sha256").update(realCommonDirectory).digest("hex");
}

export function projectProjects(facts: readonly Fact[]): ProjectedProject[] {
  return projectEntities(facts, "project", (payload, id) => payload.repository_id ?? id);
}

export interface UnsupportedObservationProjection {
  source_kind: Source;
  format_name: string;
  format_version: string;
  count: number;
  last_detected_ts: string;
}

export function projectUnsupportedObservations(facts: readonly Fact[]): UnsupportedObservationProjection[] {
  const groups = new Map<string, UnsupportedObservationProjection>();
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.kind !== "observation.unsupported" || !fact.payload || seen.has(fact.fact_id)) continue;
    seen.add(fact.fact_id);
    const { source_kind, format_name, format_version } = fact.payload;
    if (source_kind === undefined || format_name === undefined || format_version === undefined) continue;
    const key = JSON.stringify([source_kind, format_name, format_version]);
    const previous = groups.get(key);
    // 検出時刻は取り込み元の時刻ではなく観測時刻を使う。同時刻の表記差も安定させる。
    const latest = previous && (Date.parse(previous.last_detected_ts) > Date.parse(fact.observed_ts)
      || (Date.parse(previous.last_detected_ts) === Date.parse(fact.observed_ts)
        && compareText(previous.last_detected_ts, fact.observed_ts) > 0));
    groups.set(key, {
      source_kind, format_name, format_version,
      count: (previous?.count ?? 0) + 1,
      last_detected_ts: latest ? previous.last_detected_ts : fact.observed_ts,
    });
  }
  return [...groups.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => value);
}
