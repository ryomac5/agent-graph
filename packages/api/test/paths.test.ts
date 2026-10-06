import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stateDbPath } from "../../core/src/paths.ts";
import { hookOutboxPath, ledgerDbPath } from "../src/index.ts";

test("台帳と hook の送信待ちは XDG_STATE_HOME を優先する", () => {
  assert.equal(ledgerDbPath({}, "/home/test"), "/home/test/.local/state/agent-graph/agent-graph.db");
  assert.equal(hookOutboxPath({}, "/home/test"), "/home/test/.local/state/agent-graph/outbox");
  assert.equal(ledgerDbPath({ XDG_STATE_HOME: "/state" }, "/home/test"), "/state/agent-graph/agent-graph.db");
  assert.equal(hookOutboxPath({ XDG_STATE_HOME: "/state" }, "/home/test"), "/state/agent-graph/outbox");
  assert.equal(ledgerDbPath({ XDG_STATE_HOME: "" }, "/home/test"), ledgerDbPath({}, "/home/test"));
  assert.equal(hookOutboxPath({ XDG_STATE_HOME: "" }, "/home/test"), hookOutboxPath({}, "/home/test"));
  assert.throws(() => ledgerDbPath({ XDG_STATE_HOME: "relative" }), TypeError);
  assert.throws(() => hookOutboxPath({ XDG_STATE_HOME: "relative" }), TypeError);
  assert.notEqual(ledgerDbPath({}, "/home/test"), stateDbPath("repo", {}, "/home/test"));
});

test("テストの環境と既定の保存先は一時ディレクトリへ隔離される", () => {
  const home = process.env.HOME;
  assert.ok(home);
  for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    assert.equal(process.env[key], home);
  }
  assert.equal(homedir(), home);
  assert.equal(ledgerDbPath(), join(home, "agent-graph", "agent-graph.db"));
  assert.equal(hookOutboxPath(), join(home, "agent-graph", "outbox"));
});
