const CHECKPOINT_SETTLE_MS = 100;
export const CHECKPOINT_MAX_MS = 30_000;

// 連続追記でも期限で整理し、短い停止では投影の完了を待つ。
export function createCheckpointSchedule(minimumInterval: number) {
  let candidate: number | undefined;
  let candidateTime = 0;
  let checkpointTime = 0;
  return (seq: number, projectionSeq: number, now: number): boolean => {
    if (projectionSeq !== seq) candidate = undefined;
    else if (candidate !== seq) { candidate = seq; candidateTime = now; }
    const due = now - checkpointTime >= CHECKPOINT_MAX_MS;
    const settled = candidate === seq && now - candidateTime >= CHECKPOINT_SETTLE_MS
      && now - checkpointTime >= minimumInterval;
    if (!due && !settled) return false;
    checkpointTime = now;
    return true;
  };
}
