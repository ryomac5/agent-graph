import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { AccountInfo, CanUseTool, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HostEvent, RunHandle, StartRequest } from "../src/host/contract.ts";
import { ClaudeHost, type ClaudeQuery, type QueryFactory } from "../src/hosts/claude/index.ts";
import { AsyncQueue } from "../src/hosts/claude/queue.ts";

class FakeQuery implements ClaudeQuery {
  messages = new AsyncQueue<SDKMessage>();
  inputs: SDKUserMessage[] = [];
  options: Options;
  modelChanges: string[] = [];
  closed = false;
  streamError?: Error;
  onInterrupt: () => void = () => {};
  inputReader: Promise<void>;
  account: AccountInfo = { subscriptionType: "Claude Team", apiProvider: "firstParty", email: "private@example.com", organization: "private" };
  constructor(args: Parameters<QueryFactory>[0]) {
    this.options = args.options;
    this.inputReader = (async () => { for await (const input of args.prompt) this.inputs.push(input); })();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    yield* this.messages;
    if (this.streamError) throw this.streamError;
  }
  emit(message: object): void { this.messages.push(message as SDKMessage); }
  async interrupt(): Promise<undefined> { this.onInterrupt(); return undefined; }
  async setModel(model?: string): Promise<void> { this.modelChanges.push(model!); }
  close(): void { this.closed = true; this.messages.end(); }
  async accountInfo(): Promise<AccountInfo> { return this.account; }
  async supportedModels() { return [{ value: "haiku", displayName: "Haiku", description: "Fast" }]; }
  async ask(name = "Write", input = { file_path: "/tmp/output", content: "text" }, extra: Partial<Parameters<CanUseTool>[2]> = {}) {
    const result = await this.options.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1", ...extra });
    assert.ok(result);
    return result;
  }
}
function makeRequest(runId = "run-1", conversationId = "conversation-1"): StartRequest {
  return { runId, conversationId, generation: 1, cwd: "/tmp", input: { text: "Hello" }, model: { model: "haiku" } };
}
function createFixture(configure: (query: FakeQuery) => void = () => {}) {
  const queries: FakeQuery[] = [];
  const host = new ClaudeHost((args) => {
    const query = new FakeQuery(args);
    configure(query);
    queries.push(query);
    return query;
  });
  return { host, queries };
}
function collect(handle: RunHandle) {
  const events: HostEvent[] = [];
  const done = (async () => { for await (const event of handle.events) events.push(event); })();
  return { events, done };
}
async function flush(): Promise<void> { await setImmediate(); }
function getFacts(events: HostEvent[]) { return events.filter((event) => event.type === "fact").map((event) => event.fact); }
function getApproval(events: HostEvent[]): string {
  const approval = getFacts(events).find((fact) => fact.kind === "approval.created");
  assert.ok(approval);
  return approval.subject.slice("approval:".length);
}
function emitResult(query: FakeQuery, error = false, errors = ["Execution failed"], turnId?: string) {
  query.emit({ type: "result", subtype: error ? "error_during_execution" : "success", is_error: error,
    session_id: query.options.sessionId ?? query.options.resume, uuid: "result-1", user_message_uuid: turnId,
    ...(error ? { errors } : { result: "Done" }), usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: {}, total_cost_usd: 0.01 });
}

