import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { applyIncremental, createFactId, openLedger, rebuild, SCHEMA_VERSION, STORAGE_SCOPES } from "../../src/ledger/index.ts";
import type { FactInput, Ledger, LedgerOptions } from "../../src/ledger/index.ts";

const SOURCE_TS = "2026-01-01T00:00:00.000Z";
const SECRET = `sk-proj-${"FakeOnlyNeverIssued".repeat(5)}`;

test("投影の確定は同期とチェックポイントを繰り返さず、成功と失敗の後に接続設定を戻す", (t) => {
  const { path, ledger } = createFixture(t);
  const database = new DatabaseSync(path);
  t.after(() => database.close());
  database.exec("PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 37");
  const exec = database.exec.bind(database);
  let commits = 0;
  database.exec = (sql: string) => {
    if (sql === "COMMIT") {
      assert.equal(database.prepare("PRAGMA synchronous").get()!.synchronous, 1);
      assert.equal(database.prepare("PRAGMA wal_autocheckpoint").get()!.wal_autocheckpoint, 0);
      commits++;
    }
    return exec(sql);
  };
  function assertRestored(): void {
    assert.equal(database.prepare("PRAGMA synchronous").get()!.synchronous, 2);
    assert.equal(database.prepare("PRAGMA wal_autocheckpoint").get()!.wal_autocheckpoint, 37);
  }
  ledger.append(createInput());
  const state = applyIncremental(database, 0);
  assertRestored();
  assert.equal(database.prepare("PRAGMA cache_size").get()!.cache_size, -64 * 1024);
  rebuild(database);
  assertRestored();
  assert.equal(commits, 2);
  assert.throws(() => applyIncremental(database, state.last_seq + 1), RangeError);
  assertRestored();
  ledger.append(createInput("after-failure"));
  applyIncremental(database, state.last_seq);
  assertRestored();
  assert.equal(database.prepare("SELECT count(*) AS count FROM messages").get()!.count, 2);
});

test("投影用キャッシュは接続ごとに設定し、既に大きいキャッシュを縮めない", (t) => {
  const { path, ledger } = createFixture(t);
  const database = new DatabaseSync(path);
  t.after(() => database.close());
  database.exec("PRAGMA cache_size = -131072");
  ledger.append(createInput());
  applyIncremental(database, 0);
  assert.equal(database.prepare("PRAGMA cache_size").get()!.cache_size, -131072);
});

function createFixture(t: TestContext, options: LedgerOptions = {}): { path: string; dir: string; ledger: Ledger } {
  const dir = mkdtempSync(join(tmpdir(), "agent-graph-ledger-"));
  const path = join(dir, "ledger.db");
  const ledger = openLedger(path, options);
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, dir, ledger };
}
function createInput(id = "message-1", body = "本文"): Extract<FactInput, { kind: "message.created" }> {
  return {
    source: "host-claude", source_event_id: id, kind: "message.created",
    subject: `message:${id}`, payload: {
      provider: "claude", native_id: id, version: 1, role: "assistant", body,
      body_state: "stored",
    },
    source_ts: SOURCE_TS, observed_ts: SOURCE_TS, confidence: "confirmed",
  };
}
function assertAbsentOnDisk(dir: string, texts: string[]): void {
  // DB 本体だけでなく、保存直後の WAL と SHM も検査する。
  for (const file of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, file));
    for (const text of texts) assert.equal(bytes.includes(Buffer.from(text)), false, `${file} に本文が残っています`);
  }
}

test("同じ入力の再送は既存の seq を返し、事実を増やさない", (t) => {
  const { ledger } = createFixture(t);
  const input = createInput();
  const first = ledger.append(input);
  const second = ledger.append({ ...input, observed_ts: "2026-02-01T00:00:00.000Z" });
  assert.equal(first.status, "appended");
  assert.deepEqual(second, { status: "duplicate", seq: first.seq, fact_id: first.fact_id });
  assert.equal(first.fact_id, createFactId(input.source, input.source_event_id));
  assert.equal(ledger.readSince(0, 100).length, 1);
});

test("同じ ID で異なる内容は例外にせず矛盾として返す", (t) => {
  const { ledger } = createFixture(t);
  const first = ledger.append(createInput());
  const conflict = ledger.append(createInput("message-1", "異なる本文"));
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.seq, first.seq);
  if (conflict.status === "conflict") assert.notEqual(conflict.existing_payload_hash, conflict.incoming_payload_hash);
  assert.equal(ledger.readSince(0, 100).length, 1);
  const fact = ledger.readSince(0, 1)[0];
  assert.ok(fact.kind === "message.created");
  assert.equal(fact.payload?.body, "本文");
});

