import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test, { before, after } from "node:test";
import { createNativeId, openLedger, project, projectConversationIds, type FactInput } from "../../core/src/ledger/index.ts";
import { migrations } from "../../core/src/store/migrations.ts";
import { resolveProjectLocation } from "../../core/src/ledger/repository.ts";
import { migrateLegacyDatabases } from "../src/migrate/index.ts";
import { openObservationService, PROJECTION_POLL_MS } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";
import { startWebSocketServer } from "../src/ws/index.ts";
import { startObservationWorker } from "../src/service/worker-client.ts";
import { acquirePerformanceLock } from "./observe/perf-lock.ts";

const CONVERSATION_COUNT = 10_000;
const MESSAGE_COUNT = 100_000;
const MESSAGES_PER_CONVERSATION = MESSAGE_COUNT / CONVERSATION_COUNT;
const BUILD_BATCH_CONVERSATIONS = 50;
const BODY_LENGTH = 3072;
const SNAPSHOT_LIMIT_BYTES = 2_000_000;
const RSS_LIMIT_BYTES = 400_000_000;
const IDLE_DURATION_MS = 60_000;
const CPU_LIMIT_MICROSECONDS = 3_000_000;
const TS = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

async function runChild(mode: string, path: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    env: { ...process.env, D1_REALDATA_MODE: mode, D1_REALDATA_PATH: path }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, errors);
  return JSON.parse(output);
}
function buildLargeLedger(path: string): void {
  const service = openObservationService({ dbPath: path });
  let event = 0;
  function append(input: FactInput): void {
    service.ledger.append(input);
  }
  try {
    service.batch(() => {
      for (let index = 0; index < 6; index++) append({ source: "ui", source_event_id: `p${index}`, kind: "project.created",
        subject: `project:p${index}`, source_ts: TS, confidence: "confirmed",
        payload: { repository_id: `p${index}`, display_name: `Project ${index}`, name_prefix: `p${index}`, root_path: `/fixture/project-${index}`, state: "registered" } });
    });
    for (let start = 0; start < CONVERSATION_COUNT; start += BUILD_BATCH_CONVERSATIONS) {
      service.batch(() => {
        for (let c = start; c < Math.min(start + BUILD_BATCH_CONVERSATIONS, CONVERSATION_COUNT); c++) {
          const conversation = createNativeId("codex", `conversation-${c}`);
          append({ source: "legacy", source_event_id: `task-${c}`, kind: "task.created", subject: `task:t${c}`, source_ts: TS,
            confidence: "confirmed", payload: { name: `Task ${c}`, purpose: "", project: `p${c % 6}`, state: "open" } });
          append({ source: "rollout-codex", source_event_id: `conversation-${c}`, kind: "conversation.created", subject: `conversation:${conversation}`,
            source_ts: TS, confidence: "confirmed", payload: { provider: "codex", native_id: `conversation-${c}`, task_id: `t${c}`, origin: "observed", type: "interactive", history_format: "legacy" } });
          append({ source: "legacy", source_event_id: `run-${c}`, kind: "run.created", subject: `run:r${c}`,
            source_ts: TS, confidence: "confirmed", payload: { conversation_id: conversation, generation: 0, state: "idle", repository_id: `p${c % 6}` } });
          for (let m = 0; m < MESSAGES_PER_CONVERSATION; m++) {
            const id = createNativeId("codex", `message-${event++}`);
            append({ source: "rollout-codex", source_event_id: `message-${event}`, kind: "message.created", subject: `message:${id}`,
              source_ts: m === MESSAGES_PER_CONVERSATION - 1 ? LATER : TS, confidence: "confirmed",
              payload: { provider: "codex", native_id: `message-${event - 1}`, role: "user", body: `Request ${m}. ` + "x".repeat(BODY_LENGTH), body_state: "stored", version: 1 } });
            append({ source: "rollout-codex", source_event_id: `membership-${event}`, kind: "message_membership.created", subject: `message_membership:mm${event}`,
              source_ts: TS, confidence: "confirmed", payload: { message_id: id, conversation_id: conversation, active: true } });
          }
        }
      });
      service.catchUp();
    }
    service.checkpoint();
  } finally { service.close(); }
}
async function probeLargeLedger(path: string) {
  const memory = { baseline: process.memoryUsage() } as Record<string, NodeJS.MemoryUsage>;
  const service = openObservationService({ dbPath: path, readerOnly: true });
  memory.service = process.memoryUsage();
  const rssService = memory.service.rss;
  let api: Awaited<ReturnType<typeof startWebSocketServer>> | undefined;
  let socketBlocked = false;
  try { api = await startWebSocketServer(service, { port: 0, runnerPath: join(path, "missing.sock") }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM" && "syscall" in error && error.syscall === "listen")) throw error;
    socketBlocked = true;
  }
  const feed = api?.feed ?? new ProjectionFeed(path, service.catchUp);
  const timer = api ? undefined : setInterval(() => feed.refresh(), PROJECTION_POLL_MS);
  memory.feed = process.memoryUsage();
  const rssFeed = memory.feed.rss;
  const worker = await startObservationWorker(service, { hook: false, measureMemory: true, home: join(dirname(path), "empty-home"),
    env: { HOME: join(dirname(path), "empty-home"), CODEX_HOME: join(dirname(path), "empty-codex"), CLAUDE_CONFIG_DIR: join(dirname(path), "empty-claude") } });
  worker.start();
  try {
    const deadline = Date.now() + 30_000;
    while (service.getObservation().state !== "idle") {
      assert.ok(Date.now() < deadline, "Observation worker did not settle");
      await Promise.race([delay(20), worker.failure]);
    }
    memory.worker = process.memoryUsage();
    memory.workerThread = worker.memoryUsage()!;
    const rssWorker = memory.worker.rss;
    const snapshot = api ? await (await fetch(`${api.url}/snapshot`, { headers: { "x-agent-graph-token": api.token } })).json() : feed.snapshot();
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    assert.ok(bytes <= SNAPSHOT_LIMIT_BYTES, `snapshot: ${bytes}`);
    assert.equal(snapshot.pages.conversations.total, CONVERSATION_COUNT);
    assert.equal(snapshot.pages.runs.total, CONVERSATION_COUNT);
    assert.equal(snapshot.projection.projects.length, 6);
    assert.equal(snapshot.projection.messages, undefined);
    assert.equal(snapshot.projection.message_memberships, undefined);
    const conversation = feed.conversation(createNativeId("codex", "conversation-0"));
    assert.equal(conversation.projection.messages.length, MESSAGES_PER_CONVERSATION);
    assert.ok(conversation.projection.messages.every(row => String(row.body).length > BODY_LENGTH));
    assert.equal(snapshot.projection.conversations[0].message_count, MESSAGES_PER_CONVERSATION);
    assert.equal(snapshot.projection.conversations[0].last_message_ts, LATER);
    assert.ok(String(snapshot.projection.conversations[0].last_message_excerpt).length <= 120);
    let after = "";
    const seen = new Set<string>();
    do {
      const page = feed.list("conversations", after);
      for (const row of page.rows) { assert.ok(!seen.has(String(row.id))); seen.add(String(row.id)); }
      after = String(page.next ?? "");
    } while (after);
    assert.equal(seen.size, CONVERSATION_COUNT);
    memory.loaded = process.memoryUsage();
    const rssLoaded = memory.loaded.rss;
    let rss = Math.max(rssService, rssFeed, rssWorker, rssLoaded);
    const sample = setInterval(() => {
      const usage = process.memoryUsage();
      if (usage.rss > rss) { rss = usage.rss; memory.idlePeak = usage; }
      const workerUsage = worker.memoryUsage();
      if (workerUsage && workerUsage.rss > (memory.workerThreadPeak?.rss ?? 0)) memory.workerThreadPeak = workerUsage;
    }, PROJECTION_POLL_MS);
    const before = process.cpuUsage();
    try { await Promise.race([delay(IDLE_DURATION_MS), worker.failure]); }
    finally { clearInterval(sample); }
    const cpu = process.cpuUsage(before);
    const cpuTime = cpu.user + cpu.system;
    memory.idleEnd = process.memoryUsage();
    assert.ok(rss <= RSS_LIMIT_BYTES, `RSS: ${rss}; ${JSON.stringify({ rssService, rssFeed, rssWorker, rssLoaded, heapMain: process.memoryUsage().heapUsed, memory })}`);
    assert.ok(cpuTime <= CPU_LIMIT_MICROSECONDS, `idle CPU: ${cpuTime}`);
    return { bytes, rss, cpuTime, socketBlocked, memory };
  } finally { clearInterval(timer); await worker.close(); if (!api) feed.close(); await api?.close(); service.close(); }
}

if (process.env.D1_REALDATA_MODE) {
  const path = process.env.D1_REALDATA_PATH!;
  if (process.env.D1_REALDATA_MODE === "build") { buildLargeLedger(path); process.stdout.write("{}"); }
else process.stdout.write(JSON.stringify(await probeLargeLedger(path)));
} else {
  // 大規模な生成と待機測定も、既存の性能試験と同じ排他に参加する。
  let releasePerformanceLock: (() => Promise<void>) | undefined;
  before(async () => { releasePerformanceLock = await acquirePerformanceLock(); });
  after(async () => { await releasePerformanceLock?.(); });

  test("realdata: registered projects resolve worktrees and conversation patches only load subscribed bodies", t => {
    const directory = mkdtempSync(join(tmpdir(), "ag-realdata-project-"));
    const main = join(directory, "main");
    const worktree = join(directory, "worktree");
    mkdirSync(main);
    execFileSync("git", ["init", "--quiet", main]);
    execFileSync("git", ["-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture"]);
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "--detach", worktree]);
    const projectId = "registered-main";
    const service = openObservationService({ dbPath: join(directory, "ledger.db") });
    const append = (input: FactInput) => service.ledger.append(input);
    append({ source: "ui", source_event_id: "main", kind: "project.created", subject: `project:${projectId}`, source_ts: TS,
      confidence: "confirmed", payload: { repository_id: projectId, root_path: main, display_name: "Main project", name_prefix: "main", state: "registered" } });
    for (let p = 0; p < 5; p++) append({ source: "ui", source_event_id: `registered-${p}`, kind: "project.created", subject: `project:p${p}`, source_ts: TS,
      confidence: "confirmed", payload: { repository_id: `p${p}`, root_path: `/missing/${p}`, display_name: `Project ${p}`, name_prefix: `p${p}`, state: "registered" } });
    append({ source: "legacy", source_event_id: "old-worktree", kind: "project.created", subject: "project:old-hash", source_ts: TS,
      confidence: "confirmed", payload: { repository_id: "old-hash", root_path: worktree, display_name: "worktree", name_prefix: "wt", state: "unregistered" } });
    const repositoryId = resolveProjectLocation(worktree).repository_id;
    for (const [id, project] of [["a", "old-hash"], ["b", "unresolved"], ["c", repositoryId]]) {
      append({ source: "legacy", source_event_id: `task-${id}`, kind: "task.created", subject: `task:${id}`, source_ts: TS,
        confidence: "confirmed", payload: { name: `Task ${id}`, purpose: "", project, state: "open" } });
      append({ source: "rollout-codex", source_event_id: `conversation-${id}`, kind: "conversation.created", subject: `conversation:${id}`, source_ts: TS,
        confidence: "confirmed", payload: { provider: "codex", native_id: id, origin: "observed", type: "interactive", history_format: "legacy", task_id: id } });
      append({ source: "rollout-codex", source_event_id: `message-${id}`, kind: "message.created", subject: `message:${id}`, source_ts: TS,
        confidence: "confirmed", payload: { provider: "codex", native_id: id, role: "user", body: `Body ${id}`, version: 1, body_state: "stored" } });
      append({ source: "rollout-codex", source_event_id: `membership-${id}`, kind: "message_membership.created", subject: `message_membership:${id}`, source_ts: TS,
        confidence: "confirmed", payload: { conversation_id: id, message_id: id, active: true } });
    }
    const feed = new ProjectionFeed(service.dbPath, service.catchUp);
    t.after(() => { feed.close(); service.close(); rmSync(directory, { recursive: true, force: true }); });
    const snapshot = feed.snapshot();
    assert.equal(snapshot.projection.projects.filter(row => row.state === "registered").length, 6);
    assert.equal(snapshot.projection.tasks.find(row => row.id === "a")!.project, projectId);
    assert.equal(snapshot.projection.tasks.find(row => row.id === "b")!.project_state, "unregistered");
    assert.equal(snapshot.projection.tasks.find(row => row.id === "c")!.project, projectId);
    const a = createNativeId("codex", "a");
    const b = createNativeId("codex", "b");
    assert.equal(snapshot.projection.conversations.find(row => row.id === a)!.project, projectId);
    append({ source: "rollout-codex", source_event_id: "message-b-update", kind: "message.updated", subject: "message:b", source_ts: LATER,
      confidence: "confirmed", payload: { version: 2, body: "Closed conversation body " + "z".repeat(BODY_LENGTH) } });
    const patch = feed.refresh();
    assert.ok(patch && patch !== "resync");
    assert.equal(patch.changes.messages, undefined);
    assert.equal(feed.scopePatch(patch, new Set([a])).changes.messages, undefined);
    assert.equal(feed.scopePatch(patch, new Set([b])).changes.messages.upsert.length, 1);
    assert.ok(!JSON.stringify(feed.scopePatch(patch, new Set([a]))).includes("z".repeat(200)));
    assert.equal(patch.changes.conversations.upsert.length, 1);
    assert.equal(patch.changes.conversations.upsert[0].id, b);
    assert.equal(feed.refresh(), undefined);
    for (const id of ["a", "b"]) append({ source: "rollout-codex", source_event_id: `membership-${id}-off`,
      kind: "message_membership.updated", subject: `message_membership:${id}`, source_ts: LATER,
      confidence: "confirmed", payload: { active: false } });
    const inactive = feed.refresh();
    assert.ok(inactive && inactive !== "resync");
    const scopedInactive = feed.scopePatch(inactive, new Set(["a"]));
    assert.equal(scopedInactive.changes.message_memberships.upsert.length, 1);
    assert.equal(scopedInactive.changes.message_memberships.upsert[0].conversation_id, a);
    assert.equal(scopedInactive.changes.message_memberships.upsert[0].active, 0);
    assert.equal(scopedInactive.changes.messages, undefined);
    assert.equal(scopedInactive.changes.message_memberships.remove.length, 0);
    assert.equal(feed.conversation(a).projection.messages.length, 0);
    assert.equal(feed.snapshot().projection.conversations.find(row => row.id === a)!.message_count, 0);
    // 登録の変更は、所属が変わった作業と会話だけへ伝える。
    append({ source: "ui", source_event_id: "unregister-main", kind: "project.updated", subject: `project:${projectId}`,
      source_ts: LATER, confidence: "confirmed", payload: { state: "unregistered" } });
    const unregistered = feed.refresh();
    assert.ok(unregistered && unregistered !== "resync");
    assert.deepEqual(unregistered.changes.tasks.upsert.map(row => row.id).sort(), ["a", "c"]);
    assert.ok(unregistered.changes.tasks.upsert.every(row => row.project_state === "unregistered"));
    assert.deepEqual(unregistered.changes.conversations.upsert.map(row => row.id).sort(), [a, createNativeId("codex", "c")].sort());
    assert.equal(unregistered.changes.messages, undefined);
    append({ source: "ui", source_event_id: "register-main-again", kind: "project.updated", subject: `project:${projectId}`,
      source_ts: "2026-01-03T00:00:00.000Z", confidence: "confirmed", payload: { state: "registered" } });
    const registered = feed.refresh();
    assert.ok(registered && registered !== "resync");
    assert.ok(registered.changes.tasks.upsert.every(row => row.project === projectId));
    append({ source: "ui", source_event_id: "rename-main", kind: "project.updated", subject: `project:${projectId}`,
      source_ts: "2026-01-04T00:00:00.000Z", confidence: "confirmed", payload: { display_name: "Renamed project" } });
    const renamed = feed.refresh();
    assert.ok(renamed && renamed !== "resync");
    assert.equal(renamed.changes.projects.upsert[0].display_name, "Renamed project");
    assert.equal(renamed.changes.tasks, undefined);
    assert.equal(renamed.changes.conversations, undefined);
    const before = feed.snapshot().projection;
    service.rebuild();
    assert.equal(feed.refresh(), "resync");
    assert.deepEqual(feed.snapshot().projection, before);
    const restarted = new ProjectionFeed(service.dbPath, service.catchUp);
    try { assert.deepEqual(restarted.snapshot().projection, before); }
    finally { restarted.close(); }
  });

  test("realdata: 10,000 conversations / 100,000 messages keep snapshot <= 2 MB, RSS <= 400 MB and idle CPU <= 3 seconds/minute", { timeout: 600_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "ag-realdata-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "ledger.db");
    await runChild("build", path);
    const measured = await runChild("probe", path);
    t.diagnostic(JSON.stringify(measured));
    if (measured.socketBlocked) t.diagnostic("TCP listen blocked; measured the API service and its projection feed with the same 500ms polling loop.");
  });

  test("realdata: legacy titles, task headings, review names and terminal evidence survive correction and repeated migration", async t => {
    const directory = mkdtempSync(join(tmpdir(), "ag-realdata-migrate-"));
    const path = join(directory, "old.db");
    const db = new DatabaseSync(path);
    const ledger = openLedger(join(directory, "ledger.db"));
    t.after(() => { db.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    for (const migration of migrations) db.exec(migration.sql);
    db.exec("INSERT INTO repos VALUES ('repo', '/missing', 'repo')");
    const request = "無人実行です。質問せずに作業を完了してください。\n# タスク X5: 横断検索を作る\n本文";
    const review = "Review a delegated task.\n# タスク X5: 横断検索を作る\nレビュー";
    for (const id of ["root", "child", "review", "heading", "old-task", "idle"]) db.prepare(`INSERT INTO sessions
      (id, repo_key, name, client, trace_id, started_at, status, ended_reason) VALUES (?, 'repo', '', 'codex', 'trace', ?, 'ended', 'idle')`).run(id, TS);
    for (const [id, prompt] of [["child", request], ["review", review], ["heading", request]]) db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES (?, ?, ?, ?)").run(id, id, TS, prompt);
    db.prepare("INSERT INTO graphs VALUES ('g', 'repo', 'root', 'goal', 'fingerprint', ?)").run(TS);
    db.exec("INSERT INTO tasks (graph_id, id, title, role, state) VALUES ('g', 'old-task', '旧作業の題', 'implement', 'done')");
    db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, task, status, parent_id)
      VALUES ('implementation', 'repo', 'root', 'implement', '横断検索を作る', ?, 'done', NULL),
      ('review-delegation', 'repo', 'root', 'review', 'Review: 横断検索を作る', ?, 'failed', 'implementation')`).run(request, review);
    // 本文が重複している場合は終了の対応先を推定しない。
    db.exec("ALTER TABLE delegations ADD COLUMN child_session_id TEXT; UPDATE delegations SET child_session_id = 'child' WHERE id = 'implementation'");
    const first = await migrateLegacyDatabases([path], ledger);
    const facts = ledger.readSince(0, 1000);
    const result = project(facts);
    const taskFor = (id: string) => result.tasks.find(task => task.id === result.conversations.find(c => c.native_id === id)!.task_id)!;
    assert.equal(taskFor("child").name, "横断検索を作る");
    assert.equal(taskFor("review").name, "Review of 横断検索を作る");
    assert.equal(taskFor("heading").name, "横断検索を作る");
    assert.equal(taskFor("old-task").name, "旧作業の題");
    const runFor = (id: string) => result.runs.find(run => projectConversationIds(facts).get(run.conversation_id) === result.conversations.find(c => c.native_id === id)!.id)!;
    assert.equal(runFor("child").state, "ended");
    assert.equal(runFor("review").state, "failed");
    assert.equal(runFor("idle").state, "unknown");
    assert.equal(runFor("idle").ended_ts, undefined);
    assert.ok(facts.some(fact => fact.kind === "run.state_changed" && fact.confidence === "confirmed" && fact.payload?.end_evidence));
    assert.deepEqual(await migrateLegacyDatabases([path], ledger), first);
    assert.equal(ledger.readSince(0, 1000).length, facts.length);
    db.exec("UPDATE tasks SET title = '訂正した題' WHERE id = 'old-task'");
    await migrateLegacyDatabases([path], ledger);
    const corrected = ledger.readSince(0, 1000);
    const additions = corrected.slice(facts.length);
    assert.equal(additions.length, 1);
    assert.equal(additions[0].kind, "task.created");
    assert.ok(additions[0].supersedes);
    await migrateLegacyDatabases([path], ledger);
    assert.equal(ledger.readSince(0, 1000).length, corrected.length);
    assert.deepEqual(project([...corrected].reverse()), project(corrected));
  });

  test("realdata: delegation terminal records in another legacy DB correct the child without ending the parent", async t => {
    const directory = mkdtempSync(join(tmpdir(), "ag-realdata-cross-db-"));
    const paths = [join(directory, "parent.db"), join(directory, "child.db")];
    const ledger = openLedger(join(directory, "ledger.db"));
    t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const request = "# タスク D1: 本文の題\n内容";
    for (const [index, path] of paths.entries()) {
      const db = new DatabaseSync(path);
      for (const migration of migrations) db.exec(migration.sql);
      db.prepare("INSERT INTO repos VALUES (?, ?, ?)").run(`repo-${index}`, `/missing/${index}`, `repo-${index}`);
      db.prepare(`INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at, status, ended_reason)
        VALUES (?, ?, '', 'codex', 'trace', ?, 'ended', 'idle')`).run(index ? "child" : "parent", `repo-${index}`, TS);
      if (index) db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES ('request', 'child', ?, ?)")
        .run(TS, "無人実行です。質問せずに作業を完了し、最後に結果を報告してください。\n" + request);
      else db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, task, status)
        VALUES ('delegated', 'repo-0', 'parent', 'implement', '委譲の題', ?, 'done')`).run(request);
      db.close();
    }
    await migrateLegacyDatabases(paths, ledger);
    const facts = ledger.readSince(0, 1000);
    const result = project(facts);
    const identities = projectConversationIds(facts);
    const child = result.conversations.find(row => row.native_id === "child")!;
    assert.equal(result.tasks.find(row => row.id === child.task_id)!.name, "委譲の題");
    assert.equal(result.runs.find(row => identities.get(row.conversation_id) === child.id)!.state, "ended");
    const parent = result.conversations.find(row => row.native_id === "parent")!;
    assert.equal(result.runs.find(row => identities.get(row.conversation_id) === parent.id)!.state, "unknown");
    await migrateLegacyDatabases([...paths].reverse(), ledger);
    assert.equal(ledger.readSince(0, 1000).length, facts.length);
    const ambiguousPath = join(directory, "second-child.db");
    const duplicate = new DatabaseSync(ambiguousPath);
    try {
      for (const migration of migrations) duplicate.exec(migration.sql);
      duplicate.exec("INSERT INTO repos VALUES ('other', '/missing/other', 'other')");
      duplicate.prepare(`INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at, status, ended_reason)
        VALUES ('other-child', 'other', '', 'codex', 'trace', ?, 'ended', 'idle')`).run(TS);
      duplicate.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES ('request', 'other-child', ?, ?)").run(TS, request);
    } finally { duplicate.close(); }
    const allPaths = [...paths, ambiguousPath];
    await migrateLegacyDatabases(allPaths, ledger);
    const ambiguousFacts = ledger.readSince(0, 1000);
    const ambiguous = project(ambiguousFacts);
    const ambiguousIds = projectConversationIds(ambiguousFacts);
    for (const native of ["child", "other-child"]) {
      const id = ambiguous.conversations.find(row => row.native_id === native)!.id;
      const run = ambiguous.runs.find(row => ambiguousIds.get(row.conversation_id) === id)!;
      assert.equal(run.state, "unknown");
      assert.equal(run.end_evidence, undefined);
    }
    assert.ok(ambiguousFacts.slice(facts.length).some(fact => fact.kind === "run.state_changed" && fact.supersedes));
    await migrateLegacyDatabases(allPaths, ledger);
    assert.equal(ledger.readSince(0, 1000).length, ambiguousFacts.length);
  });
}
