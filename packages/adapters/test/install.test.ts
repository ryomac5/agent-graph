import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installCodexConfig, removeCodexConfig, uninstallCodexConfig } from "../src/codex-config.ts";
import { installLaunchd, renderLaunchdPlist, uninstallLaunchd } from "../src/launchd.ts";
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
  assert.deepEqual(calls, [["bootstrap", "gui/42", path], ["bootout", "gui/42", path], ["bootstrap", "gui/42", path], ["bootout", "gui/42", path]]);
  assert.equal(existsSync(path), false);
});

test("marketplace と plugin の配置", () => {
  const outDir = join(root, "marketplace");
  generateMarketplace({ outDir, pluginDir: { shimPath: "/tmp/shim.ts", hookPath: "/tmp/hook.ts", nodePath: process.execPath } });
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
