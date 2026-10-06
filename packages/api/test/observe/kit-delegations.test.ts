import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createRequestId } from "../../../core/src/intake/index.ts";
import { openLedger, projectConversations, projectDelegations, projectRelations } from "../../../core/src/ledger/index.ts";
import { FakeHost } from "../../../runner/src/host/contract.ts";
import { Intake } from "../../../runner/src/intake/index.ts";
import { RunnerRuntime } from "../../../runner/src/runtime.ts";
import { createKitDelegationObserver, createKitObserver, kitEventsPath, observeKitDelegationsFile } from "../../src/observe/kit/index.ts";

const TS = "2026-01-01T00:00:00Z";
const SESSION = "sample-repo-001";
function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-delegations-"));
  const root = join(directory, "repo");
  const state = join(root, ".agents", "state");
  mkdirSync(state, { recursive: true });
  const path = kitEventsPath(root);
  const ledger = openLedger(join(directory, "ledger.sqlite"));
  ledger.append({ source: "ui", source_event_id: "project", source_ts: TS, kind: "project.created", subject: "project:repo",
    confidence: "confirmed", payload: { repository_id: "repo", root_path: root, name_prefix: "repo", display_name: "repo", state: "registered" } });
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  function addConversation(id: string, provider: "claude" | "codex" = "claude", name = SESSION) {
    ledger.append({ source: "hook", source_event_id: id, source_ts: TS, confidence: "confirmed",
      kind: "conversation.created", subject: `conversation:${id}`, payload: { provider, native_id: `native-${id}`,
        origin: "observed", type: "interactive", history_format: "jsonl" } });
    const entityId = projectConversations(ledger.readSince(0, 1000)).conversations.find((c) => c.native_id === `native-${id}`)!.id;
    ledger.append({ source: "kit", source_event_id: `alias:${id}`, source_ts: TS, confidence: "confirmed",
      kind: "alias.created", subject: `alias:${id}`, payload: { entity_id: entityId, kind: "kit", name } });
    return entityId;
  }
  return { ledger, root, state, path, addConversation, observer: createKitDelegationObserver(ledger),
    facts: () => ledger.readSince(0, 10000) };
}
function start(nodeId = "codex-01", extra: object = {}) {
  return { ts: TS, event: "codex_start", session: SESSION, node_id: nodeId, parent: "root",
    description: "架空の依頼", task: "架空の変更", model: "fixture-model", accept: ["fixture-check"], ...extra };
}
function done(nodeId = "codex-01", extra: object = {}) {
  return { ts: "2026-01-01T00:01:00Z", event: "codex_done", session: SESSION, node_id: nodeId,
    status: "done", exit_code: 0, verify: { passed: true, results: [] }, ...extra };
}
function encode(...rows: object[]) { return rows.map((row) => JSON.stringify(row) + "\n").join(""); }
function snapshot(path: string): unknown {
  const stat = statSync(path, { bigint: true });
  return { mtime: stat.mtimeNs, mode: stat.mode, content: stat.isDirectory()
    ? readdirSync(path).sort().map((name) => [name, snapshot(join(path, name))]) : readFileSync(path) };
}

test("実物の形式から source=kit の委譲と結果を取り込み、再読込・再起動で増えない", (t) => {
  const f = createFixture(t);
  const ignored = encode({ ts: TS, event: "turn_start", session: SESSION });
  writeFileSync(f.path, ignored + encode(start(), done()));
  f.observer.observe();
  const delegations = projectDelegations(f.facts());
  assert.equal(delegations.length, 1);
  const requestId = createRequestId({ source: "kit", file: f.path, position: Buffer.byteLength(ignored) });
  assert.equal(delegations[0].request_id, requestId);
  assert.equal(delegations[0].state, "done");
  assert.equal(delegations[0].title, "架空の依頼");
  assert.deepEqual(delegations[0].result, { status: "done", exit_code: 0, verify: { passed: true, results: [] } });
  const creations = f.facts().filter((fact) => fact.kind === "delegation.created");
  assert.equal(creations[0].source, "kit");
  assert.equal((creations[0].payload as unknown as { request: { source: string } }).request.source, "kit");
  assert.ok(f.facts().every((fact) => !["run.created", "conversation.created"].includes(fact.kind)));
  const count = f.facts().length;
  assert.deepEqual(f.observer.observe(), []);
  assert.deepEqual(createKitDelegationObserver(f.ledger).observe(), []);
  assert.equal(f.facts().length, count);
  assert.deepEqual(projectDelegations(f.facts().reverse()), delegations);
  const cursor = JSON.parse(f.facts().filter((fact) => fact.cursor).at(-1)!.cursor!);
  assert.equal(cursor.path, f.path);
  assert.equal(cursor.offset, Buffer.byteLength(readFileSync(f.path)));
  assert.match(cursor.hash, /^[a-f0-9]{64}$/);
});