test("オブジェクトのキーの順序が変わっても同じ内容と扱う", (t) => {
  const { ledger } = createFixture(t);
  const input = createInput();
  ledger.append(input);
  const payload = Object.fromEntries(Object.entries(input.payload).reverse()) as typeof input.payload;
  assert.equal(ledger.append({ ...input, payload }).status, "duplicate");
});

test("秘密は保存前に伏せ、DB と WAL に元の文字列を残さない", (t) => {
  const { dir, ledger } = createFixture(t, { storageScope: "full_diff" });
  const envSecret = "FakeEnvSecretValue";
  const pem = "-----BEGIN PRIVATE KEY-----\nFakeOnlyNotAKey\n-----END PRIVATE KEY-----";
  const highEntropy = "Xy7Qp2Lm9Rt4Vb8Nc1Zk5Hw3";
  ledger.append({ ...createInput(), payload: {
    ...createInput().payload,
    body: { text: SECRET, env: `PASSWORD=${envSecret}`, key: pem, apiToken: highEntropy },
  } });
  ledger.append({
    source: "host-claude", source_event_id: "diff-1", kind: "artifact.created",
    subject: "artifact:a1", payload: {
      run_id: "r1", version: 1, repository_id: "repo", worktree_id: "w1",
      base_sha: "base", head_sha: "head", patch_hash: "patch", untracked: [], diff: `+API_KEY=${SECRET}`,
    }, source_ts: SOURCE_TS, observed_ts: SOURCE_TS, confidence: "confirmed",
  });
  assert.match(JSON.stringify(ledger.readSince(0, 10)), /\[REDACTED:/);
  assertAbsentOnDisk(dir, [SECRET, envSecret, pem, "FakeOnlyNotAKey", highEntropy]);
});

test("追加の秘匿規則を反映し、不正な規則は DB 作成前に拒否する", (t) => {
  const { dir, ledger } = createFixture(t, { redactionRules: { patterns: ["CustomPrivateValue"] } });
  ledger.append(createInput("custom", "CustomPrivateValue"));
  assertAbsentOnDisk(dir, ["CustomPrivateValue"]);
  const invalidPath = join(dir, "invalid.db");
  assert.throws(() => openLedger(invalidPath, { redactionRules: { patterns: ["["] } }), TypeError);
  assert.ok(!readdirSync(dir).includes("invalid.db"));
});

for (const [level, storageScope] of STORAGE_SCOPES.entries()) {
  test(`保存範囲 ${storageScope} の外の本文を除外する`, (t) => {
    const { dir, ledger } = createFixture(t, { storageScope });
    ledger.append({ ...createInput(), payload: {
      ...createInput().payload, body: "MessageBodyUnique", tool_output: "ToolOutputUnique",
    } });
    ledger.append({
      source: "host-claude", source_event_id: "artifact", kind: "artifact.created", subject: "artifact:a1",
      payload: {
        run_id: "r1", version: 1, repository_id: "repo", worktree_id: "w1",
        base_sha: "base", head_sha: "head", patch_hash: "patch", untracked: ["new.ts"],
        diff: "FullDiffUnique", verification: { stdout: "VerificationOutputUnique" },
      }, source_ts: SOURCE_TS, observed_ts: SOURCE_TS, confidence: "confirmed",
    });
    const facts = ledger.readSince(0, 10);
    const message = facts[0];
    assert.equal(message.kind, "message.created");
    if (message.kind === "message.created") {
      assert.equal(message.payload?.body, level >= 1 ? "MessageBodyUnique" : undefined);
      assert.equal(message.payload?.body_state, level >= 1 ? "stored" : "omitted");
      assert.equal(message.payload?.tool_output, level >= 2 ? "ToolOutputUnique" : undefined);
    }
    const artifact = facts[1];
    if (artifact.kind === "artifact.created") {
      assert.equal(artifact.payload?.diff, level >= 3 ? "FullDiffUnique" : undefined);
      assert.deepEqual(artifact.payload?.untracked, ["new.ts"]);
    }
    assertAbsentOnDisk(dir, [
      ...(level < 1 ? ["MessageBodyUnique"] : []),
      ...(level < 2 ? ["ToolOutputUnique", "VerificationOutputUnique"] : []),
      ...(level < 3 ? ["FullDiffUnique"] : []),
    ]);
  });
}

test("既定は道具の出力まで保存し、差分の全文を保存しない", (t) => {
  const { ledger } = createFixture(t);
  ledger.append({ ...createInput(), payload: {
    ...createInput().payload, body: { text: "発言", nested: { diff: "保存外" } }, tool_output: "出力",
  } });
  const fact = ledger.readSince(0, 1)[0];
  assert.ok(fact.kind === "message.created");
  assert.deepEqual(fact.payload?.body, { text: "発言", nested: {} });
  assert.equal(fact.payload?.tool_output, "出力");
});

test("発言形式に入った道具の出力も保存範囲に従う", (t) => {
  const { dir, ledger } = createFixture(t, { storageScope: "message_body" });
  ledger.append({ ...createInput("tool"), payload: {
    ...createInput().payload, role: "tool", body: "ToolRoleOutputUnique",
  } });
  ledger.append({ ...createInput("blocks"), payload: {
    ...createInput().payload, body: [
      { type: "text", text: "発言" },
      { type: "tool_result", content: "NestedToolOutputUnique" },
    ],
  } });
  assertAbsentOnDisk(dir, ["ToolRoleOutputUnique", "NestedToolOutputUnique"]);
});

test("2 つの接続の交互の追記を全て保存し、再開しても保持する", (t) => {
  const { ledger, path } = createFixture(t);
  const other = openLedger(path);
  try {
    for (let index = 0; index < 40; index += 1) {
      assert.equal((index % 2 === 0 ? ledger : other).append(createInput(`alternating-${index}`)).status, "appended");
    }
    assert.equal(other.readSince(0, 100).length, 40);
  } finally { other.close(); }
  const reopened = openLedger(path);
  try { assert.equal(reopened.readSince(0, 100).length, 40); }
  finally { reopened.close(); }
});

function runWriter(path: string, prefix: string): Promise<void> {
  const moduleUrl = new URL("../../src/ledger/ledger.ts", import.meta.url).href;
  const script = `
    import { openLedger } from ${JSON.stringify(moduleUrl)};
    const ledger = openLedger(process.argv[1]);
    for (let i = 0; i < 80; i++) {
      ledger.append({
        source: 'hook', source_event_id: process.argv[2] + i,
        kind: 'connection.created', subject: 'connection:' + process.argv[2] + i,
        payload: { run_id: 'r1', type: 'mcp', fingerprint: process.argv[2] + i, state: 'connected' },
        source_ts: '${SOURCE_TS}', confidence: 'confirmed'
      });
    }
    ledger.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, path, prefix], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
}

test("2 プロセスの同時追記と初回のスキーマ作成が競合しても全件残る", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-graph-ledger-concurrent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.db");
  await Promise.all([runWriter(path, "first-"), runWriter(path, "second-")]);
  const ledger = openLedger(path);
  try {
    const facts = ledger.readSince(0, 200);
    assert.equal(facts.length, 160);
    assert.equal(new Set(facts.map((fact) => fact.fact_id)).size, 160);
  } finally { ledger.close(); }
});

test("WAL 切り替えのロック競合は解除を待って起動する", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-graph-ledger-wal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.db");
  const blocker = new DatabaseSync(path);
  blocker.exec("BEGIN IMMEDIATE");
  let locked = true;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const moduleUrl = new URL("../../src/ledger/ledger.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { openLedger } from ${JSON.stringify(moduleUrl)};
    const probe = new DatabaseSync(process.argv[1]);
    assert.throws(() => probe.exec('PRAGMA journal_mode = WAL'), { errcode: 5 });
    probe.close();
    process.stdout.write('locked');
    const ledger = openLedger(process.argv[1]);
    ledger.append(${JSON.stringify(createInput("wal-retry"))});
    ledger.close();
  `;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      // 子が実際の SQLITE_BUSY を確認してから、起動の再試行中にロックを解除する。
      child.stdout.once("data", () => {
        releaseTimer = setTimeout(() => { blocker.exec("ROLLBACK"); locked = false; }, 100);
      });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
    });
  } finally {
    clearTimeout(releaseTimer);
    if (locked) blocker.exec("ROLLBACK");
    blocker.close();
  }
  const ledger = openLedger(path);
  try { assert.equal(ledger.readSince(0, 10)[0].source_event_id, "wal-retry"); }
  finally { ledger.close(); }
});

