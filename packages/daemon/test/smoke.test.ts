import assert from "node:assert/strict";
import test from "node:test";
import * as daemon from "../src/index.ts";

test("daemon exports MCP and socket entry points", () => {
  assert.equal(typeof daemon.createMcpSession, "function");
  assert.equal(typeof daemon.startSocketServer, "function");
});