test("終了行が後から追記されても cursor と開始の対応を台帳から復旧する", (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode(start()));
  f.observer.observe();
  assert.equal(projectDelegations(f.facts())[0].state, "running");
  appendFileSync(f.path, encode(done("codex-01", { status: "failed", exit_code: 0, verify: { passed: false } })));
  createKitDelegationObserver(f.ledger).observe();
  assert.equal(projectDelegations(f.facts()).length, 1);
  assert.equal(projectDelegations(f.facts())[0].state, "failed");
  assert.deepEqual(projectDelegations(f.facts())[0].result, { status: "failed", exit_code: 0, verify: { passed: false } });
  assert.deepEqual(f.observer.observe(), []);
});

for (const count of [0, 1, 2]) test(`会話名の一致 ${count} 件では親は ${count === 1 ? "inferred" : "unknown"}`, (t) => {
  const f = createFixture(t);
  for (let i = 0; i < count; i += 1) f.addConversation(`parent-${i}`);
  writeFileSync(f.path, encode(start(), done()));
  f.observer.observe();
  const relation = projectRelations(f.facts())[0];
  assert.equal(relation.type, "delegated");
  assert.equal(relation.confidence, count === 1 ? "inferred" : "unknown");
  assert.equal(projectDelegations(f.facts())[0].parent.confidence, "unknown");
});

for (const matches of [true, false]) test(`親の native ID が台帳と${matches ? "一致する場合だけ confirmed" : "一致しない場合は unknown"}`, (t) => {
  const f = createFixture(t);
  const parentId = f.addConversation("parent");
  f.addConversation("other");
  const childId = f.addConversation("child", "codex", "child-name");
  writeFileSync(f.path, encode(start("codex-01", {
    parent_native_id: matches ? "native-parent" : "missing", parent_provider: "claude", native_id: "native-child",
  }), done()));
  f.observer.observe();
  const relation = projectRelations(f.facts())[0];
  assert.equal(relation.confidence, matches ? "confirmed" : "unknown");
  assert.equal(relation.from_id, matches ? parentId : undefined);
  assert.equal(relation.to_id, childId);
  assert.equal(projectDelegations(f.facts())[0].parent.confidence, matches ? "confirmed" : "unknown");
});

test("同じ名前と node_id の再利用でも開始位置が違えば別の委譲になる", (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode(start(), done(), start("codex-01", { ts: "2026-01-02T00:00:00Z" }),
    done("codex-01", { ts: "2026-01-02T00:01:00Z", status: "interrupted" })));
  f.observer.observe();
  assert.equal(projectDelegations(f.facts()).length, 2);
  assert.deepEqual(projectDelegations(f.facts()).map((d) => d.state).sort(), ["done", "interrupted"]);
});

test("書きかけ・無関係・不正な行を越えて、完全な開始と終了だけ読む", (t) => {
  const f = createFixture(t);
  const partial = JSON.stringify(start());
  writeFileSync(f.path, "{broken}\n" + encode({ event: "codex_start" }, { ...start(), ts: "invalid" }) + partial.slice(0, -1));
  assert.deepEqual(f.observer.observe(), []);
  appendFileSync(f.path, partial.slice(-1) + "\n" + encode(done()));
  f.observer.observe();
  assert.equal(projectDelegations(f.facts()).length, 1);
  assert.equal(projectDelegations(f.facts())[0].state, "done");
});

test("途中の台帳追記失敗では cursor を進めず、再読で一件に復旧する", (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode(start(), done()));
  const append = f.ledger.append;
  let calls = 0;
  f.ledger.append = (fact) => { if (++calls === 2) throw new Error("fixture append failure"); return append(fact); };
  assert.throws(() => f.observer.observe(), /fixture append failure/);
  assert.equal(f.facts().filter((fact) => fact.cursor).length, 0);
  f.ledger.append = append;
  f.observer.observe();
  assert.equal(projectDelegations(f.facts()).length, 1);
  assert.equal(projectDelegations(f.facts())[0].state, "done");
});

test(".agents の全ファイルの内容・更新時刻・権限を変えず、counter を読まない", (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode(start(), done()));
  mkdirSync(join(f.state, "counter"));
  writeFileSync(join(f.state, "counter", "sentinel"), "fixture");
  writeFileSync(join(f.state, "sessions.json"), "fixture sessions");
  writeFileSync(join(f.state, "counter.lock"), "fixture lock");
  const before = snapshot(join(f.root, ".agents"));
  f.observer.observe();
  f.observer.observe();
  assert.deepEqual(snapshot(join(f.root, ".agents")), before);
});

test("欠けたファイル・未登録プロジェクトを安全に保留し、開始欠落の終了も記録する", (t) => {
  const f = createFixture(t);
  assert.deepEqual(observeKitDelegationsFile(f.ledger, f.path), []);
  writeFileSync(f.path, encode(done()));
  f.ledger.append({ source: "ui", source_event_id: "unregister", source_ts: "2026-01-02T00:00:00Z",
    kind: "project.state_changed", subject: "project:repo", confidence: "confirmed", payload: { state: "unregistered" } });
  assert.deepEqual(f.observer.observe(), []);
  observeKitDelegationsFile(f.ledger, f.path);
  assert.equal(projectDelegations(f.facts())[0].state, "done");
  assert.equal(f.facts().find((fact) => fact.kind === "delegation.created")!.confidence, "unknown");
});