test("保持整理で payload だけを消し、再送も矛盾も行を増やさない", (t) => {
  const { ledger } = createFixture(t);
  const input = createInput();
  const first = ledger.append(input);
  ledger.append({ ...createInput("recent"), observed_ts: "2026-05-01T00:00:00.000Z" });
  assert.equal(ledger.prunePayloads(90, new Date("2026-05-01T00:00:00.000Z")), 1);
  const retained = ledger.readSince(0, 10)[0];
  assert.equal(retained.payload, null);
  assert.equal(retained.fact_id, first.fact_id);
  assert.equal(retained.payload_hash.length, 64);
  assert.equal(ledger.append(input).status, "duplicate");
  assert.equal(ledger.append(createInput("message-1", "違う本文")).status, "conflict");
  assert.deepEqual(ledger.readSince(0, 1)[0], retained);
  assert.equal(ledger.readSince(0, 10).length, 2);
  assert.equal(ledger.purgePayloads("2026-03-01T00:00:00.000Z"), 0);
});

test("保持整理は受信時刻で判定し、境界の行は残す", (t) => {
  const { ledger } = createFixture(t);
  ledger.append({ ...createInput("before"), observed_ts: "2025-12-31T23:59:59.000Z" });
  ledger.append(createInput("boundary"));
  assert.equal(ledger.purgePayloads(SOURCE_TS), 1);
  assert.notEqual(ledger.readSince(0, 10)[1].payload, null);
});

