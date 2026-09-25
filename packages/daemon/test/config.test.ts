import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDashboardPort } from "../src/config.ts";

test("dashboard port は既定値、TOML、環境変数の順で優先する", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-config-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(readDashboardPort({}, home), 7420);
  const configDir = join(home, "xdg", "agent-graph");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), "[other]\nport = 1234\n[dashboard]\nport = 4567 # local\n");
  assert.equal(readDashboardPort({ XDG_CONFIG_HOME: join(home, "xdg") }, home), 4567);
  assert.equal(readDashboardPort({ XDG_CONFIG_HOME: join(home, "xdg"), AGENT_GRAPH_PORT: "0" }, home), 0);
  assert.throws(() => readDashboardPort({ AGENT_GRAPH_PORT: "65536" }, home), RangeError);
});
