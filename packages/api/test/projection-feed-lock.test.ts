import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openObservationService } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";

for (const restart of [false, true]) {
  test(`要約の途中も別の書き手が追記でき、失敗後の${restart ? "再起動" : "refresh"}で全変更が残る`, t => {
    const home = mkdtempSync(join(tmpdir(), "api-feed-lock-"));
    const dbPath = join(home, "ledger.db");
    const service = openObservationService({ home, env: { HOME: home }, dbPath });
    let feed = new ProjectionFeed(dbPath, service.catchUp);
    const writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA busy_timeout = 0");
    t.after(() => { writer.close(); feed.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
    const timestamp = new Date().toISOString();
    for (const id of ["a", "b", "c"]) {
      service.ledger.append({ source: "host-codex", source_event_id: `create-${id}`, kind: "conversation.created",
        subject: `conversation:${id}`, source_ts: timestamp, confidence: "confirmed",
        payload: { provider: "codex", native_id: id, origin: "managed", type: "interactive", history_format: "legacy" } });
      service.ledger.append({ source: "host-codex", source_event_id: `message-${id}`, kind: "message.created",
        subject: `message:${id}`, source_ts: timestamp, confidence: "confirmed",
        payload: { provider: "codex", native_id: id, version: 1, role: "assistant", body: id, body_state: "stored" } });
      service.ledger.append({ source: "host-codex", source_event_id: `member-${id}`, kind: "message_membership.created",
        subject: `message_membership:${id}`, source_ts: timestamp, confidence: "confirmed",
        payload: { conversation_id: id, message_id: id, active: true } });
    }
    const summaries = feed as unknown as { updateSummary(id: string): void };
    const update = summaries.updateSummary.bind(feed);
    let processed = 0;
    const mock = t.mock.method(summaries, "updateSummary", (id: string) => {
      update(id);
      // 要約処理の途中で別接続の書き込み取引が完了する。
      writer.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER); INSERT INTO lock_probe VALUES (1); COMMIT");
      if (++processed === 2) throw new Error("interrupted summary");
    });
    assert.throws(() => feed.refresh(), /interrupted summary/);
    assert.equal(writer.prepare("SELECT count(*) AS n FROM lock_probe").get()!.n, 2);
    assert.ok(Number(writer.prepare("SELECT count(*) AS n FROM api_projection_changes").get()!.n) > 0);
    mock.mock.restore();
    if (restart) { feed.close(); feed = new ProjectionFeed(dbPath, service.catchUp); }
    else {
      const patch = feed.refresh();
      assert.ok(patch && patch !== "resync");
      assert.equal(patch.changes.conversations.upsert.length, 3);
    }
    assert.equal(feed.snapshot().seq, service.lastSeq());
    assert.deepEqual(writer.prepare("SELECT message_count FROM api_conversation_summaries ORDER BY id").all()
      .map(row => row.message_count), [1, 1, 1]);
    assert.equal(writer.prepare("SELECT count(*) AS n FROM api_projection_changes").get()!.n, 0);
  });
}

test("要約と同一性の更新後に busy でも、再試行の patch に既に書いたプロジェクトを含める", t => {
  const home = mkdtempSync(join(tmpdir(), "api-feed-retry-"));
  const dbPath = join(home, "ledger.db");
  const service = openObservationService({ home, env: { HOME: home }, dbPath });
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  t.after(() => { feed.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["a", "b", "c"]) service.ledger.append({ source: "ui", source_event_id: `project-${id}`,
    kind: "project.created", subject: `project:${id}`, source_ts: new Date().toISOString(), confidence: "confirmed",
    payload: { repository_id: id, root_path: join(home, id), display_name: id, name_prefix: id, state: "unregistered" } });
  const queues = feed as unknown as { updateInputQueues(ids?: string[]): void };
  const mock = t.mock.method(queues, "updateInputQueues", () => {
    throw Object.assign(new Error("busy after project writes"), { errcode: 5 });
  });
  assert.equal(feed.refresh(), undefined);
  mock.mock.restore();
  const patch = feed.refresh();
  assert.ok(patch && patch !== "resync");
  assert.deepEqual(patch.changes.projects.upsert.map(row => row.id).toSorted(), ["a", "b", "c"]);
  assert.equal(feed.snapshot().seq, service.lastSeq());
});
