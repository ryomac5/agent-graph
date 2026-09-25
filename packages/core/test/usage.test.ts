import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readCodexUsage } from "../src/usage/codex.ts";
import { probeClaudeUsage } from "../src/usage/claude.ts";

test("Codex は最新ファイルの最後の有効な利用枠を読む", (t) => {
  const home = mkdtempSync(join(tmpdir(), "usage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const day = join(home, ".codex/sessions/2026/09/25");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "a.jsonl"), JSON.stringify({ payload: { rate_limits: {
    primary: { used_percent: 1, window_minutes: 60 },
  } } }) + "\n");
  copyFileSync(new URL("fixtures/usage/codex.jsonl", import.meta.url), join(day, "b.jsonl"));
  assert.deepEqual(readCodexUsage({ home }), [
    { ts: "2026-09-25T00:00:00Z", provider: "openai", window: "300m", percent: 40,
      resetsAt: "2026-09-25T00:00:00.000Z" },
    { ts: "2026-09-25T00:00:00Z", provider: "openai", window: "10080m", percent: 20,
      resetsAt: "2026-09-26T00:00:00.000Z" },
  ]);
});

function fakeSpawn(response?: string): { spawnImpl: any; stdin: PassThrough } {
  const stdin = new PassThrough();
  const spawnImpl = () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough;
      stderr: PassThrough; kill: () => void };
    child.stdin = stdin;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.emit("close", null); };
    if (response !== undefined) setImmediate(() => {
      child.stdout.end(response + "\n");
      child.emit("close", 0);
    });
    return child;
  };
  return { spawnImpl, stdin };
}

test("Claude の既知・未知の応答とタイムアウト", async () => {
  const valid = fakeSpawn(JSON.stringify({ type: "control_response", response: { response: { rate_limits: {
    five_hour: { utilization: 30 }, seven_day: { utilization: 40 },
    model_scoped: [{ display_name: "Fable", utilization: 50, resets_at: "2026-09-25T01:00:00Z" },
      { display_name: "", utilization: 60 }],
  } } } }));
  const samples = await probeClaudeUsage({ cwd: "/tmp", timeoutMs: 1000, spawnImpl: valid.spawnImpl });
  assert.deepEqual(samples.map(({ window, percent, model }) => [window, percent, model]), [
    ["5h", 30, undefined], ["7d", 40, undefined], ["7d", 50, "Fable"],
  ]);
  assert.equal(samples[2]?.resetsAt, "2026-09-25T01:00:00.000Z");
  assert.match(valid.stdin.read()?.toString() ?? "", /get_usage/);
  assert.deepEqual(await probeClaudeUsage({ cwd: "/tmp", timeoutMs: 1000,
    spawnImpl: fakeSpawn('{"unknown":true}').spawnImpl }), []);
  assert.deepEqual(await probeClaudeUsage({ cwd: "/tmp", timeoutMs: 1,
    spawnImpl: fakeSpawn().spawnImpl }), []);
});
