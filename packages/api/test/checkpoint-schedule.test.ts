import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpointSchedule, CHECKPOINT_MAX_MS } from "../src/service/checkpoint-schedule.ts";

test("100 ms 未満で seq が変わり続け、投影が遅れても 30 秒ごとに整理する", () => {
  const schedule = createCheckpointSchedule(1000);
  const checkpoints: number[] = [];
  for (let now = 0; now <= CHECKPOINT_MAX_MS * 3; now += 25) {
    const seq = now / 25;
    if (schedule(seq, seq - 1, now)) checkpoints.push(now);
  }
  assert.deepEqual(checkpoints, [CHECKPOINT_MAX_MS, CHECKPOINT_MAX_MS * 2, CHECKPOINT_MAX_MS * 3]);
});

test("投影の完了から 100 ms 待ち、待機時の整理は一秒以上空ける", () => {
  const schedule = createCheckpointSchedule(1000);
  assert.equal(schedule(1, 1, 900), false);
  assert.equal(schedule(1, 1, 999), false);
  assert.equal(schedule(1, 1, 1000), true);
  assert.equal(schedule(1, 1, 1999), false);
  assert.equal(schedule(1, 1, 2000), true);
  assert.equal(schedule(2, 1, 3000), false);
  assert.equal(schedule(2, 2, 3100), false);
  assert.equal(schedule(2, 2, 3200), true);
});
