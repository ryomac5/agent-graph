import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { allocateTaskNames, createNativeId, openLedger, projectNames, rebuild, searchNames } from "../../../core/src/ledger/index.ts";
import type { FactInput } from "../../../core/src/ledger/index.ts";
import { createKitObserver, createKitReader, kitNamesPath } from "../../src/observe/kit/index.ts";

const SAMPLE = new URL("../samples/S10/", import.meta.url);
const TS = "2026-01-01T00:00:00.000Z";
const DELAYED_ID = "22222222-2222-4222-8222-222222222222";

function readSample(name: string) {
  return JSON.parse(readFileSync(new URL(name, SAMPLE), "utf8"));
}

function createConversation(nativeId: string, provider: "claude" | "codex" = "claude"): FactInput {
  return {
    source: "hook", source_event_id: `${provider}:${nativeId}`, kind: "conversation.created",
    subject: `conversation:${provider}:${nativeId}`,
    payload: { provider, native_id: nativeId, origin: "observed", type: "interactive", history_format: "jsonl" },
    source_ts: TS, confidence: "confirmed",
  };
}

function openFixture(t: TestContext, reverse = false) {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-kit-"));
  const ledgerPath = join(directory, "ledger.sqlite");
  const ledger = openLedger(ledgerPath);
  const database = new DatabaseSync(ledgerPath);
  t.after(() => {
    database.close();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const roots = { "agent-graph": join(directory, "agent-graph"), dotfiles: join(directory, "dotfiles") };
  const inputs: FactInput[] = [];
  for (const [id, root] of Object.entries(roots)) {
    mkdirSync(join(root, ".agents", "state"), { recursive: true });
    copyFileSync(new URL(id === "dotfiles" ? "dotfiles.sessions.json" : "sessions.json", SAMPLE), kitNamesPath(root));
    utimesSync(kitNamesPath(root), new Date(TS), new Date(TS));
    inputs.push({
      source: "ui", source_event_id: `register:${id}`, kind: "project.created", subject: `project:${id}`,
      payload: { repository_id: id, root_path: root, display_name: id, name_prefix: id, state: "registered" },
      source_ts: TS, confidence: "confirmed",
    });
    const sessions = JSON.parse(readFileSync(kitNamesPath(root), "utf8"));
    for (const nativeId of Object.keys(sessions)) inputs.push(createConversation(nativeId));
  }
  for (const input of reverse ? inputs.reverse() : inputs) ledger.append(input);
  return { roots, ledger, database, observer: createKitObserver(ledger) };
}

function readFileState(directory: string): unknown[] {
  return readdirSync(directory).sort().map((name) => {
    const path = join(directory, name);
    const stat = statSync(path, { bigint: true });
    return [name, stat.mtimeNs, stat.isDirectory() ? readFileState(path) : readFileSync(path, "utf8")];
  });
}

test("S10: 全番号を別名で検索でき、再読込・再起動・順序変更・再構築でも増えない", (t) => {
  for (const reverse of [false, true]) {
    const { roots, ledger, database, observer } = openFixture(t, reverse);
    assert.deepEqual(observer.observe(), { appended: 5, duplicates: 0, pending: 0, deferred: 0 });
    const initialCount = ledger.readSince(0, Number.MAX_SAFE_INTEGER).length;
    copyFileSync(new URL("delayed.sessions.json", SAMPLE), kitNamesPath(roots["agent-graph"]));
    assert.equal(observer.observe().pending, 1);
    assert.equal(ledger.readSince(0, Number.MAX_SAFE_INTEGER).length, initialCount);
    ledger.append(createConversation(DELAYED_ID));
    assert.equal(observer.observe().appended, 1);
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const aliases = facts.filter((fact) => fact.kind === "alias.created").map(({ source, kind, confidence, payload }) =>
      ({ source, kind, confidence, payload }));
    const sortAliases = (entries: typeof aliases) => entries.toSorted((a, b) => JSON.stringify(a.payload).localeCompare(JSON.stringify(b.payload)));
    assert.deepEqual(sortAliases(aliases), sortAliases(readSample("expected-ledger.json")));
    const names = projectNames(facts);
    assert.deepEqual(names.aliases, readSample("expected-projection.json"));
    assert.deepEqual(projectNames([...facts].reverse()), names);
    assert.equal(searchNames(names, "agent-graph-001", "kit").length, 2);
    assert.equal(observer.observe().appended, 0);
    assert.equal(createKitObserver(ledger).observe().appended, 0);
    assert.equal(ledger.readSince(0, Number.MAX_SAFE_INTEGER).length, facts.length);
    rebuild(database);
    const rows = database.prepare("SELECT * FROM aliases ORDER BY id").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), names.aliases);
    rebuild(database);
    assert.deepEqual(database.prepare("SELECT * FROM aliases ORDER BY id").all(), rows);

    for (const id of ["first", "second"]) ledger.append({
      source: "ui", source_event_id: id, kind: "task.created", subject: `task:${id}`,
      payload: { project: "agent-graph", purpose: "並行の採番", state: "open" }, source_ts: TS, confidence: "confirmed",
    });
    assert.deepEqual(allocateTaskNames(ledger.readSince(0, Number.MAX_SAFE_INTEGER)), [
      { task_id: "first", name: "agent-graph-1" }, { task_id: "second", name: "agent-graph-2" },
    ]);
  }
});

