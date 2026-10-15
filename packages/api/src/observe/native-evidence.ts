import { NATIVE_EVIDENCE_BATCH_SIZE, packNativeEvidence } from '../../../core/src/ledger/native-evidence.ts';
import type { FactInput } from '../../../core/src/ledger/facts.ts';

/** 一度の読み取り内でまとめて追記する。cursor の進行前に必ず flush し、未保存の行を次の周期へ持ち越さない。 */
export function createNativeEvidenceBuffer(known: ReadonlySet<string>, append: (input: FactInput) => void) {
  const pending = new Map<string, FactInput[]>();
  const seen = new Set<string>();
  function flushGroup(key: string, inputs: FactInput[]) {
    append(packNativeEvidence(inputs));
    pending.delete(key);
  }
  return {
    add(input: FactInput) {
      // event ID はファイル・offset・原行のハッシュを含む。読み取りの区切りが変わっても再追記しない。
      if (known.has(input.source_event_id) || seen.has(input.source_event_id)) return;
      seen.add(input.source_event_id);
      // 配達の照合は queue の原記録を直接引く。相関証拠は独立した行として保つ。
      const payload = input.payload as Record<string, unknown>;
      const last = payload.last_evidence as { native_record?: { attachment?: { type?: string } } } | undefined;
      if (last?.native_record?.attachment?.type === 'queued_command') { append(input); return; }
      const key = JSON.stringify([input.subject, payload.conversation_id, payload.generation]);
      const inputs = pending.get(key) ?? [];
      inputs.push(input); pending.set(key, inputs);
      if (inputs.length === NATIVE_EVIDENCE_BATCH_SIZE) flushGroup(key, inputs);
    },
    flush() { for (const [key, inputs] of pending) flushGroup(key, inputs); },
  };
}
