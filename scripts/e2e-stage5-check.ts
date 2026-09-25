import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repoKey, stateDbPath } from "../packages/core/src/paths.ts";
import { openStore } from "../packages/core/src/store/store.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const store = openStore(stateDbPath(repoKey(root)));
try {
  if (process.argv[2] === "hook") {
    const hooks = store.db.prepare(`SELECT s.id FROM sessions s JOIN events e ON e.session_id = s.id
      WHERE s.client = 'claude' AND e.kind = 'session.started'`).all();
    if (hooks.length) {
      console.log("U7: generated plugin delivered callable MCP and SessionStart hook together");
      console.log("U10: SessionStart in claude -p registered a claude session and session.started");
    } else {
      const execution = store.db.prepare(`SELECT s.id FROM sessions s JOIN events e ON e.session_id = s.id
        WHERE s.id = 'e2e-claude' AND s.client = 'claude' AND e.kind = 'execution.started'`).get();
      assert.ok(execution, "fallback must retain the session with execution adapter evidence");
      console.log("U7: generated plugin MCP call passed; hook delivery remains unconfirmed");
      console.log("U10: no SessionStart registration observed in claude -p; verified MCP session with execution.started as fallback (hook nonexecution and delivery failure cannot be distinguished)");
    }
  } else {
    const rows = store.db.prepare("SELECT status FROM delegations").all();
    assert.equal(rows.length, 2, "both clients must call delegate exactly once");
    assert.ok(rows.every((row) => row.status === "done"), "every delegation must finish done");
    console.log("PASS: both generated registrations produced done delegations");
  }
} finally { store.close(); }