test("書きかけの JSON は前回の結果を保持し、同じ更新時刻でも次回に読み直す", (t) => {
  const { roots, ledger, observer } = openFixture(t);
  const root = roots["agent-graph"];
  const path = kitNamesPath(root);
  const reader = createKitReader();
  const previous = reader.readNames(root);
  observer.observe();
  const count = ledger.readSince(0, Number.MAX_SAFE_INTEGER).length;
  copyFileSync(new URL("partial.sessions.json", SAMPLE), path);
  utimesSync(path, new Date(TS), new Date(TS));
  assert.deepEqual(reader.readNames(root), { ...previous, deferred: true });
  assert.equal(observer.observe().deferred, 1);
  assert.equal(ledger.readSince(0, Number.MAX_SAFE_INTEGER).length, count);
  copyFileSync(new URL("delayed.sessions.json", SAMPLE), path);
  utimesSync(path, new Date(TS), new Date(TS));
  ledger.append(createConversation(DELAYED_ID));
  assert.equal(reader.readNames(root).names.get(DELAYED_ID), "agent-graph-015");
  assert.equal(observer.observe().appended, 1);
  assert.equal(observer.observe().appended, 0);
});

test(".agents の全ファイルの更新時刻と内容を保ち、counter が読めなくても取り込む", (t) => {
  const { roots, observer } = openFixture(t);
  for (const root of Object.values(roots)) {
    const state = join(root, ".agents", "state");
    // counter をディレクトリにして、ファイルとしての読み取りも検出する。
    mkdirSync(join(state, "counter"));
    writeFileSync(join(state, "counter", "sentinel"), "更新中の counter");
    writeFileSync(join(state, "counter.lock"), "ロック中");
    writeFileSync(join(state, "events.jsonl"), "旧キットの記録\n");
  }
  const before = Object.values(roots).map((root) => readFileState(join(root, ".agents")));
  assert.equal(observer.observe().appended, 5);
  assert.equal(observer.observe().appended, 0);
  assert.deepEqual(Object.values(roots).map((root) => readFileState(join(root, ".agents"))), before);
});

test("遅延した会話の番号をファイル更新後も保持し、名前の形式を限定しない", (t) => {
  const { roots, ledger, observer } = openFixture(t);
  const path = kitNamesPath(roots["agent-graph"]);
  writeFileSync(path, JSON.stringify({ [DELAYED_ID]: "任意の名前 / 枝 α" }));
  assert.equal(observer.observe().pending, 1);
  writeFileSync(path, "{}");
  ledger.append(createConversation(DELAYED_ID));
  assert.equal(observer.observe().appended, 1);
  assert.deepEqual(searchNames(projectNames(ledger.readSince(0, Number.MAX_SAFE_INTEGER)), "任意の名前 / 枝 α", "kit"),
    [createNativeId("claude", DELAYED_ID)]);
});

test("未登録プロジェクトを読まず、provider が曖昧な会話には別名を結ばない", (t) => {
  const { roots, ledger, observer } = openFixture(t);
  ledger.append({
    source: "ui", source_event_id: "unregister", kind: "project.state_changed", subject: "project:dotfiles",
    payload: { state: "unregistered" }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed",
  });
  writeFileSync(kitNamesPath(roots.dotfiles), "{");
  const sharedId = Object.keys(readSample("sessions.json"))[0];
  ledger.append(createConversation(sharedId, "codex"));
  assert.deepEqual(observer.observe(), { appended: 3, duplicates: 0, pending: 1, deferred: 0 });
});

test("初回の欠落や壊れた辞書は保留し、正常な辞書になれば取り込む", (t) => {
  const { roots, observer } = openFixture(t);
  const root = roots["agent-graph"];
  const reader = createKitReader();
  assert.deepEqual(reader.readNames(join(root, "missing")), { names: new Map(), source_ts: null, deferred: true });
  for (const data of ["{", "null", "[]", '{"id":42}']) {
    writeFileSync(kitNamesPath(root), data);
    assert.equal(reader.readNames(root).deferred, true);
    assert.equal(observer.observe().appended, data === "{" ? 1 : 0);
  }
  copyFileSync(new URL("sessions.json", SAMPLE), kitNamesPath(root));
  assert.equal(observer.observe().appended, 4);
});
