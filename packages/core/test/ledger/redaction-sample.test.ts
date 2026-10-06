import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyIncremental, openLedger, PROJECTION_TABLES, rebuild } from "../../src/ledger/index.ts";
import type { FactInput, StorageScope } from "../../src/ledger/index.ts";

const SOURCE_TS = "2026-01-01T00:00:00Z";
const BASE = { source: "host-codex", source_ts: SOURCE_TS, observed_ts: SOURCE_TS, confidence: "confirmed" } as const;
const KEY_SAMPLES = [
  "sk-ant-abcdefghijklmnopqrstuvwxyz123456",
  "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
  "sk-svcacct-abcdefghijklmnopqrstuvwxyz123456",
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  `ghp_${"a".repeat(36)}`,
  "github_pat_abcdefghijklmnopqrstuvwxyz",
  "AKIAABCDEFGHIJKLMNOP",
  "ASIAABCDEFGHIJKLMNOP",
  "xoxb-1234567890-abcdefghijk",
  `AIza${"a".repeat(35)}`,
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
];
const ENV_SECRET = "sample-password-value";
const PRIVATE_CONTENT = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=";
const PRIVATE_BLOCK = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_CONTENT}\n-----END PRIVATE KEY-----`;

function assertFilesRedacted(directory: string, originals: readonly string[]): void {
  const files = readdirSync(directory);
  assert.ok(files.includes("ledger.sqlite"));
  for (const file of files) {
    const bytes = readFileSync(join(directory, file));
    for (const original of originals) {
      for (const representation of [original, JSON.stringify(original).slice(1, -1)]) {
        assert.equal(bytes.includes(Buffer.from(representation)), false, `${file}: 元の文字列が残っています`);
      }
    }
  }
}

function assertTablesRedacted(database: DatabaseSync, originals: readonly string[]): void {
  const contents = JSON.stringify(PROJECTION_TABLES.map((table) => database.prepare(`SELECT * FROM ${table}`).all()));
  for (const original of originals) {
    assert.equal(contents.includes(original), false);
    assert.equal(contents.includes(JSON.stringify(original).slice(1, -1)), false);
  }
}

const REDACTION_SAMPLES = [
  ...KEY_SAMPLES.map((key, index) => ({ name: `既知の鍵 ${index}`, text: `key: ${key}`, originals: [key] })),
  { name: ".env の行", text: `export DATABASE_PASSWORD="${ENV_SECRET}"`, originals: [ENV_SECRET] },
  { name: "秘密鍵のブロック", text: PRIVATE_BLOCK, originals: [PRIVATE_BLOCK, PRIVATE_CONTENT] },
  { name: "終端のない秘密鍵", text: `-----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_CONTENT}`, originals: [PRIVATE_CONTENT] },
  { name: "差分の中の鍵", text: `diff --git a/.env b/.env\n+API_KEY=${KEY_SAMPLES[0]}\n-PASSWORD=${ENV_SECRET}`, originals: [KEY_SAMPLES[0], ENV_SECRET] },
];

for (const sample of REDACTION_SAMPLES) {
  test(`${sample.name}: 台帳・投影表・DB と WAL のファイルに秘密が残らない`, () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-redaction-"));
    const path = join(directory, "ledger.sqlite");
    const ledger = openLedger(path, { storageScope: "full_diff" });
    const database = new DatabaseSync(path);
    try {
      const message: FactInput = { ...BASE, source_event_id: "message", kind: "message.created", subject: "message:m", payload: { provider: "codex", native_id: "message", version: 1, role: "user", body: sample.text, body_state: "stored", tool_output: { stdout: sample.text } } };
      const artifact: FactInput = { ...BASE, source_event_id: "artifact", kind: "artifact.created", subject: "artifact:a", payload: { run_id: "run", version: 1, repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "head", patch_hash: "patch", untracked: [], diff: sample.text } };
      ledger.append(message);
      assertFilesRedacted(directory, sample.originals);
      applyIncremental(database, 0);
      ledger.append(artifact);
      assertFilesRedacted(directory, sample.originals);
      applyIncremental(database, 1);
      assert.equal(ledger.append(message).status, "duplicate");
      assert.equal(ledger.readSince(0, 10).length, 2);
      assertTablesRedacted(database, sample.originals);
      assertFilesRedacted(directory, sample.originals);
      const before = JSON.stringify(PROJECTION_TABLES.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
      rebuild(database);
      assert.equal(JSON.stringify(PROJECTION_TABLES.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all())), before);
      assert.ok(String(database.prepare("SELECT body FROM messages").get()!.body).includes("[REDACTED:"));
      assert.ok(String(database.prepare("SELECT tool_output FROM messages").get()!.tool_output).includes("[REDACTED:"));
      assert.ok(String(database.prepare("SELECT diff FROM artifacts").get()!.diff).includes("[REDACTED:"));
      assertTablesRedacted(database, sample.originals);
      assertFilesRedacted(directory, sample.originals);
    } finally {
      database.close(); ledger.close();
      try { assertFilesRedacted(directory, sample.originals); }
      finally { rmSync(directory, { recursive: true }); }
    }
  });
}

const SCOPE_SAMPLES: { scope: StorageScope; input: FactInput; table: "messages" | "artifacts"; column: "body" | "tool_output" | "diff"; originals: string[] }[] = [
  { scope: "metadata", input: { ...BASE, source_event_id: "scope", kind: "message.created", subject: "message:m",
    payload: { provider: "codex", native_id: "m", version: 1, role: "user", body_state: "stored", body: "本文は保存範囲外", tool_output: { stdout: "ツール出力は保存範囲外" } } },
    table: "messages", column: "body", originals: ["本文は保存範囲外", "ツール出力は保存範囲外"] },
  { scope: "message_body", input: { ...BASE, source_event_id: "scope", kind: "message.created", subject: "message:m",
    payload: { provider: "codex", native_id: "m", version: 1, role: "tool", body_state: "stored", tool_output: { stdout: "標準出力は保存範囲外" } } },
    table: "messages", column: "tool_output", originals: ["標準出力は保存範囲外"] },
  { scope: "tool_output", input: { ...BASE, source_event_id: "scope", kind: "artifact.created", subject: "artifact:a",
    payload: { run_id: "run", version: 1, repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "head", patch_hash: "patch", untracked: [], diff: "差分は保存範囲外" } },
    table: "artifacts", column: "diff", originals: ["差分は保存範囲外"] },
];
for (const sample of SCOPE_SAMPLES) {
  test(`${sample.scope}: 保存範囲外の本文は台帳と投影とファイルに残らない`, () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-scope-"));
    const path = join(directory, "ledger.sqlite");
    const ledger = openLedger(path, { storageScope: sample.scope });
    const database = new DatabaseSync(path);
    try {
      const input = sample.input;
      ledger.append(input);
      applyIncremental(database, 0);
      rebuild(database);
      const rows = database.prepare(`SELECT ${sample.column} FROM ${sample.table}`).all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0][sample.column], null);
      for (const original of sample.originals) assert.equal(JSON.stringify(ledger.readSince(0, 10)).includes(original), false);
      assertTablesRedacted(database, sample.originals);
      assertFilesRedacted(directory, sample.originals);
      assert.equal(ledger.append(input).status, "duplicate");
      assert.equal(ledger.purgePayloads("2026-01-02T00:00:00Z"), 1);
      assert.equal(ledger.readSince(0, 10)[0].payload, null);
      rebuild(database);
      assert.equal(ledger.append(input).status, "duplicate");
      assert.equal(ledger.readSince(0, 10).length, 1);
      assertTablesRedacted(database, sample.originals);
      assertFilesRedacted(directory, sample.originals);
    } finally {
      database.close(); ledger.close();
      try { assertFilesRedacted(directory, sample.originals); }
      finally { rmSync(directory, { recursive: true }); }
    }
  });
}