test("Claude opens one streaming query with managed environment, auth and state mapping", async () => {
  const { host, queries } = createFixture();
  const req = { ...makeRequest(), env: { AGENT_GRAPH_MANAGED: "0", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "0" } };
  const handle = await host.start(req);
  const { events, done } = collect(handle);
  const query = queries[0];
  await flush();
  assert.equal(query.options.sessionId, handle.nativeId);
  assert.match(handle.nativeId, /^[\da-f-]{36}$/);
  assert.deepEqual(query.options.settingSources, ["user", "project"]);
  assert.equal(query.options.permissionMode, "default");
  assert.equal(query.options.includePartialMessages, true);
  assert.equal(query.options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
  assert.equal(query.options.env?.AGENT_GRAPH_MANAGED, "1");
  assert.equal(query.options.env?.AGENT_GRAPH_RUN_ID, req.runId);
  assert.equal(query.options.env?.AGENT_GRAPH_CONVERSATION_ID, req.conversationId);
  assert.equal(query.inputs[0].session_id, handle.nativeId);
  assert.equal(query.inputs[0].message.content, "Hello");
  query.emit({ type: "system", subtype: "init", session_id: handle.nativeId, apiKeySource: "none", mcp_servers: [{ name: "calendar", status: "connected" }] });
  for (const state of ["running", "requires_action", "idle"]) query.emit({ type: "system", subtype: "session_state_changed", state });
  emitResult(query);
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "state").slice(-3).map((event) => event.state), ["running", "waiting_approval", "idle"]);
  assert.deepEqual(host.capabilities().authentication, { type: "subscription", verified: true, subscriptionType: "Claude Team", apiProvider: "firstParty" });
  assert.ok(!JSON.stringify(host.capabilities()).includes("private"));
  assert.ok(JSON.stringify(getFacts(events)).includes("calendar"));
  assert.ok(!host.capabilities().degraded?.includes("session_state_events_unavailable"));
  await host.send(req.runId, { text: "Again" });
  await flush();
  assert.equal(queries.length, 1);
  assert.equal(query.inputs[1].message.content, "Again");
  assert.ok(!query.closed);
  await assert.rejects(host.start(makeRequest("run-2")), /already open/);
  await host.close(req.runId);
  await done;
});

test("Claude maps text deltas and completed messages including integration authorization text", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  query.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } });
  query.emit({ type: "assistant", uuid: "assistant-1", session_id: handle.nativeId, message: { content: [{ type: "text", text: "Authorize Calendar to connect." }] } });
  await flush();
  assert.ok(events.some((event) => event.type === "delta" && event.text === "Hello"));
  assert.ok(getFacts(events).some((fact) => fact.kind === "message.created" && JSON.stringify(fact.payload.body).includes("Authorize Calendar")));
  assert.ok(getFacts(events).some((fact) => fact.kind === "message_membership.created" && fact.payload.conversation_id === "conversation-1"));
  assert.equal(events.filter((event) => event.type === "state").length, 1);
  await host.close("run-1");
  await done;
});

test("Claude approval waits for answer, returns updated input and forwards deny text", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  let answered = false;
  const permission = query.ask().then((value) => { answered = true; return value; });
  await flush();
  assert.equal(answered, false);
  const id = getApproval(events);
  await host.answer(id, { decision: "allow", updatedInput: { content: "updated" } });
  assert.deepEqual(await permission, { behavior: "allow", updatedInput: { content: "updated" } });
  await assert.rejects(host.answer(id, "allow"), /expired/);
  const denied = query.ask();
  await flush();
  const lastApproval = getFacts(events).filter((fact) => fact.kind === "approval.created").at(-1)!;
  await host.answer(lastApproval.subject.slice(9), "Do not write outside this repository.");
  assert.deepEqual(await denied, { behavior: "deny", message: "Do not write outside this repository." });
  await flush();
  assert.equal(getFacts(events).filter((fact) => fact.kind === "approval.answered").length, 2);
  assert.equal(getFacts(events).filter((fact) => fact.kind === "approval.resolved").length, 2);
  await host.close("run-1");
  await done;
});

