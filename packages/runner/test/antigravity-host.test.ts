import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AntigravityHost } from "../src/hosts/antigravity/index.ts";
import type { HostEvent } from "../src/host/contract.ts";
import { openLedger } from "../../core/src/ledger/index.ts";
import { RunnerRuntime } from "../src/runtime.ts";
import { readProjection } from "../src/projection.ts";

test("Antigravity runs agy in a sandbox and records a final proofreading message with exit evidence", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agy-host-"));
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "base"], { cwd: directory });
  const binary = join(directory, "agy");
  writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n'); chmodSync(binary, 0o700);
  const host = new AntigravityHost(binary);
  const ledger = openLedger(join(directory, "ledger.db"), { storageScope: "full_diff" });
  const runtime = new RunnerRuntime(ledger, [host], () => {});
  t.after(async () => { await runtime.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(host.capabilities().resume, false);
  await runtime.supervisor.start("antigravity", { runId: "proofread", conversationId: "proofread-conversation", generation: 1, cwd: directory,
    input: { text: "日本語を校正してください" }, model: { model: "gemini-3.8-flash-high", effort: "high" } });
  await runtime.supervisor.wait("proofread");
  const projection = readProjection(ledger);
  assert.equal(projection.record<{ state: string }>("run", "proofread")?.state, "ended");
  const message = projection.messages("proofread-conversation")[0];
  const args = JSON.parse(message.body as string) as string[];
  assert.deepEqual(args, ["--print", "日本語を校正してください", "--model", "gemini-3.8-flash-high", "--sandbox", "--mode", "plan", "--output-format", "text", "--effort", "high"]);
  assert.equal(message.phase, "final_answer");
  assert.equal(projection.conversation<{ provider: string }>("proofread-conversation")?.provider, "antigravity");
});
test("Antigravity executable failures close the stream as failures", async () => {
  const host = new AntigravityHost("/nonexistent/agy");
  const handle = await host.start({ runId: "missing", conversationId: "missing", generation: 1, cwd: tmpdir(), input: { text: "Proofread" }, model: { model: "gemini" } });
  const events: HostEvent[] = [];
  for await (const event of handle.events) events.push(event);
  assert.ok(events.some(event => event.type === "exit" && event.exitCode !== 0));
});
