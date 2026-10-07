import { readProjection, type RunnerProjection } from "./projection.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "../../api/src/ws/index.ts";
import { defaultPolicy } from "../../core/src/assign/policy.ts";
import { createRequestId } from "../../core/src/intake/index.ts";
import { openLedger } from "../../core/src/ledger/index.ts";
import { FakeHost, type StartRequest } from "./host/contract.ts";
import { serveRunner } from "./runtime.ts";
import { createE2eHosts } from "./e2e-isolation.ts";

const TIMEOUT_MS = 180_000;
const FAKE_TURN_MS = 1200;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export class CompletingHost extends FakeHost {
  private timers = new Map<string, NodeJS.Timeout>();
  override async start(request: StartRequest) {
    const handle = await super.start(request);
    this.timers.set(request.runId, setTimeout(() => {
      this.timers.delete(request.runId);
      const messageId = `output:${request.runId}`;
      const stamp = { source_event_id: messageId, source_ts: new Date().toISOString(), confidence: "confirmed" as const };
      this.emit(request.runId, { type: "fact", fact: { ...stamp, kind: "message.created", subject: `message:${messageId}`,
        payload: { provider: this.provider, native_id: messageId, version: 1, role: "assistant", phase: "final_answer",
          body_state: "stored", body: '{"verdict":"approve","comment":"fixture approved"}' } } });
      this.emit(request.runId, { type: "fact", fact: { ...stamp, source_event_id: `${messageId}:membership`,
        kind: "message_membership.created", subject: `message_membership:${messageId}`,
        payload: { message_id: messageId, conversation_id: request.conversationId, active: true } } });
      this.emit(request.runId, { type: "exit", exitCode: 0 });
    }, FAKE_TURN_MS));
    return handle;
  }
  override async close(runId: string) {
    clearTimeout(this.timers.get(runId)); this.timers.delete(runId);
    await super.close(runId);
  }
}

async function runChildRunner(db: string, socket: string) {
  const hosts = process.env.AGENT_GRAPH_FAKE_HOSTS === "1"
    ? [new CompletingHost("codex"), new CompletingHost("claude")] : createE2eHosts();
  const ledger = openLedger(db);
  const policy = defaultPolicy();
  policy.roles.implement = [{ executor: "codex", model: "gpt-5.6-luna", family: "openai", tier: "high" }];
  policy.roles.review = [{ executor: "claude", model: "haiku", family: "anthropic", tier: "high" }];
  const runner = await serveRunner(ledger, socket, {
    hosts,
    decision: { policy, quota: () => undefined, performance: () => undefined },
  });
  const stop = () => controller.abort();
  const controller = new AbortController();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  console.log(JSON.stringify({ ready: true }));
  try { await new Promise<void>((done) => controller.signal.addEventListener("abort", () => done(), { once: true })); }
  finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { await runner.close(); } finally { ledger.close(); }
  }
}