test("Claude rejects subscription MCP tools without inbox requests and routes other sources to approval", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  const result = await query.ask("mcp__calendar__read", undefined, { mcpServer: { name: "calendar", source: "claudeai" } });
  assert.equal(result.behavior, "deny");
  await flush();
  assert.equal(getFacts(events).filter((fact) => fact.kind === "approval.created").length, 0);
  for (const source of [undefined, "user", "plugin", "sdk"]) {
    let answered = false;
    const count = getFacts(events).filter((fact) => fact.kind === "approval.created").length;
    const permission = query.ask("mcp__graph__delegate", undefined, { mcpServer: source ? { name: "graph", source } : undefined })
      .then((value) => { answered = true; return value; });
    await flush();
    assert.equal(answered, false);
    const approvals = getFacts(events).filter((fact) => fact.kind === "approval.created");
    assert.equal(approvals.length, count + 1);
    await host.answer(approvals.at(-1)!.subject.slice("approval:".length), "allow");
    assert.equal((await permission).behavior, "allow");
  }
  await host.close("run-1");
  await done;
});

test("Claude records interrupt before SDK call, expires approvals and returns idle for error result", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  await flush();
  const permission = query.ask();
  await flush();
  const approval = getApproval(events);
  query.onInterrupt = () => {
    // SDK が同期的に結果を返しても、中断の事実が先に並ぶ。
    emitResult(query, true, ["[ede_diagnostic] result_type=user"], query.inputs[0].uuid);
  };
  await host.interrupt("run-1");
  assert.equal((await permission).behavior, "deny");
  await flush();
  const facts = getFacts(events);
  const requestIndex = facts.findIndex((fact) => fact.kind === "run.interrupt_requested");
  const resultIndex = facts.findIndex((fact) => fact.kind === "run.updated" && JSON.stringify(fact.payload).includes("interrupted"));
  assert.ok(requestIndex >= 0 && resultIndex > requestIndex);
  assert.ok(events.some((event) => event.type === "state" && event.state === "idle" && event.reason === "interrupted"));
  assert.ok(!events.some((event) => event.type === "exit"));
  await assert.rejects(host.answer(approval, "allow"), /expired/);
  await host.send("run-1", { text: "Next turn" });
  await flush();
  emitResult(query, true, ["Real failure"], query.inputs[1].uuid);
  await done;
  assert.ok(events.some((event) => event.type === "exit" && event.exitCode === 1 && event.cause === "Real failure"));
  await host.close("run-1");
});

test("Claude failures use result body and missing state events expose degraded fallback", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  emitResult(queries[0]);
  await flush();
  assert.ok(host.capabilities().degraded?.includes("session_state_events_unavailable"));
  assert.ok(events.some((event) => event.type === "state" && event.state === "idle"));
  await host.send("run-1", { text: "Fail" });
  queries[0].emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", uuid: "failure", usage: {}, modelUsage: {}, total_cost_usd: 0 });
  await done;
  assert.ok(events.some((event) => event.type === "exit" && event.cause === "Not logged in · Please run /login" && event.exitCode === 1));
  assert.ok(host.capabilities().degraded?.includes("authentication_required"));
  assert.equal(host.capabilities().authentication.verified, true);
  assert.ok(queries[0].closed);
});

test("Claude close and resume preserve session ID; model changes use the same query", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const collected = collect(handle);
  await host.setModel("run-1", { model: "sonnet" });
  assert.deepEqual(queries[0].modelChanges, ["sonnet"]);
  assert.deepEqual(await host.listModels(), [{ model: "haiku", displayName: "Haiku" }]);
  await assert.rejects(host.setModel("run-1", { model: "sonnet", effort: "high" }), /effort/);
  await host.close("run-1");
  await collected.done;
  await queries[0].inputReader;
  assert.ok(queries[0].closed);
  const resumed = await host.resume({ ...makeRequest("run-2"), generation: 2, nativeId: handle.nativeId });
  const second = collect(resumed);
  assert.equal(resumed.nativeId, handle.nativeId);
  assert.equal(queries[1].options.resume, handle.nativeId);
  assert.equal(queries[1].options.sessionId, undefined);
  queries[1].emit({ type: "system", subtype: "init", session_id: handle.nativeId, mcp_servers: [] });
  await host.close("run-2");
  await second.done;
  await assert.rejects(host.fork({ ...makeRequest("run-3"), nativeId: handle.nativeId }), /not supported/);
});

