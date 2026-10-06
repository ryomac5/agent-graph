import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderClaudePlugin } from "../src/claude-plugin.ts";
import { renderCodexConfig, renderCodexOverrides } from "../src/codex-config.ts";

const base = { shimPath: "/legacy/shim.ts", hookPath: "/legacy/hook.ts", nodePath: "/node", outDir: "/plugin" };
for (const relay of ["legacy", "v2"] as const) test(`config generation selects ${relay} relay`, () => {
  const options = { ...base, relay };
  const expected = relay === "v2" ? fileURLToPath(new URL("../src/shim-v2/cli.ts", import.meta.url)) : base.shimPath;
  const plugin = JSON.parse(renderClaudePlugin(options)[".mcp.json"]);
  assert.deepEqual(plugin.mcpServers["agent-graph"].args, [expected]);
  assert.ok(renderCodexConfig(options).includes(JSON.stringify(expected)));
  assert.ok(renderCodexOverrides(options).join("\n").includes(JSON.stringify(expected)));
  assert.equal(renderCodexConfig(options).includes("AGENT_GRAPH_RUNNER_SOCKET"), relay === "v2");
  assert.equal(renderCodexConfig(options).includes("AGENT_GRAPH_MANAGED"), relay === "v2");
});
test("default generation preserves the legacy registration", () => {
  assert.deepEqual(renderClaudePlugin(base), renderClaudePlugin({ ...base, relay: "legacy" }));
  assert.equal(renderCodexConfig(base), renderCodexConfig({ ...base, relay: "legacy" }));
});
test("installer exposes relay selection regardless of argument order", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  for (const args of [["--relay", "v2", "--print-codex-overrides"], ["--print-codex-overrides", "--relay", "v2"]]) {
    const output = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.ok(output.includes("shim-v2/cli.ts")); assert.ok(output.includes("AGENT_GRAPH_RUNNER_SOCKET"));
  }
});
