import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Fact, FactInput, JsonValue } from './facts.ts';
import { captureNativeRecord } from '../state/capture.ts';

type Row = Record<string, JsonValue>;
type Entry = [string, string, string | null, string | null, Row];
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
export const NATIVE_EVIDENCE_BATCH_SIZE = 128;

/** 原記録の本文は保存範囲によらず落とす。判定用の印と連鎖は本文の保持期限で失わせない。 */
export function retainNativeMetadata(value: Row): Row | undefined {
  if (value.native_source !== 'claude' && value.native_source !== 'codex') return;
  const source = value.native_source;
  const common = { native_source: source, ...(value.file_id !== undefined ? { file_id: value.file_id } : {}),
    ...(value.turn_id !== undefined ? { turn_id: value.turn_id } : {}) };
  let retained: Row | undefined;
  if (value.native_record) retained = { ...common, native_record: captureNativeRecord(source, object(value.native_record)) ?? {} };
  const archive = object(value.native_archive);
  if (archive.format === 'tuples-v1') retained = { ...common, native_archive: { format: 'tuples-v1',
    entries: (archive.entries as Entry[]).map(([id, at, observed, cursor, row]) =>
      [id, at, observed, cursor, captureNativeRecord(source, row) ?? {}]),
  } };
  return isDeepStrictEqual(value, retained) ? value : retained;
}

/** 共通の実行・出所・ファイルを一度だけ持つ可逆な圧縮。古い行も時刻と識別子を失わない。 */
export function packNativeEvidence(inputs: readonly FactInput[]): FactInput {
  if (inputs.length === 1) return inputs[0];
  const first = inputs[0];
  const last = object(object(first.payload).last_evidence);
  const latest = [...inputs].sort((a, b) => Date.parse(a.source_ts) - Date.parse(b.source_ts) || a.source_event_id.localeCompare(b.source_event_id)).at(-1)!;
  const entries: Entry[] = inputs.map(input => [input.source_event_id, input.source_ts,
    input.observed_ts === latest.observed_ts ? null : input.observed_ts!, input.cursor ?? null,
    object(object(object(input.payload).last_evidence).native_record)]);
  const id = createHash('sha256').update(JSON.stringify(entries.map(entry => entry[0]).sort())).digest('hex');
  return { ...latest, source_event_id: `native-record:batch:${id}`,
    payload: { ...latest.payload, last_evidence: { native_source: last.native_source, file_id: last.file_id,
      native_archive: { format: 'tuples-v1', entries } } } } as FactInput;
}

export function isNativeArchive(fact: Fact | FactInput): boolean {
  return object(object(object(fact.payload).last_evidence).native_archive).format === 'tuples-v1';
}

/** まとめた事実全体への訂正は、その中の証拠も置き換える。 */
export function expandNativeEvidenceSet(facts: readonly Fact[]): Fact[] {
  const superseded = new Set(facts.flatMap(fact => fact.supersedes ? [fact.supersedes] : []));
  return facts.flatMap(fact => isNativeArchive(fact) && superseded.has(fact.fact_id) ? [] : expandNativeEvidence(fact));
}

/** 台帳の行は変更せず、判定と投影へ渡すときだけ元の証拠の識別と時刻を復元する。 */
export function expandNativeEvidence(fact: Fact): Fact[] {
  const last = object(object(fact.payload).last_evidence);
  const archive = object(last.native_archive);
  if (archive.format !== 'tuples-v1') return [fact];
  return (archive.entries as Entry[]).map(([id, at, observed, cursor, row]) => ({ ...fact,
    fact_id: createHash('sha256').update(JSON.stringify([fact.source, id])).digest('hex'),
    source_event_id: id, source_ts: at, observed_ts: observed ?? fact.observed_ts, cursor,
    payload: { ...fact.payload, last_evidence_ts: at,
      last_evidence: { native_source: last.native_source, file_id: last.file_id, native_record: row } },
  } as Fact));
}