test("Claude rejects wrong init identity and surfaces authentication without personal details", async () => {
  const { host, queries } = createFixture((query) => { query.account = { apiProvider: "firstParty", apiKeySource: "user" }; });
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  assert.equal(host.capabilities().authentication.type, "api_key");
  queries[0].emit({ type: "system", subtype: "init", session_id: "wrong", mcp_servers: [] });
  await done;
  assert.ok(events.some((event) => event.type === "exit" && event.exitCode === 1 && event.cause?.includes("session_id")));
  const missing = createFixture((query) => { query.account = { apiProvider: "firstParty" }; });
  const missingHandle = await missing.host.start(makeRequest());
  const missingEvents = collect(missingHandle);
  assert.ok(missing.host.capabilities().degraded?.includes("authentication_required"));
  await missing.host.close("run-1");
  await missingEvents.done;
});

test("Claude maps subagent task lifecycle to conversation, delegated relation and completion", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  for (const [task_id, status] of [["agent-1", "completed"], ["agent-2", "failed"], ["agent-3", "stopped"]]) {
    const start = { type: "system", subtype: "task_started", session_id: handle.nativeId, task_id, uuid: `${task_id}-start`, task_type: "local_agent", tool_use_id: `tool-${task_id}`, description: "Review", subagent_type: "reviewer" };
    query.emit(start);
    query.emit(start);
    query.emit({ type: "system", subtype: "task_notification", session_id: handle.nativeId, task_id, status, summary: "Review result", output_file: "/tmp/result", uuid: `${task_id}-end` });
  }
  query.emit({ type: "system", subtype: "task_started", task_id: "shell", task_type: "local_bash", description: "Shell" });
  query.emit({ type: "system", subtype: "task_notification", task_id: "shell", status: "completed" });
  await flush();
  const facts = getFacts(events);
  assert.equal(facts.filter((fact) => fact.kind === "conversation.created" && fact.payload.type === "subagent").length, 3);
  const relations = facts.filter((fact) => fact.kind === "relation.created");
  assert.equal(relations.length, 3);
  assert.ok(relations.every((fact) => fact.payload.type === "delegated" && fact.payload.from_id === "conversation-1"));
  assert.deepEqual(facts.filter((fact) => fact.kind === "delegation.state_changed").map((fact) => fact.payload.state), ["done", "failed", "interrupted"]);
  await host.close("run-1");
  await done;
});

test("Claude aborts and closes pending approvals without leaving waiting promises", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const abort = new AbortController();
  const permission = queries[0].ask("Write", undefined, { signal: abort.signal });
  abort.abort();
  assert.equal((await permission).behavior, "deny");
  const closing = queries[0].ask();
  await host.close("run-1");
  assert.equal((await closing).behavior, "deny");
  await done;
  assert.equal(getFacts(events).filter((fact) => fact.kind === "approval.resolved" && fact.payload.state === "expired").length, 2);
  await host.close("run-1");
});

test("Claude interrupted process failure is recorded without failing the run", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  await flush();
  query.onInterrupt = () => {
    emitResult(query, true, ["Interrupted"], query.inputs[0].uuid);
    query.streamError = new Error("Child exited with code 1");
    query.messages.end();
  };
  await host.interrupt("run-1");
  await done;
  assert.ok(events.some((event) => event.type === "exit" && event.exitCode === 0));
  assert.ok(getFacts(events).some((fact) => fact.kind === "run.updated" && JSON.stringify(fact.payload).includes("Child exited with code 1")));
});

test("Claude unexpected stream failure fails the run and authentication startup failure closes query", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  queries[0].streamError = new Error("Connection lost");
  queries[0].messages.end();
  await done;
  assert.ok(events.some((event) => event.type === "exit" && event.exitCode === 1 && event.cause === "Connection lost"));
  const startup = createFixture((query) => { query.accountInfo = async () => { throw new Error("Authentication unavailable"); }; });
  await assert.rejects(startup.host.start(makeRequest()), /Authentication unavailable/);
  assert.ok(startup.queries[0].closed);
  await startup.queries[0].inputReader;
});