test("保存範囲を変えて再送しても保持済みの本文を復活させない", (t) => {
  const { ledger, path } = createFixture(t, { storageScope: "metadata" });
  const input = createInput();
  ledger.append(input);
  const other = openLedger(path, { storageScope: "full_diff" });
  try { assert.equal(other.append(input).status, "duplicate"); }
  finally { other.close(); }
  const fact = ledger.readSince(0, 1)[0];
  assert.ok(fact.kind === "message.created");
  assert.equal(fact.payload?.body, undefined);
});

test("readSince は seq の昇順で指定件数を返し、境界を含めない", (t) => {
  const { ledger } = createFixture(t);
  const ids = ["c", "a", "b", "d", "e"];
  const appended = ids.map((id) => ledger.append(createInput(id)));
  const page = ledger.readSince(appended[0].seq, 2);
  assert.deepEqual(page.map((fact) => fact.source_event_id), ["a", "b"]);
  assert.deepEqual(ledger.readSince(page[1].seq, 10).map((fact) => fact.source_event_id), ["d", "e"]);
  assert.deepEqual(ledger.readSince(0, 0), []);
  assert.deepEqual(ledger.readSince(appended[4].seq, 1), []);
  assert.throws(() => ledger.readSince(0, -1), RangeError);
  assert.throws(() => ledger.readSince(0.5, 1), RangeError);
});

test("訂正は元の事実を残し、supersedes を持つ新しい事実になる", (t) => {
  const { ledger } = createFixture(t);
  const first = ledger.append(createInput());
  ledger.append({
    ...createInput("correction"), kind: "message.corrected", subject: "message:message-1",
    payload: { body: "訂正本文" }, supersedes: first.fact_id,
  });
  const facts = ledger.readSince(0, 10);
  assert.equal(facts.length, 2);
  assert.equal(facts[1].supersedes, facts[0].fact_id);
  assert.ok(facts[0].kind === "message.created");
  assert.equal(facts[0].payload?.body, "本文");
});

test("全投影表と schema_version を持ち、facts への外部キーを持たない", (t) => {
  const { path } = createFixture(t);
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("SELECT version FROM schema_version WHERE id = 1").get()?.version, SCHEMA_VERSION);
    const tables = ["tasks", "conversations", "relations", "runs", "connections", "messages", "delegations", "artifacts", "aliases", "approvals", "findings", "message_memberships", "projection_state"];
    for (const name of tables) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(${name})`).all(), []);
    }
    assert.equal(db.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()?.last_seq, 0);
    assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  } finally { db.close(); }
});

test("追加の秘匿規則が本文のキー名を変えても保存範囲を迂回しない", (t) => {
  const { ledger, dir } = createFixture(t, {
    storageScope: "metadata", redactionRules: { patterns: ["body"] },
  });
  ledger.append(createInput("renamed-key", "OmittedBodyUnique"));
  assertAbsentOnDisk(dir, ["OmittedBodyUnique"]);
});

test("取得した秘匿規則の変更は台帳の保存規則を変えない", (t) => {
  const { ledger } = createFixture(t, { redactionRules: { defaults: false, patterns: [/private-value/i] } });
  const rules = ledger.getRedactionRules();
  rules.defaults = true;
  rules.patterns = [];
  ledger.append(createInput("custom", "PRIVATE-VALUE"));
  assert.ok(!JSON.stringify(ledger.readSince(0, 100)).includes("PRIVATE-VALUE"));
  assert.equal(ledger.getRedactionRules().defaults, false);
  assert.equal((ledger.getRedactionRules().patterns![0] as RegExp).source, "private-value");
});
