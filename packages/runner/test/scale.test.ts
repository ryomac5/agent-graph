import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultPolicy } from "../../core/src/assign/policy.ts";
import { openLedger, readLedgerDatabase, rebuild, applyIncremental } from "../../core/src/ledger/index.ts";
import type { Fact } from "../../core/src/ledger/index.ts";
import { collectProjectionDependencies } from "../../core/src/ledger/projections/dependencies.ts";
import { finalizeArtifacts } from "../src/artifacts/index.ts";
import { Intake } from "../src/intake/index.ts";
import { readProjection } from "../src/projection.ts";
import { RunnerRuntime } from "../src/runtime.ts";

const FACT_COUNT = 200_000;
const CONVERSATION_COUNT = 10_000;
const OPERATION_LIMIT_MS = 50;
const REPETITIONS = 7;
const SCALE_RATIO_LIMIT = 1.5;
const TIMING_NOISE_MS = 2;
const RETAINED_HEAP_LIMIT = 8 * 1024 * 1024;
const TS = "2026-01-01T00:00:00.000Z";

function synthesize(ledger: ReturnType<typeof openLedger>, from: number, to: number): void {
  const db = readLedgerDatabase(ledger);
  const insert = db.prepare(`INSERT INTO facts(fact_id, source, source_event_id, kind, subject, payload, payload_hash,
    source_ts, observed_ts, schema_version, confidence) VALUES (?, 'host-codex', ?, ?, ?, ?, 'fixture', ?, ?, 1, 'confirmed')`);
  const dependency = db.prepare("INSERT OR IGNORE INTO fact_projection_dependencies VALUES (?, ?, ?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = from; i < to; i++) {
      const conversation = i < CONVERSATION_COUNT;
      const subject = conversation ? `conversation:scale-${i}` : `connection:scale-${i % CONVERSATION_COUNT}`;
      const kind = conversation ? "conversation.created" : "connection.updated";
      const payload = conversation ? { provider: "codex", native_id: `scale-${i}`, origin: "observed", type: "interactive", history_format: "jsonl" }
        : { state: "connected", last_evidence_ts: TS };
      const result = insert.run(`scale-${i}`, `scale-${i}`, kind, subject, JSON.stringify(payload), TS, TS);
      const fact = { seq: Number(result.lastInsertRowid), kind, subject, payload } as Fact;
      for (const item of collectProjectionDependencies(fact)) dependency.run(item.projection, subject, item.direction, item.key, fact.seq);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

// 合成と再構築の一時メモリを測定に混ぜず、常駐する runner のプロセスで実測する。
function measureRunner(dbPath: string, blobDirectory: string, artifactId: string): { heap: number; timings: Record<string, number> } {
  const ledgerUrl = new URL("../../core/src/ledger/index.ts", import.meta.url).href;
  const projectionUrl = new URL("../src/projection.ts", import.meta.url).href;
  const runtimeUrl = new URL("../src/runtime.ts", import.meta.url).href;
  const intakeUrl = new URL("../src/intake/index.ts", import.meta.url).href;
  const artifactUrl = new URL("../src/artifacts/index.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { openLedger } from ${JSON.stringify(ledgerUrl)};
    import { readProjection } from ${JSON.stringify(projectionUrl)};
    import { RunnerRuntime } from ${JSON.stringify(runtimeUrl)};
    import { Intake } from ${JSON.stringify(intakeUrl)};
    import { finalizeArtifactsAsync } from ${JSON.stringify(artifactUrl)};
    const ledger = openLedger(${JSON.stringify(dbPath)});
    const runtime = new RunnerRuntime(ledger, [], () => {});
    const intake = new Intake(ledger, runtime, { reviewBlobDirectory: ${JSON.stringify(blobDirectory)} });
    for (let i = 0; i < 20; i++) { readProjection(ledger); intake.status('scale-request'); runtime.supervisor.status(); }
    global.gc();
    const operations = {
      artifact: () => finalizeArtifactsAsync(ledger, { runId: 'target', provider: 'codex', sourceEventId: crypto.randomUUID(), sourceTs: new Date().toISOString(), verification: { passed: true } }, { blobDirectory: ${JSON.stringify(blobDirectory)} }),
      review: () => intake.review.prepareReview(${JSON.stringify(artifactId)}),
      intake: () => intake.status('scale-request'),
      supervisor: () => runtime.supervisor.status(),
    };
    const timings = {};
    for (const [name, operation] of Object.entries(operations)) {
      await operation();
      const samples = [];
      for (let i = 0; i < ${REPETITIONS}; i++) {
        const start = performance.now(); await operation(); samples.push(performance.now() - start);
      }
      timings[name] = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    }
    global.gc();
    console.log(JSON.stringify({ heap: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, timings }));
    await intake.close(); ledger.close();
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const memory = JSON.parse(result.stdout.trim());
  assert.ok(memory.rss < 1024 * 1024 * 1024, `Resident memory exceeds 1 GiB: ${memory.rss}`);
  return memory;
}

test("200000 and 400000 facts: indexed runner operations stay below 50 ms without retaining fact history", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runner-scale-"));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Scale"); git("config", "user.email", "scale@example.invalid");
  writeFileSync(join(cwd, "code.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const dbPath = join(directory, "ledger.db");
  const ledger = openLedger(dbPath, { storageScope: "full_diff" });
  const runtime = new RunnerRuntime(ledger, [], () => {});
  const intake = new Intake(ledger, runtime, { decision: { policy: defaultPolicy(), quota: () => undefined, performance: () => undefined }, reviewBlobDirectory: join(directory, "blobs") });
  t.after(async () => { await intake.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const [entity, payload] of [
    ["conversation", { provider: "codex", native_id: "scale-run", origin: "managed", type: "interactive", history_format: "jsonl" }],
    ["run", { conversation_id: "target", generation: 1, state: "idle", cwd, base_sha: base, repository_id: "repo", worktree_id: "tree", isolation: "shared", joint_run_ids: [] }],
    ["delegation", { request_id: "scale-request", run_id: "target", title: "Scale", task: "Review", accept: [], attempt: 1, state: "done", result: { output: "done" } }],
  ] as const) ledger.append({ source: "intake", source_event_id: entity, source_ts: TS, kind: `${entity}.created`, subject: `${entity}:${entity === "delegation" ? "scale-request" : "target"}`, confidence: "confirmed", payload } as Parameters<typeof ledger.append>[0]);
  synthesize(ledger, 0, FACT_COUNT);
  rebuild(readLedgerDatabase(ledger));
  const capture = () => finalizeArtifacts(ledger, { runId: "target", provider: "codex", sourceEventId: crypto.randomUUID(), sourceTs: new Date().toISOString() }, { blobDirectory: join(directory, "blobs") });
  const artifact = capture(); assert.ok(artifact);
  readProjection(ledger);
  const before = measureRunner(dbPath, join(directory, "blobs"), artifact.id);
  const seq = readProjection(ledger).lastSeq();
  synthesize(ledger, FACT_COUNT, FACT_COUNT * 2);
  applyIncremental(readLedgerDatabase(ledger), seq);
  const after = measureRunner(dbPath, join(directory, "blobs"), artifact.id);
  const first = before.timings; const second = after.timings;
  for (const name of Object.keys(first)) {
    t.diagnostic(`${name}: 200k=${first[name].toFixed(2)} ms, 400k=${second[name].toFixed(2)} ms`);
    assert.ok(first[name] <= OPERATION_LIMIT_MS && second[name] <= OPERATION_LIMIT_MS, `${name} exceeds ${OPERATION_LIMIT_MS} ms`);
    assert.ok(second[name] <= first[name] * SCALE_RATIO_LIMIT + TIMING_NOISE_MS, `${name} scales with ledger size`);
  }
  t.diagnostic(`Retained heap: 200k=${before.heap}, 400k=${after.heap}`);
  assert.ok(after.heap - before.heap < RETAINED_HEAP_LIMIT, "Runner retains memory proportional to fact count");
  assert.equal(readProjection(ledger).rows("conversations").length, CONVERSATION_COUNT + 1);
  t.mock.method(ledger, "readSince", () => { throw new Error("Runner must query projections"); });
  capture(); intake.review.prepareReview(artifact.id); intake.status("scale-request"); runtime.supervisor.status();
});