test("Claude drains child stderr even beyond pipe capacity", { timeout: 5000 }, async (t) => {
  const { host, queries } = createFixture();
  await host.start(makeRequest());
  t.after(() => host.close("run-1"));
  const child = queries[0].options.spawnClaudeCodeProcess!({
    command: process.execPath,
    args: ["-e", "process.stderr.write('x'.repeat(2 * 1024 * 1024))"],
    env: process.env,
    signal: new AbortController().signal,
  });
  t.after(() => { child.kill("SIGKILL"); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0);
});

test("Claude routes child messages by tool ID and keeps unknown children out of parent", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { events, done } = collect(handle);
  const query = queries[0];
  const emitChild = (toolId: string, uuid: string) => {
    query.emit({ type: "stream_event", parent_tool_use_id: toolId,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: uuid } } });
    query.emit({ type: "assistant", parent_tool_use_id: toolId, uuid,
      message: { content: [{ type: "text", text: uuid }] } });
  };
  emitChild("unknown-tool", "unknown-child");
  for (const taskId of ["child-1", "child-2"]) {
    query.emit({ type: "system", subtype: "task_started", task_id: taskId,
      task_type: "local_agent", tool_use_id: `tool-${taskId}`, description: "Review" });
    emitChild(`tool-${taskId}`, taskId);
  }
  await host.close("run-1");
  await done;
  const memberships = getFacts(events).filter((fact) => fact.kind === "message_membership.created");
  assert.deepEqual(memberships.map((fact) => fact.payload.conversation_id),
    ["child-1", "child-2"].map((id) => `${handle.nativeId}:agent:${id}`));
  const deltas = events.filter((event) => event.type === "delta");
  assert.deepEqual(deltas.map((event) => event.conversationId), memberships.map((fact) => fact.payload.conversation_id));
  assert.deepEqual(deltas.map((event) => event.text), ["child-1", "child-2"]);
  assert.equal(getFacts(events).filter((fact) => fact.kind === "message.created").length, 2);
});

for (const ending of ["close", "failure", "disconnect"] as const) {
  test(`Claude closes unfinished delegations on ${ending} without changing completed tasks`, async () => {
    const { host, queries } = createFixture();
    const handle = await host.start(makeRequest());
    const { events, done } = collect(handle);
    const query = queries[0];
    for (const taskId of ["completed", "unfinished"]) {
      query.emit({ type: "system", subtype: "task_started", task_id: taskId, task_type: "local_agent", description: "Review" });
    }
    query.emit({ type: "system", subtype: "task_notification", task_id: "completed", status: "completed" });
    // 同じ通知を再送しても、終端の委譲は一度だけ更新する。
    query.emit({ type: "system", subtype: "task_notification", task_id: "completed", status: "completed" });
    await flush();
    if (ending === "close") await host.close("run-1");
    else if (ending === "failure") emitResult(query, true);
    else query.messages.end();
    await done;
    const transitions = getFacts(events).filter((fact) => fact.kind === "delegation.state_changed");
    assert.deepEqual(transitions.map((fact) => [fact.subject, fact.payload.state]), [
      [`delegation:${handle.nativeId}:completed`, "done"],
      [`delegation:${handle.nativeId}:unfinished`, "interrupted"],
    ]);
    const exitIndex = events.findIndex((event) => event.type === "exit");
    assert.ok(events.slice(0, exitIndex).some((event) => event.type === "fact" && event.fact === transitions[1]));
    await host.close("run-1");
    // 終了した query を保持せず、同じ ID で開き直せる。
    const reopened = await host.resume({ ...makeRequest(), nativeId: handle.nativeId });
    const next = collect(reopened);
    await host.close("run-1");
    await next.done;
  });
}

