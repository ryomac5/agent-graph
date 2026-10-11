import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AntigravityHost } from "../src/hosts/antigravity/index.ts";
import type { HostEvent } from "../src/host/contract.ts";
import { openLedger } from "../../core/src/ledger/index.ts";
import { RunnerRuntime } from "../src/runtime.ts";
import { readProjection } from "../src/projection.ts";
import { defaultPolicy } from "../../core/src/assign/policy.ts";
import { Intake } from "../src/intake/index.ts";
import { McpProtocol } from "../src/mcp/index.ts";
import { RunnerProtocol } from "../src/socket.ts";
import { messages, pair, until } from "./samples/S13/fixture.ts";

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

for (const role of ["proofread", "document", "implement", "research", "review", "verify", "advisor", "orchestrate"] as const) {
  test(`Antigravity selects permissions for ${role}`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "agy-args-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const binary = join(directory, "agy");
    writeFileSync(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    chmodSync(binary, 0o700);
    const handle = await new AntigravityHost(binary).start({ runId: role, conversationId: role, generation: 1, cwd: directory,
      role, input: { text: "Edit the document" }, model: { model: "gemini", effort: "high" } });
    const events: HostEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const output = events.filter(event => event.type === "delta").map(event => event.text).join("");
    const args = JSON.parse(output) as string[];
    const edits = role === "proofread" || role === "document";
    assert.deepEqual(args, ["--print", edits ? "コマンドは実行できない。ファイルを読み、直すだけにする。受け入れの検査は呼び手が走らせる。\n\nEdit the document" : "Edit the document",
      "--model", "gemini", "--sandbox", "--mode", edits ? "accept-edits" : "plan", "--output-format", "text", "--effort", "high"]);
    assert.ok(events.some(event => event.type === "exit" && event.exitCode === 0));
  });
}

for (const change of ["none", "new", "dirty", "delete"] as const) {
  test(`empty exit zero checks ${change} file changes and preserves stderr tail`, async t => {
    const directory = mkdtempSync(join(tmpdir(), "agy-empty-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(join(directory, "dirty.txt"), "base");
    execFileSync("git", ["add", "dirty.txt"], { cwd: directory });
    writeFileSync(join(directory, "dirty.txt"), "already dirty");
    const binary = join(directory, "agy");
    const action = change === "new" ? 'fs.writeFileSync("hello.txt", "hello")'
      : change === "dirty" ? 'fs.writeFileSync("dirty.txt", "corrected")'
      : change === "delete" ? 'fs.unlinkSync("dirty.txt")' : '';
    const diagnostic = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    writeFileSync(binary, `#!/usr/bin/env node\nconst fs = require("node:fs");\n${action};\nprocess.stdout.write(" \\n");\nprocess.stderr.write("x".repeat(5000) + ${JSON.stringify(diagnostic)});\n`);
    chmodSync(binary, 0o700);
    const handle = await new AntigravityHost(binary).start({ runId: change, conversationId: change, generation: 1, cwd: directory,
      role: "proofread", input: { text: "Correct wording" }, model: { model: "gemini" } });
    const events: HostEvent[] = [];
    for await (const event of handle.events) events.push(event);
    const exit = events.find(event => event.type === "exit");
    assert.ok(exit?.type === "exit");
    assert.equal(exit.exitCode, change === "none" ? 1 : 0);
    if (change === "none") {
      assert.ok(exit.cause?.endsWith(diagnostic));
      assert.ok(exit.cause && exit.cause.length < 4300);
    } else assert.equal(exit.cause, undefined);
  });
}

test("fake agy empty success becomes a failed run with a cause in MCP wait", async t => {
  const directory = mkdtempSync(join(tmpdir(), "agy-intake-"));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base"], { cwd });
  const binary = join(directory, "agy");
  const diagnostic = 'jetski: no output produced — command permission auto-denied';
  writeFileSync(binary, `#!/usr/bin/env node\nconst assert = require("node:assert/strict");\nconst args = process.argv.slice(2);\nassert.equal(args[args.indexOf("--mode") + 1], "accept-edits");\nassert.ok(args[1].startsWith("コマンドは実行できない。"));\nprocess.stderr.write(${JSON.stringify(diagnostic)});\n`);
  chmodSync(binary, 0o700);
  const ledger = openLedger(join(directory, "ledger.db"));
  let protocol: McpProtocol;
  const publish = () => protocol?.publish();
  const runtime = new RunnerRuntime(ledger, [new AntigravityHost(binary)], publish, "shared");
  const intake = new Intake(ledger, runtime, { cwd, publish, decision: { policy: defaultPolicy(), quota: () => undefined, performance: () => undefined } });
  protocol = new McpProtocol(intake, new RunnerProtocol(request => intake.command(request)));
  const [client, server] = pair(); protocol.attach(server);
  t.after(async () => { protocol.disconnect(); await intake.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const replies = messages(client);
  const send = (id: string, name: string, args: unknown) => client.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  client.write(JSON.stringify({ type: "hello", role: "mcp", version: 1 }) + "\n");
  const request = { requestId: "empty-agy", source: "mcp", role: "proofread", title: "Correct wording", task: "Correct wording", accept: [], cwd };
  send("delegate", "delegate", request);
  await until(() => replies.some(r => r.id === "delegate"));
  send("wait", "wait", { requestId: request.requestId });
  await until(() => replies.some(r => r.id === "wait"));
  const status = replies.find(r => r.id === "wait").result.structuredContent;
  assert.equal(status.state, "failed");
  assert.ok(status.reason.endsWith(diagnostic));
  const run = readProjection(ledger).rows("runs")[0];
  assert.equal(run.state, "failed");
  assert.equal(run.cause, status.reason);
  send("resend", "delegate", request);
  await until(() => replies.some(r => r.id === "resend"));
  assert.equal(replies.find(r => r.id === "resend").result.structuredContent.reason, status.reason);
});
