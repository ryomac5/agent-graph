import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { openLedger } from "../../core/src/ledger/ledger.ts";
import type { FactInput } from "../../core/src/ledger/facts.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { createNativeId } from "../../core/src/ledger/projections/relations.ts";
import { projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { openObservationService } from "../../api/src/service/index.ts";
import { ProjectionFeed } from "../../api/src/service/projection-feed.ts";
import { startWebSocketServer, WebSocket } from "../../api/src/ws/index.ts";
import { FakeHost, type ResumeRequest } from "../src/host/contract.ts";
import { RunnerRuntime, serveRunner } from "../src/runtime.ts";

const TIMEOUT_MS = 5000;
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!check()) { assert.ok(Date.now() < deadline, "Timed out"); await delay(10); }
}
function createRepository(directory: string): void {
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "ignore" });
  execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "ignore" });
}
function makeMessage(id: string): FactInput {
  return { source: "host-claude", source_event_id: id, source_ts: new Date().toISOString(), confidence: "confirmed",
    kind: "message.created", subject: `message:${id}`, payload: { provider: "claude", native_id: id, role: "assistant", version: 1, body: id, body_state: "stored" } };
}

test("api cmd starts a host; patches and durable events survive api restart and command replay", { timeout: 15_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hosts-integration-"));
  const repo = join(directory, "repo"); createRepository(repo);
  const dbPath = join(directory, "ledger.db"), socketPath = join(directory, "runner.sock");
  const ledger = openLedger(dbPath);
  const host = new FakeHost();
  let runner: Awaited<ReturnType<typeof serveRunner>> | undefined;
  let service: ReturnType<typeof openObservationService> | undefined;
  let api: Awaited<ReturnType<typeof startWebSocketServer>> | undefined;
  t.after(async () => { await api?.close(); service?.close(); await runner?.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  try {
    runner = await serveRunner(ledger, socketPath, { hosts: [host] });
    async function openApi() {
      service = openObservationService({ dbPath });
      api = await startWebSocketServer(service, { port: 0, runnerPath: socketPath });
      await waitUntil(() => api!.runner.available);
      const snapshot = await fetch(`${api.url}/snapshot`, { headers: { "x-agent-graph-token": api.token } }).then((response) => response.json()) as { seq: number; generation: number };
      const socket = new WebSocket(`${api.wsUrl}?token=${api.token}`, { origin: api.url });
      const messages: any[] = [];
      socket.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      socket.send(JSON.stringify({ type: "hello", ...snapshot }));
      await new Promise<void>((resolve) => { socket.once("pong", resolve); socket.ping(); });
      return { socket, messages, async command(command: string, payload: object, cmd_id = command) {
        socket.send(JSON.stringify({ type: "cmd", command, payload, cmd_id }));
        await waitUntil(() => messages.some((message) => message.type === "ack" && message.cmd_id === cmd_id));
        const ack = messages.splice(messages.findIndex((message) => message.type === "ack" && message.cmd_id === cmd_id), 1)[0];
        assert.equal(ack.ok, true, ack.error); return ack.result;
      } };
    }
    const client = await openApi();
    const start = { runId: "r1", conversationId: "c1", provider: "claude", cwd: repo, input: { text: "hello" }, model: { model: "fake" } };
    await client.command("start", start, "stable");
    host.emit("r1", { type: "state", state: "running" });
    host.emit("r1", { type: "delta", text: "hello" });
    await waitUntil(() => client.messages.some((message) => message.type === "patch" && message.changes.runs?.upsert.some((run: any) => run.state === "running")));
    await waitUntil(() => client.messages.some((message) => message.type === "delta" && message.text === "hello"));
    assert.ok(projectEntityRecords<{ base_sha: string }>(ledger.readSince(0, 100), "run")[0].base_sha);
    await api!.close(); api = undefined; service!.close(); service = undefined;
    host.emit("r1", { type: "fact", fact: makeMessage("during-api-downtime") });
    host.emit("r1", { type: "state", state: "waiting_input" });
    await waitUntil(() => ledger.readSince(0, 100).some((fact) => fact.source_event_id === "during-api-downtime"));
    assert.equal(host.starts.length, 1);
    assert.equal(runner.runtime.supervisor.isOpen("r1"), true);
    const resumed = await openApi();
    await resumed.command("start", start, "stable");
    assert.equal(host.starts.length, 1);
    host.emit("r1", { type: "fact", fact: makeMessage("after-api-restart") });
    await waitUntil(() => resumed.messages.some((message) => message.type === "patch"
      && message.changes.messages?.upsert.some((row: any) => row.id === createNativeId("claude", "after-api-restart"))));
    const feed = new ProjectionFeed(dbPath, service!.catchUp);
    const projection = feed.snapshot().projection;
    assert.ok(projection.messages.some((message) => message.id === createNativeId("claude", "during-api-downtime")));
    assert.equal(projection.messages.length, 2);
    assert.equal(projection.runs[0].state, "waiting_input");
    service!.rebuild(); assert.equal(feed.refresh(), "resync"); assert.deepEqual(feed.snapshot().projection, projection);
    resumed.socket.send(JSON.stringify({ type: "hello", seq: feed.snapshot().seq, generation: feed.snapshot().generation }));
    await new Promise<void>((resolve) => { resumed.socket.once("pong", resolve); resumed.socket.ping(); });
    feed.close();
    await resumed.command("send", { runId: "r1", input: { text: "next" } });
    await resumed.command("set_model", { runId: "r1", model: { model: "other" } });
    await resumed.command("interrupt", { runId: "r1" });
    await resumed.command("close", { runId: "r1" });
    assert.equal(host.inputs[0].input.text, "next");
    assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "ended");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM" && "syscall" in error && error.syscall === "listen") t.skip("sandbox blocks local TCP/Unix socket listen");
    else throw error;
  }
});

test("message patches use native identity and restore downtime facts without sockets", () => {
  const directory = mkdtempSync(join(tmpdir(), "hosts-projection-"));
  const dbPath = join(directory, "ledger.db");
  const ledger = openLedger(dbPath);
  let service = openObservationService({ dbPath });
  let feed = new ProjectionFeed(dbPath, service.catchUp);
  try {
    ledger.append(makeMessage("before-api-restart"));
    const first = feed.refresh();
    assert.ok(first && first !== "resync");
    assert.equal(first.changes.messages.upsert[0].id, createNativeId("claude", "before-api-restart"));
    feed.close(); service.close();
    ledger.append(makeMessage("during-api-downtime"));
    service = openObservationService({ dbPath });
    feed = new ProjectionFeed(dbPath, service.catchUp);
    assert.ok(feed.snapshot().projection.messages.some((row) => row.id === createNativeId("claude", "during-api-downtime")));
    ledger.append(makeMessage("after-api-restart"));
    const patch = feed.refresh();
    assert.ok(patch && patch !== "resync");
    assert.equal(patch.changes.messages.upsert[0].id, createNativeId("claude", "after-api-restart"));
    const projection = feed.snapshot().projection;
    assert.equal(projection.messages.length, 3);
    service.rebuild();
    assert.equal(feed.refresh(), "resync");
    assert.deepEqual(feed.snapshot().projection, projection);
  } finally {
    feed.close(); service.close(); ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime records worktree, routes controls and safely adopts observed conversations", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-integration-")); createRepository(directory);
  const ledger = openLedger(join(directory, "ledger.db"));
  const host = new FakeHost();
  const runtime = new RunnerRuntime(ledger, [host], () => {});
  t.after(async () => { await runtime.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (command: string, payload: object) => runtime.command({ type: "req", cmd_id: command, command, payload: payload as any });
  t.mock.method(host, "resume", async (request: ResumeRequest) => ({ ...await host.start(request), nativeId: request.nativeId }));
  await runtime.recover();
  for (const id of ["stopped", "unknown", "unsupported"]) {
    ledger.append({ source: "transcript-claude", source_event_id: id, source_ts: "2026-01-01T00:00:00Z", confidence: "confirmed",
      kind: "conversation.created", subject: `conversation:${id}`, payload: { provider: "claude", native_id: `native-${id}`, origin: "observed", type: "interactive", history_format: id === "unsupported" ? "unknown" : "jsonl" } });
    ledger.append({ source: "hook", source_event_id: `run-${id}`, source_ts: "2026-01-01T00:00:01Z", confidence: "confirmed",
      kind: "run.created", subject: `run:external-${id}`, payload: { conversation_id: id, generation: 1, state: "unknown" } });
  }
  ledger.append({ source: "hook", source_event_id: "session-end", source_ts: "2026-01-01T00:00:02Z", confidence: "confirmed",
    kind: "run.state_changed", subject: "run:external-stopped", payload: { generation: 1, state: "ended", end_evidence: { kind: "session_end", generation: 1 } } });
  const payload = { cwd: directory, model: { model: "fake" }, input: { text: "continue" } };
  assert.deepEqual(await command("adopt", { ...payload, conversationId: "unknown" }), { confirmation_required: true, fallback: "fork" });
  assert.equal(host.starts.length, 0);
  await assert.rejects(command("resume", { ...payload, conversationId: "unknown" }), /Use adopt/);
  await assert.rejects(command("adopt", { ...payload, conversationId: "unsupported" }), /Unsupported/);
  const fork = await command("adopt", { ...payload, conversationId: "unknown", confirmStopped: false }) as any;
  assert.equal(fork.operation, "fork"); assert.notEqual(fork.conversationId, "unknown");
  const adopted = await command("adopt", { ...payload, conversationId: "stopped" }) as any;
  assert.equal(adopted.operation, "resume"); assert.equal(adopted.nativeId, "native-stopped"); assert.equal(adopted.generation, 2);
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.filter((fact) => fact.kind === "relation.created" && fact.payload?.type === "adopted").length, 2);
  ledger.append({ source: "host-claude", source_event_id: "approval", source_ts: new Date(Date.now() + 100).toISOString(), confidence: "confirmed",
    kind: "approval.created", subject: "approval:a1", payload: { run_id: adopted.runId, conversation_id: "stopped", state: "pending", request_id: "a1" } });
  await command("answer", { approvalId: "a1", decision: "allow" });
  assert.deepEqual(host.decisions, [{ approval: "a1", decision: "allow" }]);
  await command("send", { runId: `["claude","native-stopped"]:2`, input: { text: "canonical target" } });
  assert.equal(host.inputs.at(-1)?.run, adopted.runId);
  await command("close", { runId: adopted.runId });
  const resumed = await command("resume", { ...payload, conversationId: "stopped" }) as any;
  assert.equal(resumed.generation, 3);
});

test("controls resolve exact and native run IDs with bounded ledger reads amid large observed history", async (t) => {
  const HISTORY_RUN_COUNT = 1000;
  const HISTORY_MESSAGE_COUNT = 20_000;
  const directory = mkdtempSync(join(tmpdir(), "runtime-large-ledger-")); createRepository(directory);
  const ledger = openLedger(":memory:");
  const host = new FakeHost();
  const runtime = new RunnerRuntime(ledger, [host], () => {});
  t.after(async () => { await runtime.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  for (let index = 0; index < HISTORY_RUN_COUNT; index++) {
    const id = `history-${index}`;
    // 先頭に会話の欠落と不完全な識別情報を置く。
    if (index > 0) ledger.append({ source: "transcript-claude", source_event_id: `c-${id}`, source_ts: "2026-01-01T00:00:00Z",
      confidence: "confirmed", kind: "conversation.created", subject: `conversation:${id}`,
      payload: { provider: "claude", native_id: index === 1 ? "" : id, origin: "observed", type: "interactive", history_format: "jsonl" } });
    ledger.append({ source: "hook", source_event_id: `r-${id}`, source_ts: "2026-01-01T00:00:01Z", confidence: "confirmed",
      kind: "run.created", subject: `run:${id}`, payload: { conversation_id: id, generation: 1, state: "unknown" } });
  }
  for (let index = 0; index < HISTORY_MESSAGE_COUNT; index++) ledger.append(makeMessage(`history-message-${index}`));
  const command = (command: string, payload: object) => runtime.command({ type: "req", cmd_id: command, command, payload: payload as any });
  const exactId = `["codex","absent-thread"]:7`;
  const nativeRunId = 'z-native:with-"quote"';
  for (const runId of [exactId, nativeRunId]) await command("start", {
    runId, conversationId: `conversation-${runId}`, provider: "claude", cwd: directory, model: { model: "fake" }, input: { text: "start" },
  });
  const reads = t.mock.method(ledger, "readSince");
  const fullReadCount = () => reads.mock.calls.filter((call) => call.arguments[0] === 0 && call.arguments[1] === Number.MAX_SAFE_INTEGER).length;
  for (const target of ["missing-run", '[broken]:1', '["claude","missing"]:1', `${createNativeId("claude", nativeRunId)}:2`]) {
    reads.mock.resetCalls();
    await assert.rejects(command("send", { runId: target, input: { text: "missing" } }), /Run is not open/);
    assert.equal(fullReadCount(), 1);
  }
  for (const [target, runId] of [[exactId, exactId], [`${createNativeId("claude", nativeRunId)}:1`, nativeRunId]]) {
    for (const operation of ["send", "interrupt", "set_model", "close"]) {
      reads.mock.resetCalls();
      assert.deepEqual(await command(operation, { runId: target, input: { text: target }, model: { model: "other" } }), { runId });
      // モデル変更の追記だけは、時刻決定のためにもう一度読む。
      assert.equal(fullReadCount(), operation === "set_model" ? 2 : 1, `${operation}: ${target}`);
      if (operation === "send") assert.deepEqual(host.inputs.at(-1), { run: runId, input: { text: target } });
      if (operation === "set_model") assert.equal(host.starts.find((start) => start.runId === runId)?.model.model, "other");
    }
    assert.equal(runtime.supervisor.isOpen(runId), false);
  }
});

test("runtime startup joins Codex from saved settings, keeps Claude unknown and expires approvals", async (t) => {
  const ledger = openLedger(":memory:");
  const claude = new FakeHost("claude"), codex = new FakeHost("codex");
  for (const provider of ["claude", "codex"] as const) {
    ledger.append({ source: `host-${provider}`, source_event_id: `c-${provider}`, source_ts: "2026-01-01T00:00:00Z", confidence: "confirmed",
      kind: "conversation.created", subject: `conversation:${provider}`, payload: { provider, native_id: `native-${provider}`, origin: "managed", type: "interactive", history_format: "jsonl" } });
    ledger.append({ source: `host-${provider}`, source_event_id: `r-${provider}`, source_ts: "2026-01-01T00:00:01Z", confidence: "confirmed",
      kind: "run.created", subject: `run:${provider}`, payload: { conversation_id: provider, generation: 1, state: "running" } });
    ledger.append({ source: `host-${provider}`, source_event_id: `launch-${provider}`, source_ts: "2026-01-01T00:00:02Z", confidence: "confirmed",
      kind: "run.updated", subject: `run:${provider}`, payload: { launch: { cwd: "/tmp", model: { model: "fake" } } } } as FactInput);
    ledger.append({ source: `host-${provider}`, source_event_id: `approval-${provider}`, source_ts: "2026-01-01T00:00:03Z", confidence: "confirmed",
      kind: "approval.created", subject: `approval:${provider}`, payload: { run_id: provider, conversation_id: provider, state: "pending", request_id: provider } });
  }
  t.mock.method(codex, "resume", async (request: ResumeRequest) => ({ ...await codex.start(request), nativeId: request.nativeId }));
  const runtime = new RunnerRuntime(ledger, [claude, codex], () => {});
  t.after(async () => { await runtime.close(); ledger.close(); });
  await runtime.recover();
  assert.equal(claude.starts.length, 0); assert.equal(codex.starts.length, 1);
  assert.equal(codex.starts[0].cwd, "/tmp"); assert.deepEqual(codex.starts[0].model, { model: "fake" });
  assert.deepEqual(codex.starts[0].input, { text: "" });
  const status = await runtime.command({ type: "req", cmd_id: "status", command: "status" }) as any;
  assert.equal(status.recovery[0].conversationId, "claude");
  assert.ok(ledger.readSince(0, 100).filter((fact) => fact.kind === "approval.resolved").every((fact) => fact.payload?.state === "expired"));
  codex.emit("codex", { type: "state", state: "idle" });
  await waitUntil(() => projectRuns(ledger.readSince(0, 100)).find((run) => run.conversation_id === "codex")?.state === "idle");
  assert.equal(projectRuns(ledger.readSince(0, 100)).find((run) => run.conversation_id === "claude")?.state, "unknown");
});

test("enabled Claude fork fixes a new native ID and integration trial options reach the SDK", async (t) => {
  const { ClaudeHost } = await import("../src/hosts/claude/index.ts");
  const { AsyncQueue } = await import("../src/hosts/claude/queue.ts");
  const output = new AsyncQueue<import("@anthropic-ai/claude-agent-sdk").SDKMessage>();
  let options: import("@anthropic-ai/claude-agent-sdk").Options | undefined;
  const host = new ClaudeHost((args) => {
    options = args.options;
    void (async () => { for await (const _input of args.prompt) { /* 入力を消費し、実機は呼ばない。 */ } })();
    return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt: async () => undefined, setModel: async () => {}, supportedModels: async () => [],
      accountInfo: async () => ({ subscriptionType: "test", apiProvider: "firstParty" }), close: () => output.end() };
  }, { enableFork: true });
  t.after(() => host.close("fork-run"));
  const handle = await host.fork({ runId: "fork-run", conversationId: "fork-conversation", generation: 1,
    nativeId: "original-native", cwd: "/tmp", model: { model: "haiku" }, input: { text: "continue" },
    integrationMode: "strict" });
  assert.equal(host.capabilities().fork, true);
  assert.equal(options?.forkSession, true); assert.equal(options?.resume, "original-native");
  assert.equal(options?.sessionId, handle.nativeId); assert.notEqual(handle.nativeId, "original-native");
  assert.equal(options?.strictMcpConfig, true); assert.deepEqual(options?.mcpServers, {});
  assert.equal(options?.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("runtime validates integrationMode, passes it to the host and keeps it for resume", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-integration-mode-")); createRepository(directory);
  const ledger = openLedger(join(directory, "ledger.db"));
  const host = new FakeHost();
  const runtime = new RunnerRuntime(ledger, [host], () => {});
  t.after(async () => { await runtime.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (command: string, payload: object) => runtime.command({ type: "req", cmd_id: command, command, payload: payload as any });
  t.mock.method(host, "resume", async (request: ResumeRequest) => ({ ...await host.start(request), nativeId: request.nativeId }));
  await runtime.recover();
  const payload = { provider: "claude", cwd: directory, model: { model: "fake" }, input: { text: "go" } };
  await assert.rejects(command("start", { ...payload, integrationMode: "all" }), /Invalid integrationMode/);
  await command("start", { ...payload, runId: "plain", conversationId: "plain" });
  assert.equal(host.starts.at(-1)?.integrationMode, undefined);
  await command("start", { ...payload, runId: "enabled", conversationId: "enabled", integrationMode: "enabled" });
  assert.equal(host.starts.at(-1)?.integrationMode, "enabled");
  host.emit("enabled", { type: "exit", exitCode: 0 });
  await waitUntil(() => projectRuns(ledger.readSince(0, 1000)).some((run) => run.conversation_id === "enabled" && run.state === "ended"));
  await command("resume", { conversationId: "enabled", input: { text: "again" } });
  assert.equal(host.starts.at(-1)?.integrationMode, "enabled");
  host.emit("plain", { type: "exit", exitCode: 0 });
  for (const request of host.starts.slice(-1)) host.emit(request.runId, { type: "exit", exitCode: 0 });
});