for (const throws of [false, true]) {
  test(`Claude treats interrupted stream ending before result as interrupted (throws=${throws})`, async () => {
    const { host, queries } = createFixture();
    const handle = await host.start(makeRequest());
    const { events, done } = collect(handle);
    const query = queries[0];
    query.onInterrupt = () => {
      if (throws) query.streamError = new Error("Child exited with code 1");
      query.messages.end();
    };
    await host.interrupt("run-1");
    await done;
    assert.ok(events.some((event) => event.type === "exit" && event.exitCode === 0));
    const facts = getFacts(events);
    assert.equal(facts[0].kind, "run.interrupt_requested");
    assert.ok(facts.some((fact) => {
      if (fact.kind !== "run.updated") return false;
      const evidence = fact.payload.last_evidence;
      return evidence && typeof evidence === "object" && !Array.isArray(evidence) && evidence.interrupted === true;
    }));
    if (throws) assert.ok(events.some((event) => event.type === "exit" && event.cause === "Child exited with code 1"));
  });
}

test("Claude verifies authentication only from the first result", async () => {
  const { host, queries } = createFixture();
  const handle = await host.start(makeRequest());
  const { done } = collect(handle);
  const query = queries[0];
  emitResult(query);
  await flush();
  assert.equal(host.capabilities().authentication.verified, true);
  await host.send("run-1", { text: "Interrupt this turn" });
  await flush();
  query.onInterrupt = () => emitResult(query, true, ["Interrupted"], query.inputs[1].uuid);
  await host.interrupt("run-1");
  await flush();
  assert.equal(host.capabilities().authentication.verified, true);
  await host.close("run-1");
  await done;

  const failed = createFixture();
  const failedHandle = await failed.host.start(makeRequest());
  const failure = collect(failedHandle);
  emitResult(failed.queries[0], true, ["Not logged in"]);
  await failure.done;
  assert.equal(failed.host.capabilities().authentication.verified, false);
  assert.ok(failed.host.capabilities().degraded?.includes("authentication_required"));
});

test("Claude managed runs skip claude.ai integrations by default and switch by host option or request", async () => {
  const previous = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  process.env.ENABLE_CLAUDEAI_MCP_SERVERS = "true";
  try {
    const cases: [ConstructorParameters<typeof ClaudeHost>[1], StartRequest["integrationMode"], string, string | undefined, boolean][] = [
      [{}, undefined, "disabled", "false", false],
      [{ integrationMode: "strict" }, undefined, "strict", "false", true],
      [{ integrationMode: "enabled" }, undefined, "enabled", "true", false],
      [{ integrationMode: "strict" }, "enabled", "enabled", "true", false],
      [{ integrationMode: "enabled" }, "disabled", "disabled", "false", false],
    ];
    for (const [options, requested, mode, env, strict] of cases) {
      const queries: FakeQuery[] = [];
      const host = new ClaudeHost((args) => { const query = new FakeQuery(args); queries.push(query); return query; }, options);
      const handle = await host.start({ ...makeRequest(), ...(requested ? { integrationMode: requested } : {}) });
      const { events, done } = collect(handle);
      const query = queries[0];
      assert.equal(query.options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, env, mode);
      assert.equal(query.options.strictMcpConfig === true, strict, mode);
      assert.deepEqual(query.options.mcpServers, strict ? {} : undefined, mode);
      query.emit({ type: "system", subtype: "init", session_id: handle.nativeId, apiKeySource: "none", mcp_servers: [] });
      await flush();
      const init = getFacts(events).find((fact) => fact.kind === "run.updated" && JSON.stringify(fact.payload).includes('"kind":"init"'));
      assert.equal((init?.payload as { last_evidence?: { integration_mode?: string } } | undefined)?.last_evidence?.integration_mode, mode);
      await host.close("run-1");
      await done;
    }
  } finally {
    if (previous === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS; else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = previous;
  }
});
