import { readProjection } from "./projection.ts";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "../../api/src/ws/index.ts";
import { openLedger } from "../../core/src/ledger/index.ts";
import type { JsonValue } from "../../core/src/ledger/facts.ts";
import { APPROVAL_COMMANDS, findPendingApproval } from "./e2e-approval.ts";

const TIMEOUT_MS = 180_000;
const SHUTDOWN_MS = 10_000;
const CLAUDE_MODEL = "haiku";
const CODEX_MODEL = "gpt-5.6-luna";
interface ManagedRun { runId: string; conversationId: string; nativeId: string; generation: number }
interface Endpoint { ws_url: string; ws_token: string }
interface WireMessage { type: string; cmd_id?: string; ok?: boolean; error?: string; result?: JsonValue; runId?: string; seq?: number; text?: string }

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_MS);
  try { await stopped; } finally { clearTimeout(timer); }
}
function launchProcess(path: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const rows: Record<string, unknown>[] = [];
  let buffer = "";
  let failure: Error | undefined;
  child.on("error", (error) => { failure = error; });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { rows.push(JSON.parse(line)); } catch { console.log(line); }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return { child, async ready<T>(read: (row: Record<string, unknown>) => T | undefined, label: string) {
    return waitFor(() => {
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${label} exited before ready`);
      return rows.map(read).find((value) => value !== undefined);
    }, label);
  } };
}

async function runChecks(): Promise<void> {
  if (process.env.AGENT_GRAPH_E2E !== "1") { console.log("SKIP: AGENT_GRAPH_E2E=1 is required"); return; }
  const directory = mkdtempSync(join(tmpdir(), "ag-hosts-e2e-"));
  const repo = join(directory, "repo"); mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-m", "e2e base"], { stdio: "ignore" });
  const db = join(directory, "ledger.db"), socketPath = join(directory, "runner.sock");
  const env = { ...process.env, XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache") };
  const children: ChildProcess[] = [];
  const ledger = openLedger(db);
  let socket: WebSocket | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    socket?.terminate();
    const failures: unknown[] = [];
    // api を止めたあと、runner がホストと app-server の子孫を止める。
    for (const child of [...children].reverse()) {
      try { await stopProcess(child); } catch (error) { failures.push(error); }
    }
    ledger.close(); rmSync(directory, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "Process cleanup failed");
  })();
  const onSignal = () => { void cleanup().finally(() => process.exit(130)); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  const projection = () => readProjection(ledger);
  const approvalFacts = (run: ManagedRun, sinceSeq: number) => {
    const store = projection();
    const ids = store.rows("approvals", "run_id = ?", [run.runId]).map((a) => `approval:${a.id}`);
    return store.facts("subject IN (SELECT value FROM json_each(?))", [JSON.stringify([`run:${run.runId}`, ...ids])]);
  };
  const messages: WireMessage[] = [];
  let patchSeq = 0;
  const states = new Set<string>();
  try {
    const runner = launchProcess("packages/runner/src/e2e-runner.ts", [db, socketPath], env);
    children.push(runner.child);
    await runner.ready((row) => row.socket, "runner");
    const api = launchProcess("packages/api/src/cli.ts", ["serve", "--db", db, "--runner-socket", socketPath, "--port", "0", "--no-observe"], env);
    children.push(api.child);
    const endpoint = await api.ready((row) => typeof row.ws_url === "string" ? row as unknown as Endpoint : undefined, "api");
    const apiUrl = endpoint.ws_url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
    socket = new WebSocket(`${endpoint.ws_url}?token=${endpoint.ws_token}`, { origin: apiUrl });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()); messages.push(message);
      if (message.type === "patch") {
        patchSeq = message.seq;
        for (const run of message.changes.runs?.upsert ?? []) states.add(run.state);
      }
    });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    socket.on("error", (error) => console.error(error.message));
    socket.send(JSON.stringify({ type: "hello", seq: 0 }));
    async function command(command: string, payload: unknown = {}): Promise<any> {
      const cmd_id = randomUUID();
      const deadline = Date.now() + TIMEOUT_MS;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${command}`);
        socket!.send(JSON.stringify({ type: "cmd", cmd_id, command, payload }));
        const ack = await waitFor(() => {
          const index = messages.findIndex((message) => message.type === "ack" && message.cmd_id === cmd_id);
          return index < 0 ? undefined : messages.splice(index, 1)[0];
        }, `${command} ack`);
        if (!ack.ok && ack.error === "Runner unavailable") { await delay(500); continue; }
        if (!ack.ok && ack.error?.includes("timed out")) continue;
        assert.equal(ack.ok, true, ack.error); return ack.result;
      }
    }
    async function start(provider: "claude" | "codex", text: string, extra: object = {}): Promise<ManagedRun> {
      return command("start", { provider, cwd: repo, model: { model: provider === "claude" ? CLAUDE_MODEL : CODEX_MODEL }, input: { text }, ...extra });
    }
    async function waitIdle(run: ManagedRun) {
      await waitFor(() => {
        const state = projection().rows("runs", "conversation_id = ? AND generation = ?", [run.conversationId, run.generation])[0];
        if (state?.state === "failed" || state?.state === "ended") throw new Error(`Unexpected run end: ${JSON.stringify(state)}`);
        return state?.state === "idle" ? state : undefined;
      }, `idle ${run.runId}`);
      await waitFor(() => patchSeq >= projection().lastSeq() ? true : undefined, "api patch caught up");
    }
    async function sendTurn(run: ManagedRun, text: string) {
      const before = projection().lastSeq();
      await command("send", { runId: run.runId, input: { text } });
      await waitFor(() => projection().facts("seq > ?", [before]).find((fact) => (fact.kind === "message_membership.created"
        && fact.payload?.conversation_id === run.conversationId || fact.kind === "run.updated"
        && fact.subject === `run:${run.runId}` && JSON.stringify(fact.payload).includes('"kind":"result"'))), "new turn output");
      await waitIdle(run);
    }
    const lastSeq = () => projection().lastSeq();
    async function approve(run: ManagedRun, sinceSeq: number) {
      const approval = await waitFor(() => findPendingApproval(approvalFacts(run, sinceSeq), run.runId, sinceSeq), `approval ${run.runId}`);
      await command("answer", { approvalId: approval.id, decision: approval.available_decisions?.includes("allow") ? "allow" : "accept" });
      await waitIdle(run);
      assert.ok(projection().row("approvals", approval.id)?.state === "resolved");
    }
    const evidence = (run: ManagedRun, kind: string) => projection().subjectFacts(`run:${run.runId}`).filter((fact) => fact.kind === "run.updated"
      && fact.payload && "last_evidence" in fact.payload && fact.payload.last_evidence && typeof fact.payload.last_evidence === "object"
      && !Array.isArray(fact.payload.last_evidence) && fact.payload.last_evidence.kind === kind);

    console.log("1: Claude output and state through runner + api");
    const claude = await start("claude", "Reply with exactly HOSTS-OK. Do not use tools.");
    await waitIdle(claude);
    assert.ok(messages.some((message) => message.type === "delta" && message.runId === claude.runId));
    assert.ok(states.has("running") && states.has("idle"));
    console.log("PASS 1");

    console.log("2: Claude approval and answer");
    const beforeApproval = lastSeq();
    await command("send", { runId: claude.runId, input: { text: `Use Bash to run exactly: ${APPROVAL_COMMANDS.claude}. Request permission if required. Do not use other tools.` } });
    await approve(claude, beforeApproval); console.log("PASS 2");

    console.log("3: interrupt outcome, exit diagnostics and model");
    const beforeInterrupt = lastSeq();
    const interrupt = await start("claude", `Use Bash to run exactly: ${APPROVAL_COMMANDS.claudeInterrupt}. Do not use other tools.`);
    const pending = await waitFor(() => findPendingApproval(approvalFacts(interrupt, beforeInterrupt), interrupt.runId, beforeInterrupt), "interrupt permission");
    await command("answer", { approvalId: pending.id, decision: "allow" });
    await delay(1000);
    await command("interrupt", { runId: interrupt.runId });
    await waitFor(() => evidence(interrupt, "result").find((fact) => JSON.stringify(fact.payload).includes('"outcome":"interrupted"')), "interrupted result");
    await command("close", { runId: interrupt.runId });
    console.log("interrupt diagnostics:", JSON.stringify(evidence(interrupt, "query_closed").map((fact) => fact.payload)));
    assert.ok(!projection().rows("runs", "conversation_id = ? AND state = 'failed'", [interrupt.conversationId]).length);
    await command("set_model", { runId: claude.runId, model: { model: CLAUDE_MODEL } });
    await command("close", { runId: claude.runId });
    console.log("PASS 3; SKIP Claude resume: non-persistent SDK sessions cannot be resumed");

    console.log("4: two Codex threads, approval, resume, fork, model switch, native child relation");
    const beforeCodex = lastSeq();
    const [first, second] = await Promise.all([
      start("codex", `Run exactly: ${APPROVAL_COMMANDS.codex}. Request permission. Do not use other tools.`),
      start("codex", "Reply CODEX-PARALLEL. Do not use tools."),
    ]);
    assert.notEqual(first.nativeId, second.nativeId);
    await approve(first, beforeCodex); await waitIdle(second);
    await command("close", { runId: first.runId });
    const codexResume: ManagedRun = await command("resume", { conversationId: first.conversationId, input: { text: "Reply CODEX-RESUMED. Do not use tools." } });
    assert.equal(codexResume.nativeId, first.nativeId); await waitIdle(codexResume);
    const fork: ManagedRun = await command("fork", { conversationId: first.conversationId, model: { model: CODEX_MODEL }, input: { text: "Reply CODEX-FORK. Do not use tools." } });
    assert.notEqual(fork.nativeId, first.nativeId); await waitIdle(fork);
    const switchModel = process.env.AGENT_GRAPH_E2E_CODEX_SWITCH_MODEL ?? "gpt-5.6-sol";
    assert.notEqual(switchModel, CODEX_MODEL, "model switch must use a different model");
    await command("set_model", { runId: second.runId, model: { model: switchModel } });
    await sendTurn(second, "Reply OK. Do not use tools.");
    await command("set_model", { runId: second.runId, model: { model: CODEX_MODEL } });
    await command("send", { runId: second.runId, input: { text: "Spawn exactly one native subagent to reply CHILD-OK without tools, wait for it and close it. Then reply PARENT-OK." } });
    await waitFor(() => projection().rows("relations", "type = 'delegated' AND from_id = ?", [projection().nativeConversationId(second.conversationId)]).find((relation) => JSON.stringify(relation.evidence).includes("item_id")), "collabAgentToolCall relation");
    await waitIdle(second); console.log(`PASS 4 (one short switch turn: ${switchModel})`);

    console.log("6: accountInfo authentication and integration suppression candidates");
    const status = await command("status");
    assert.equal(status.hosts.claude.authentication.type, "subscription");
    assert.equal(status.hosts.claude.authentication.verified, true);
    console.log("authentication:", JSON.stringify(status.hosts.claude.authentication));
    type InitEvidence = { integration_mode?: string; mcp_servers?: { name: string; source?: string }[] };
    const inits = (run: ManagedRun) => evidence(run, "init").map((fact) => (fact.payload as { last_evidence: InitEvidence }).last_evidence);
    const claudeai = (init: InitEvidence) => (init.mcp_servers ?? []).filter((server) => server.source === "claudeai");
    // 既定の管理する実行は、claude.ai の外部連携を読み込まない。
    const baseline = inits(claude);
    console.log("default integrations:", JSON.stringify(baseline));
    assert.ok(baseline.length, "init integration list missing");
    assert.ok(baseline.every((init) => init.integration_mode === "disabled" && claudeai(init).length === 0), "default run loaded claude.ai integrations");
    const trials: Record<string, InitEvidence[]> = {};
    for (const integrationMode of ["strict", "enabled"]) {
      const candidate = await start("claude", "Reply OK. Do not use tools.", { integrationMode });
      await waitIdle(candidate);
      const init = inits(candidate); assert.ok(init.length, "init integration list missing");
      assert.ok(init.every((entry) => entry.integration_mode === integrationMode));
      trials[integrationMode] = init;
      console.log(`${integrationMode} integrations:`, JSON.stringify(init));
      await command("close", { runId: candidate.runId });
    }
    assert.ok(trials.strict.every((init) => (init.mcp_servers ?? []).length === 0), "strict run loaded MCP servers");
    console.log(`PASS 6 (default has no claude.ai integrations; enabled loads ${claudeai(trials.enabled[0]).length})`);
    const records = projection().records<{ base_sha: string; cwd: string }>("run");
    assert.ok(records.filter((run) => run.cwd).every((run) => run.base_sha));
    console.log("PASS: checks 1, 2, 4, 6 and check 3 interrupt/model; SKIP: check 3 Claude resume");
  } finally {
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }
}

runChecks().catch((error: unknown) => { console.error("FAIL:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