test("同じ内容のファイル置換でも位置由来の requestId は変わらない", (t) => {
  const f = createFixture(t);
  const content = encode(start(), done());
  writeFileSync(f.path, content);
  f.observer.observe();
  const count = f.facts().length;
  const temporary = join(f.state, "replacement.jsonl");
  writeFileSync(temporary, content);
  // inode の置換を行い、共通読み手の reset 経路を検証する。
  renameSync(temporary, f.path);
  f.observer.observe();
  assert.equal(f.facts().filter((fact) => fact.kind !== "delegation.updated").length,
    count - 2);
  assert.equal(projectDelegations(f.facts()).length, 1);
  assert.deepEqual(f.observer.observe(), []);
});

test("既存の kit 観測経路で取り込み、runner の復旧と終了済み依頼の再送でホストを起動しない", async (t) => {
  const f = createFixture(t);
  writeFileSync(join(f.state, "sessions.json"), "{}");
  writeFileSync(f.path, encode(start(), done(), start("codex-02")));
  assert.ok(createKitObserver(f.ledger).observe().appended > 0);
  const codex = new FakeHost("codex");
  const claude = new FakeHost("claude");
  const runtime = new RunnerRuntime(f.ledger, [codex, claude], () => {}, "shared");
  const intake = new Intake(f.ledger, runtime, { cwd: f.root });
  try {
    await intake.recover();
    const creation = f.facts().find((fact) => fact.kind === "delegation.created")!;
    const request = (creation.payload as unknown as { request: unknown }).request;
    assert.equal(intake.submit(request).state, "done");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(codex.starts.length, 0);
    assert.equal(claude.starts.length, 0);
  } finally { await intake.close(); }
});

for (const replace of [true, false]) test(`前方の行を削除した${replace ? "置換" : "上書き"}でも既存の委譲 ID を維持する`, (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode({ ts: TS, event: "session_start", session: "", session_id: "unnamed" }, start()));
  f.observer.observe();
  const requestId = projectDelegations(f.facts())[0].request_id;
  const content = encode(start(), done());
  if (replace) {
    const temporary = join(f.state, "replacement.jsonl");
    writeFileSync(temporary, content);
    renameSync(temporary, f.path);
  } else writeFileSync(f.path, content);
  const before = snapshot(join(f.root, ".agents"));
  createKitDelegationObserver(f.ledger).observe();
  const delegations = projectDelegations(f.facts());
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0].request_id, requestId);
  assert.equal(delegations[0].state, "done");
  assert.deepEqual(createKitDelegationObserver(f.ledger).observe(), []);
  assert.deepEqual(snapshot(join(f.root, ".agents")), before);
});

test("移動した開始行が別の開始位置に重なっても元の委譲に終了を結ぶ", (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode(start("codex-01"), start("codex-02")));
  f.observer.observe();
  const requestId = projectDelegations(f.facts()).find((entry) => entry.request_id !== createRequestId({ source: "kit", file: f.path, position: 0 }))!.request_id;
  const temporary = join(f.state, "replacement.jsonl");
  writeFileSync(temporary, encode(start("codex-02"), done("codex-02")));
  renameSync(temporary, f.path);
  f.observer.observe();
  assert.equal(projectDelegations(f.facts()).length, 2);
  assert.equal(projectDelegations(f.facts()).find((entry) => entry.request_id === requestId)!.state, "done");
  assert.deepEqual(f.observer.observe(), []);
});

test("新規行の位置衝突は未対応として残し、後続行と後続プロジェクトを取り込む", (t) => {
  const f = createFixture(t);
  writeFileSync(f.path, encode(start()));
  f.observer.observe();
  const temporary = join(f.state, "replacement.jsonl");
  writeFileSync(temporary, encode(start("codex-conflict"), start("codex-next"), done("codex-next")));
  renameSync(temporary, f.path);
  const secondRoot = join(f.root, "second");
  mkdirSync(join(secondRoot, ".agents", "state"), { recursive: true });
  writeFileSync(kitEventsPath(secondRoot), encode(start("codex-other"), done("codex-other")));
  f.ledger.append({ source: "ui", source_event_id: "second-project", source_ts: TS, confidence: "confirmed",
    kind: "project.created", subject: "project:second", payload: { repository_id: "second", root_path: secondRoot, display_name: "second", name_prefix: "second", state: "registered" } });
  const observer = createKitObserver(f.ledger);
  assert.doesNotThrow(() => observer.observe());
  const unsupported = f.facts().filter((fact) => fact.kind === "observation.unsupported");
  assert.equal(unsupported.length, 1);
  assert.match(unsupported[0].payload!.reason as string, /Conflicting kit event/);
  assert.ok(unsupported[0].cursor);
  assert.deepEqual(projectDelegations(f.facts()).map((entry) => entry.state).sort(), ["done", "done", "running"]);
  const count = f.facts().length;
  assert.doesNotThrow(() => createKitObserver(f.ledger).observe());
  assert.equal(f.facts().length, count);
});
