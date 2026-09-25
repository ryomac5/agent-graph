import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installCodexConfig, removeCodexConfig, uninstallCodexConfig } from "../src/codex-config.ts";
import { installLaunchd, renderInstallCommands, renderLaunchdPlist, renderUninstallCommands, uninstallLaunchd } from "../src/launchd.ts";
import { generateMarketplace } from "../src/marketplace.ts";

const root = mkdtempSync(join(tmpdir(), "agent-graph-install-"));

test("launchd plist と呼び出し", () => {
  const calls: string[][] = [];
  const options = { plistDir: join(root, "agents"), logDir: join(root, "logs"), nodePath: "/node&one", daemonPath: "/daemon<two>", env: { PATH: "/test/bin" }, uid: 42, launchctl: (args: string[]): number => { calls.push(args); return 0; } };
  const xml = renderLaunchdPlist(options);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /\/node&amp;one/);
  assert.match(xml, /\/daemon&lt;two&gt;/);
  assert.match(xml, /daemon\.stdout\.log/);
  assert.match(xml, /daemon\.stderr\.log/);
  assert.equal(spawnSync("plutil", ["-lint", "-s", "-"], { input: xml }).status, 0);
  const path = join(options.plistDir, "dev.agent-graph.daemon.plist");
  installLaunchd(options);
  assert.equal(readFileSync(path, "utf8"), xml);
  installLaunchd(options);
  uninstallLaunchd(options);
  assert.deepEqual(calls, [["bootout", "gui/42/dev.agent-graph.daemon"], ["bootstrap", "gui/42", path], ["bootout", "gui/42/dev.agent-graph.daemon"], ["bootstrap", "gui/42", path], ["bootout", "gui/42", path]]);
  assert.equal(existsSync(path), false);
});

test("bootout が非 0 でも plist を削除する", () => {
  const options = { plistDir: join(root, "failed-bootout"), logDir: join(root, "failed-logs"), nodePath: "/node", daemonPath: "/daemon", uid: 42, launchctl: (args: string[]): number => args[0] === "bootout" ? 1 : 0 };
  installLaunchd(options);
  const { commands, plistPath } = renderUninstallCommands(options);
  assert.deepEqual(commands, [["bootout", "gui/42", plistPath]]);
  assert.deepEqual(renderInstallCommands(options), [["bootout", "gui/42/dev.agent-graph.daemon"], ["bootstrap", "gui/42", plistPath]]);
  uninstallLaunchd(options);
  assert.equal(existsSync(plistPath), false);
});

test("launchd の dry-run に未知の環境変数を載せない", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--launchd", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_GRAPH_TEST_SECRET: "must-not-appear" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /AGENT_GRAPH_TEST_SECRET|must-not-appear/);
  assert.match(result.stdout, /<key>PATH<\/key>/);
});

test("marketplace と plugin の配置", () => {
  const outDir = join(root, "marketplace");
  generateMarketplace({ outDir, plugin: { shimPath: "/tmp/shim.ts", hookPath: "/tmp/hook.ts", nodePath: process.execPath } });
  const manifest = JSON.parse(readFileSync(join(outDir, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(manifest.name, "agent-graph-local");
  assert.deepEqual(manifest.plugins.map((plugin: { name: string; source: string }) => [plugin.name, plugin.source]), [["agent-graph", "./plugins/agent-graph"]]);
  assert.equal(JSON.parse(readFileSync(join(outDir, "plugins/agent-graph/.claude-plugin/plugin.json"), "utf8")).name, "agent-graph");
  assert.ok(existsSync(join(outDir, "plugins/agent-graph/hooks/hooks.json")));
});

test("Codex 設定の対象節だけを削除して元に戻す", () => {
  const configPath = join(root, "config.toml");
  const original = "# keep\r\n[other]\r\nvalue = 1 # exact\r\n";
  writeFileSync(configPath, original);
  installCodexConfig({ configPath, shimPath: "/tmp/shim.ts", nodePath: process.execPath });
  const installed = readFileSync(configPath, "utf8");
  uninstallCodexConfig({ configPath });
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.equal(readFileSync(`${configPath}.agent-graph.bak`, "utf8"), installed);
  assert.equal(removeCodexConfig(`${original}[mcp_servers.agent-graph]\nx=1\n[other.two]\r\ny=2\r\n[mcp_servers.agent-graph.env]\nz=3\n`), `${original}[other.two]\r\ny=2\r\n`);
});