function clip(value: unknown, limit = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}
// 失敗した比較と、その比較に関わる委譲と実行の事実を、台帳を開かずに読める形で出す。
export function describeFailure(error: unknown, store: RunnerProjection): string {
  const lines: string[] = [];
  const stack = error instanceof Error ? error.stack ?? "" : "";
  const at = stack.split("\n").find((line) => line.includes("e2e-intake.ts"));
  lines.push(`failed check: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  if (at) lines.push(`at: ${at.trim()}`);
  if (error instanceof assert.AssertionError) {
    lines.push(`actual: ${clip(error.actual, 2000)}`, `expected: ${clip(error.expected, 2000)}`);
  }
  for (const d of store.delegations()) {
    lines.push(`delegation ${d.request_id}: state=${d.state} attempt=${d.attempt}${d.conflicts.length ? ` conflicts=${d.conflicts.length}` : ""}`);
    for (const a of d.attempts) {
      const assignment = a.assignment as { executor?: string; model?: string } | undefined;
      const verification = a.verification as { passed?: boolean } | undefined;
      const review = a.review as { verdict?: string; comment?: string } | undefined;
      const result = a.result as { status?: string } | undefined;
      lines.push(`  attempt ${a.attempt}: state=${a.state} run=${a.run_id ?? "-"} assignment=${assignment ? `${assignment.executor}/${assignment.model}` : "-"}`
        + ` verification=${verification?.passed ?? "-"} review=${review?.verdict ?? "-"} result=${result?.status ?? "-"}`
        + (review?.comment ? ` comment=${clip(review.comment, 200)}` : ""));
    }
    const reasons = store.subjectFacts(`delegation:${d.request_id}`).filter((f) => f.payload && "reason" in f.payload)
      .map((f) => `seq ${f.seq} ${clip((f.payload as { reason?: unknown }).reason, 300)}`);
    for (const reason of reasons) lines.push(`  reason: ${reason}`);
  }
  for (const run of store.rows("runs")) {
    lines.push(`run ${run.id}: state=${run.state}${run.reason ? ` reason=${clip(run.reason, 200)}` : ""}${run.cause ? ` cause=${clip(run.cause, 200)}` : ""}`);
  }
  lines.push(`delegated relations: ${store.rows("relations").filter((r) => r.type === "delegated").map((r) => `${r.id}(${r.confidence})`).join(", ") || "-"}`);
  lines.push(`last seq: ${store.lastSeq()}; tail:`);
  for (const f of store.facts("seq > ?", [Math.max(0, store.lastSeq() - 15)])) lines.push(`  ${f.seq} ${f.source_ts} ${f.source} ${f.kind} ${f.subject}`);
  return lines.join("\n");
}

export async function runIntakeChecks(fake: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "intake-e2e-"));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  const db = join(directory, "ledger.db"); const socket = join(directory, "runner.sock");
  // planner の作業ツリーを利用者の cache に残さないよう、cache も一時の場所に置く。
  const env = { ...process.env, XDG_STATE_HOME: directory, XDG_CACHE_HOME: join(directory, "cache"), AGENT_GRAPH_RUNNER_SOCKET: socket,
    AGENT_GRAPH_E2E: "1",
    AGENT_GRAPH_FAKE_HOSTS: fake ? "1" : "0", CLAUDE_CODE_SESSION_ID: "intake-parent", CODEX_THREAD_ID: "", AGENT_GRAPH_MANAGED: "" };
  const children = new Set<ChildProcessWithoutNullStreams>();
  const sockets = new Set<WebSocket>();
  const ledger = openLedger(db);
  const projection = () => readProjection(ledger);
  const launch = (path: string, args: string[] = []) => {
    const child = spawn(process.execPath, [join(ROOT, path), ...args], { cwd: ROOT, env, stdio: "pipe" });
    children.add(child);
    let output = ""; let errors = "";
    const rows: any[] = [];
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      while (output.includes("\n")) {
        const end = output.indexOf("\n"); const line = output.slice(0, end); output = output.slice(end + 1);
        if (line.startsWith("{")) rows.push(JSON.parse(line));
      }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", (error) => { errors += error.message; });
    // 終了コードは標準出力を読み切る前に決まることがあるので、行を読むときは close を待つ。
    let closed = false;
    child.once("close", () => { closed = true; });
    return { child, rows, errors: () => errors, closed: () => closed };
  };
  async function until(check: () => boolean, label: string, child?: ReturnType<typeof launch>) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (!check()) {
      if (child && (child.child.exitCode !== null || child.child.signalCode !== null)) throw new Error(`${label}: ${child.errors()}`);
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}${child ? child.errors() : ""}`);
      await delay(10);
    }
  }
  async function stop(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await new Promise<void>((done) => child.once("close", () => done())); }
    finally { clearTimeout(kill); }
  }
  const onSignal = () => { for (const child of children) child.kill("SIGTERM"); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  let failed = false;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(join(cwd, "file.txt"), "fixture\n"); git("add", "."); git("commit", "-m", "fixture");
    ledger.append({ source: "hook", source_event_id: "parent", source_ts: new Date().toISOString(), kind: "conversation.created",
      subject: "conversation:parent", confidence: "confirmed", payload: { provider: "claude", native_id: "intake-parent",
        origin: "observed", type: "interactive", history_format: "jsonl" } });
    const runner = launch("packages/runner/src/e2e-intake.ts", ["--runner", db, socket]);
    await until(() => runner.rows.some((r) => r.ready), "runner ready", runner);
    const startApi = async () => {
      const api = launch("packages/api/src/cli.ts", ["serve", "--db", db, "--port", "0", "--runner-socket", socket, "--no-observe"]);
      await until(() => api.rows.some((r) => r.ws_url), "api ready", api); return api;
    };
    let api = await startApi();
    const shim = launch("packages/adapters/src/shim-v2/cli.ts");
    const rpc = async (id: string, method: string, params?: unknown) => {
      shim.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      await until(() => shim.rows.some((r) => r.id === id), `MCP ${id}`, shim);
      const response = shim.rows.find((r) => r.id === id); assert.equal(response.error, undefined); return response.result;
    };
    await rpc("initialize", "initialize", { clientInfo: { name: "claude" }, protocolVersion: "2024-11-05" });
    const body = { role: "implement", title: "Intake check", task: "Reply INTAKE-OK. Do not use tools or change files.", accept: ["git diff --exit-code"], cwd };
    const accepted = (await rpc("delegate", "tools/call", { name: "delegate", arguments: body })).structuredContent;
    assert.equal(accepted.state, "accepted");
    const requestId = accepted.requestId;
    const watch = launch("packages/api/src/cli.ts", ["watch", requestId, "--db", db, "--json"]);
    await until(() => watch.rows.length > 0 && projection().row("delegations", requestId)?.state === "running", "running delegation and watch");
    const beforeRestart = projection().lastSeq();
    await stop(api.child);
    assert.equal(projection().row("delegations", requestId)?.state, "running");
    api = await startApi();
    const waiting = rpc("wait", "tools/call", { name: "wait", arguments: { requestId }, _meta: { progressToken: "e2e" } });
    assert.equal((await waiting).structuredContent.state, "done");
    await until(watch.closed, "watch terminal", watch);
    assert.equal(watch.child.exitCode, 0, watch.errors());
    assert.equal(watch.rows.at(-1).state, "done");
    assert.ok(shim.rows.some((r) => r.method === "notifications/progress"));
    assert.ok(projection().lastSeq() > beforeRestart);
    assert.equal(projection().delegations()[0].attempts.length, 1);
    assert.equal(projection().rows("runs").length, 2);

    const endpoint = api.rows.find((r) => r.ws_url);
    const screen = new WebSocket(`${endpoint.ws_url}?token=${endpoint.ws_token}`); sockets.add(screen);
    const screenRows: any[] = [];
    screen.on("message", (data) => screenRows.push(JSON.parse(String(data))));
    await new Promise<void>((done, reject) => { screen.once("open", done); screen.once("error", reject); });
    const snapshot = await fetch(`${endpoint.snapshot_url}?token=${endpoint.ws_token}`).then((r) => r.json()) as { seq: number; generation: number };
    screen.send(JSON.stringify({ type: "hello", seq: snapshot.seq, generation: snapshot.generation }));
    const cmdId = "screen-delegate"; const uiId = createRequestId({ source: "ui", cmdId });
    const screenCmd = async (id: string, command: string, payload: unknown) => {
      screen.send(JSON.stringify({ type: "cmd", cmd_id: id, command, payload }));
      await until(() => screenRows.some((r) => r.cmd_id === id), `screen ${id}`);
      const ack = screenRows.find((r) => r.cmd_id === id); assert.equal(ack.ok, true, ack.error); return ack.result;
    };
    assert.equal((await screenCmd(cmdId, "intake.submit", { ...body, accept: ["exit 7"], origin: { provider: "claude", nativeId: "intake-parent" } })).requestId, uiId);
    const specPath = join(directory, "tasks.yaml");
    writeFileSync(specPath, `goal: Intake graph\nbase_branch: main\ntasks:\n  - id: task\n    title: Intake task\n    executor: codex\n    scope: ["file.txt"]\n    accept: ["git diff --exit-code"]\n    prompt: Reply INTAKE-OK. Do not use tools or change files.\n`);
    const job = await screenCmd("planner-run", "planner.run", { cwd, session: "intake-graph", specPath,
      origin: { provider: "claude", nativeId: "intake-parent" } });
    let jobStatus: any;
    let poll = 0;
    const plannerDeadline = Date.now() + TIMEOUT_MS;
    do {
      assert.ok(Date.now() < plannerDeadline, "planner completion timed out");
      await delay(100);
      jobStatus = await screenCmd(`planner-status-${poll++}`, "planner.status", { jobId: job.jobId });
    } while (jobStatus.state === "running");
    assert.equal(jobStatus.state, "done", jobStatus.error);
    const graphResult = JSON.parse(jobStatus.output);
    assert.ok(graphResult.tasks.every((task: { state: string }) => task.state === "done"));
    // 画面の委譲と planner の委譲は並んで走るので、終わりの状態を待ってから受け入れの失敗を確かめる。
    await until(() => ["done", "failed", "interrupted", "denied"].includes(projection().row("delegations", uiId)?.state ?? ""), "ui terminal");
    assert.equal((await screenCmd("ui-status", "intake.status", { requestId: uiId })).state, "failed");
    assert.equal((await screenCmd("ui-retry", "intake.retry", { requestId: uiId })).attempt, 2);
    await until(() => projection().row("delegations", uiId)?.state === "failed", "ui retry terminal");
    const stored = projection().records<{ request: { source: string } }>("delegation");
    assert.deepEqual(stored.map((f) => f.request!.source).sort(), ["mcp", "planner", "ui"]);
    const relations = projection().rows("relations").filter((r) => r.type === "delegated");
    assert.equal(relations.length, 4);
    assert.ok(relations.every((r) => r.from_id === JSON.stringify(["claude", "intake-parent"]) && r.confidence === "confirmed"));
    const seq = projection().lastSeq();
    const endpointSnapshot = await fetch(`${endpoint.snapshot_url}?token=${endpoint.ws_token}`).then((r) => r.json()) as { seq: number; projection: unknown };
    assert.equal(endpointSnapshot.seq, seq);
    screen.terminate();
    await stop(api.child);
    const rebuilt = launch("packages/api/src/cli.ts", ["rebuild", "--db", db]);
    await until(rebuilt.closed, "projection rebuild", rebuilt);
    assert.equal(rebuilt.child.exitCode, 0, rebuilt.errors());
    api = await startApi();
    const fresh = api.rows.find((r) => r.ws_url);
    const snapshotAfterRebuild = await fetch(`${fresh.snapshot_url}?token=${fresh.ws_token}`).then((r) => r.json()) as { projection: unknown };
    assert.deepEqual(snapshotAfterRebuild.projection, endpointSnapshot.projection);
    console.log(`PASS: intake via screen/MCP/planner, watch, origin, retry and api restart (${fake ? "fake" : "real"} hosts)`);
  } catch (error) {
    failed = true;
    try { console.error(describeFailure(error, projection())); }
    catch (detail) { console.error("could not describe the failure:", detail); }
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    for (const screen of sockets) screen.terminate();
    await Promise.allSettled([...children].reverse().map(stop));
    ledger.close();
    // 実機の失敗は再現しにくいので、失敗したときは指定がなくても台帳を残す。
    if (failed || process.env.AGENT_GRAPH_E2E_KEEP === "1") console.error(`KEPT: ${directory} (ledger: ${db})`);
    else rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.env.AGENT_GRAPH_E2E !== "1" ? Promise.resolve(console.log("SKIP: set AGENT_GRAPH_E2E=1"))
    : process.argv[2] === "--runner" ? runChildRunner(process.argv[3], process.argv[4])
    : runIntakeChecks(process.env.AGENT_GRAPH_FAKE_HOSTS === "1");
  action.catch((error: unknown) => { console.error("FAIL:", error); process.exitCode = 1; });
}
