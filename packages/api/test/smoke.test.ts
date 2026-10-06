import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openLedger, rebuild } from "../../core/src/ledger/index.ts";
import type { FactInput } from "../../core/src/ledger/index.ts";
import { ledgerDbPath } from "../src/index.ts";

test("一時ディレクトリの台帳へ追記し、投影を再構築できる", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-api-ledger-"));
  const ledgerPath = ledgerDbPath({ XDG_STATE_HOME: directory });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const ledger = openLedger(ledgerPath);
  const database = new DatabaseSync(ledgerPath);
  t.after(() => {
    database.close();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input: FactInput = {
    source: "transcript-claude",
    source_event_id: "smoke-conversation",
    kind: "conversation.created",
    subject: "conversation:smoke",
    payload: {
      provider: "claude",
      native_id: "smoke",
      origin: "observed",
      type: "interactive",
      history_format: "jsonl",
    },
    source_ts: "2026-01-01T00:00:00.000Z",
    confidence: "confirmed",
  };

  const appended = ledger.append(input);
  assert.equal(appended.status, "appended");
  assert.deepEqual(ledger.append(input), { ...appended, status: "duplicate" });
  assert.equal(ledger.readSince(0, 10).length, 1);
  assert.deepEqual(rebuild(database), { generation: 1, last_seq: appended.seq });
  const conversations = database.prepare("SELECT * FROM conversations").all();
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].native_id, "smoke");
  assert.equal(conversations[0].origin, "observed");
  assert.deepEqual(rebuild(database), { generation: 2, last_seq: appended.seq });
  assert.deepEqual(database.prepare("SELECT * FROM conversations").all(), conversations);
});
