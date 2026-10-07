import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AccountInfo, Options, PermissionResult, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { openLedger } from "../../core/src/ledger/index.ts";
import { projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import { ClaudeHost, type ClaudeQuery, type QueryFactory } from "../src/hosts/claude/index.ts";
import { AsyncQueue } from "../src/hosts/claude/queue.ts";
import { Supervisor } from "../src/supervisor.ts";
import { APPROVAL_COMMANDS, findPendingApproval } from "../src/e2e-approval.ts";

// 偽の SDK。承認の要求は canUseTool を呼んだときだけ生じ、読み取りだけの Bash は呼ばずに動く実機の振る舞いを写す。
class FakeQuery implements ClaudeQuery {
  messages = new AsyncQueue<SDKMessage>();
  options: Options;
  constructor(args: Parameters<QueryFactory>[0]) {
    this.options = args.options;
    void (async () => { for await (const _ of args.prompt as AsyncIterable<SDKUserMessage>) { /* 入力を読み捨てる */ } })();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> { yield* this.messages; }
  emit(message: object): void { this.messages.push(message as SDKMessage); }
  async interrupt(): Promise<undefined> { return undefined; }
  async setModel(): Promise<void> {}
  close(): void { this.messages.end(); }
  async accountInfo(): Promise<AccountInfo> { return { subscriptionType: "Claude Team", apiProvider: "firstParty" }; }
  async supportedModels() { return []; }
  toolUse(command: string): void {
    this.emit({ type: "assistant", uuid: `assistant-${command}`, session_id: this.options.sessionId, parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command } }] } });
  }
  finishTurn(): void {
    this.emit({ type: "result", subtype: "success", is_error: false, result: "Done", session_id: this.options.sessionId, uuid: "result-1",
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 });
    this.emit({ type: "system", subtype: "session_state_changed", state: "idle", session_id: this.options.sessionId });
  }
}

async function flush(): Promise<void> { for (let index = 0; index < 5; index++) await setImmediate(); }

function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "e2e-approval-"));
  const ledger = openLedger(join(directory, "test.db"));
  const queries: FakeQuery[] = [];
  const host = new ClaudeHost((args) => { const query = new FakeQuery(args); queries.push(query); return query; });
  const supervisor = new Supervisor(ledger);
  supervisor.registerHost(host);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = { runId: "r1", conversationId: "c1", generation: 1, cwd: directory, input: { text: "go" }, model: { model: "haiku" } };
  return { ledger, host, supervisor, queries, request, facts: () => ledger.readSince(0, Number.MAX_SAFE_INTEGER) };
}

test("approval commands of the host checks write files so default permission mode must ask", () => {
  for (const command of Object.values(APPROVAL_COMMANDS)) assert.match(command, /^touch \S+ && /);
});

test("canUseTool from the SDK reaches the ledger as a pending approval of the run and resolves on answer", async (t) => {
  const { host, supervisor, queries, request, facts } = createFixture(t);
  const since = facts().at(-1)?.seq ?? 0;
  await supervisor.start("claude", request);
  const query = queries[0];
  query.emit({ type: "system", subtype: "session_state_changed", state: "running", session_id: query.options.sessionId });
  query.toolUse(APPROVAL_COMMANDS.claude);
  const decision = query.options.canUseTool!("Bash", { command: APPROVAL_COMMANDS.claude },
    { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1" });
  await flush();
  const approval = findPendingApproval(facts(), request.runId, since);
  assert.ok(approval);
  assert.equal(approval.conversation_id, request.conversationId);
  assert.deepEqual(approval.available_decisions, ["allow", "deny"]);
  await host.answer(approval.id, "allow");
  assert.deepEqual(await decision as PermissionResult, { behavior: "allow", updatedInput: { command: APPROVAL_COMMANDS.claude } });
  query.finishTurn();
  await flush();
  assert.equal(projectApprovals(facts()).find((entry) => entry.id === approval.id)?.state, "resolved");
  assert.equal(findPendingApproval(facts(), request.runId, since), undefined);
  await host.close(request.runId);
  await supervisor.wait(request.runId);
});

test("a turn that runs a tool without canUseTool fails fast instead of waiting for an approval", async (t) => {
  const { host, supervisor, queries, request, facts } = createFixture(t);
  const since = facts().at(-1)?.seq ?? 0;
  await supervisor.start("claude", request);
  const query = queries[0];
  query.emit({ type: "system", subtype: "session_state_changed", state: "running", session_id: query.options.sessionId });
  await flush();
  assert.equal(findPendingApproval(facts(), request.runId, since), undefined);
  query.toolUse("sleep 1 && printf HOSTS-APPROVED");
  query.finishTurn();
  await flush();
  assert.throws(() => findPendingApproval(facts(), request.runId, since), /without an approval request.*Bash .*sleep 1 && printf HOSTS-APPROVED/);
  await host.close(request.runId);
  await supervisor.wait(request.runId);
});
