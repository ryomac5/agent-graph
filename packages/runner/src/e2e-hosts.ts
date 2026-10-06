import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "../../api/src/ws/index.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import type { JsonValue } from "../../core/src/ledger/facts.ts";

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
  const readFacts = () => ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const messages: WireMessage[] = [];
  let patchSeq = 0;
  const states = new Set<string>();
  try {
    const runner = launchProcess("packages/runner/src/cli.ts", ["serve", "--db", db, "--socket", socketPath], env);
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
        const state = projectRuns(readFacts()).find((entry) => entry.conversation_id === run.conversationId && entry.generation === run.generation);
        if (state?.state === "failed" || state?.state === "ended") throw new Error(`Unexpected run end: ${JSON.stringify(state)}`);
        return state?.state === "idle" ? state : undefined;
      }, `idle ${run.runId}`);
      await waitFor(() => patchSeq >= readFacts().at(-1)!.seq ? true : undefined, "api patch caught up");
    }
    async function sendTurn(run: ManagedRun, text: string) {
      const before = readFacts().at(-1)?.seq ?? 0;
      await command("send", { runId: run.runId, input: { text } });
      await waitFor(() => readFacts().find((fact) => fact.seq > before && (fact.kind === "message_membership.created"
        && fact.payload?.conversation_id === run.conversationId || fact.kind === "run.updated"
        && fact.subject === `run:${run.runId}` && JSON.stringify(fact.payload).includes('"kind":"result"'))), "new turn output");
      await waitIdle(run);
    }
    async function approve(run: ManagedRun) {
      const approval = await waitFor(() => projectApprovals(readFacts()).find((entry) => entry.run_id === run.runId && entry.state === "pending"), `approval ${run.runId}`);
      await command("answer", { approvalId: approval.id, decision: approval.available_decisions?.includes("allow") ? "allow" : "accept" });
      await waitIdle(run);
      assert.ok(projectApprovals(readFacts()).some((entry) => entry.id === approval.id && entry.state === "resolved"));
    }
    const evidence = (run: ManagedRun, kind: string) => readFacts().filter((fact) => fact.subject === `run:${run.runId}` && fact.kind === "run.updated"
      && fact.payload && "last_evidence" in fact.payload && fact.payload.last_evidence && typeof fact.payload.last_evidence === "object"
      && !Array.isArray(fact.payload.last_evidence) && fact.payload.last_evidence.kind === kind);

    console.log("1: Claude output and state through runner + api");
    const claude = await start("claude", "Reply with exactly HOSTS-OK. Do not use tools.");
    await waitIdle(claude);
    assert.ok(messages.some((message) => message.type === "delta" && message.runId === claude.runId));
    assert.ok(states.has("running") && states.has("idle"));
    console.log("PASS 1");

    console.log("2: Claude approval and answer");
    await command("send", { runId: claude.runId, input: { text: "Use Bash to run exactly: sleep 1 && printf HOSTS-APPROVED. Request permission if required. Do not use other tools." } });
    await approve(claude); console.log("PASS 2");

    console.log("3: interrupt outcome, exit diagnostics, model and resume");
    const interrupt = await start("claude", "Use Bash to run sleep 60. Do not use other tools.");
    const pending = await waitFor(() => projectApprovals(readFacts()).find((entry) => entry.run_id === interrupt.runId && entry.state === "pending"), "interrupt permission");
    await command("answer", { approvalId: pending.id, decision: "allow" });
    await delay(1000);
    await command("interrupt", { runId: interrupt.runId });
    await waitFor(() => evidence(interrupt, "result").find((fact) => JSON.stringify(fact.payload).includes('"outcome":"interrupted"')), "interrupted result");
    await command("close", { runId: interrupt.runId });
    console.log("interrupt diagnostics:", JSON.stringify(evidence(interrupt, "query_closed").map((fact) => fact.payload)));
    assert.ok(!projectRuns(readFacts()).some((run) => run.conversation_id === interrupt.conversationId && run.state === "failed"));
    await command("set_model", { runId: claude.runId, model: { model: CLAUDE_MODEL } });
    await command("close", { runId: claude.runId });
    const resumed: ManagedRun = await command("resume", { conversationId: claude.conversationId, input: { text: "Reply HOSTS-RESUMED. Do not use tools." } });
    assert.equal(resumed.nativeId, claude.nativeId); await waitIdle(resumed); console.log("PASS 3");

    console.log("4: two Codex threads, approval, resume, fork, model switch, native child relation");
    const [first, second] = await Promise.all([
      start("codex", "Run exactly: sleep 1 && printf CODEX-APPROVED. Request permission. Do not use other tools."),
      start("codex", "Reply CODEX-PARALLEL. Do not use tools."),
    ]);
    assert.notEqual(first.nativeId, second.nativeId);
    await approve(first); await waitIdle(second);
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
    await waitFor(() => readFacts().find((fact) => fact.kind === "relation.created" && fact.payload?.type === "delegated"
      && fact.payload.from_id === second.conversationId && JSON.stringify(fact.payload.evidence).includes("item_id")), "collabAgentToolCall relation");
    await waitIdle(second); console.log(`PASS 4 (one short switch turn: ${switchModel})`);

    console.log("6: accountInfo authentication and integration suppression candidates");
    const status = await command("status");
    assert.equal(status.hosts.claude.authentication.type, "subscription");
    assert.equal(status.hosts.claude.authentication.verified, true);
    console.log("authentication:", JSON.stringify(status.hosts.claude.authentication));
    const baseline = evidence(claude, "init").map((fact) => fact.payload);
    console.log("baseline integrations:", JSON.stringify(baseline));
    for (const integrationMode of ["strict", "disabled"]) {
      const candidate = await start("claude", "Reply OK. Do not use tools.", { integrationMode });
      await waitIdle(candidate);
      const init = evidence(candidate, "init"); assert.ok(init.length, "init integration list missing");
      console.log(`${integrationMode} integration trial:`, JSON.stringify(init.map((fact) => fact.payload)));
      await command("close", { runId: candidate.runId });
    }
    console.log("PASS 6 (trial results recorded; absence in baseline cannot prove suppression)");
    const records = projectEntityRecords<{ base_sha: string; cwd: string }>(readFacts(), "run");
    assert.ok(records.filter((run) => run.cwd).every((run) => run.base_sha));
    console.log("PASS: checks 1, 2, 3, 4, 6");
  } finally {
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }
}

runChecks().catch((error: unknown) => { console.error("FAIL:", error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
