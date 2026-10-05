#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateClaudePlugin, renderClaudePlugin } from "./claude-plugin.ts";
import { installCodexConfig, mergeCodexConfig, removeCodexConfig, renderCodexOverrides, uninstallCodexConfig } from "./codex-config.ts";
import { installLaunchd, renderInstallCommands, renderLaunchdPlist, renderUninstallCommands, uninstallLaunchd } from "./launchd.ts";
import { generateMarketplace, renderMarketplace } from "./marketplace.ts";
import { setupAgentGraph } from "./setup.ts";

const shimPath = fileURLToPath(new URL("../../daemon/src/shim.ts", import.meta.url));
const daemonPath = fileURLToPath(new URL("../../daemon/src/main.ts", import.meta.url));
const hookPath = fileURLToPath(new URL("./hook.ts", import.meta.url));
const nodePath = process.execPath;
const args = process.argv.slice(2);
if (args.includes("--setup")) {
  const unknown = args.find((flag) => !["--setup", "--dry-run", "--doctor"].includes(flag));
  if (unknown) throw new Error(`Unknown option: ${unknown}`);
  try { await setupAgentGraph({ dryRun: args.includes("--dry-run"), doctor: args.includes("--doctor") }); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
} else {
const dryRun = args.includes("--dry-run");
const pluginOptions = { shimPath, hookPath, nodePath };
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
const logDir = join(stateHome, "agent-graph", "run");
const plistDir = join(homedir(), "Library", "LaunchAgents");
const launchdEnvKeys = ["HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "AGENT_GRAPH_PORT"];
const launchdEnv = Object.fromEntries(launchdEnvKeys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
launchdEnv.PATH = process.env.PATH;

function readExisting(path: string): string {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--dry-run") continue;
  if (flag === "--print-codex-overrides") {
    process.stdout.write(`${renderCodexOverrides({ shimPath, nodePath }).join("\n")}\n`);
    continue;
  }
  if (flag === "--launchd") {
    const options = { plistDir, nodePath, daemonPath, logDir, env: launchdEnv };
    if (dryRun) process.stdout.write(`${renderLaunchdPlist(options)}${renderInstallCommands(options).map((command) => `launchctl ${command.join(" ")}`).join("\n")}\n`);
    else installLaunchd(options);
    continue;
  }
  if (flag === "--uninstall-launchd") {
    if (dryRun) {
      const { commands, plistPath } = renderUninstallCommands({ plistDir });
      process.stdout.write(`${commands.map((command) => `launchctl ${command.join(" ")}`).join("\n")}\nrm ${plistPath}\n`);
    }
    else uninstallLaunchd({ plistDir });
    continue;
  }
  const path = args[++i];
  if (!path) throw new Error(`Missing value for ${flag}`);
  if (flag === "--claude-plugin-dir") {
    if (dryRun) process.stdout.write(JSON.stringify(renderClaudePlugin({ outDir: path, ...pluginOptions }), null, 2) + "\n");
    else generateClaudePlugin({ outDir: path, ...pluginOptions });
  } else if (flag === "--claude-marketplace-dir") {
    const options = { outDir: path, plugin: pluginOptions };
    if (dryRun) process.stdout.write(JSON.stringify(renderMarketplace(options), null, 2) + "\n");
    else generateMarketplace(options);
    process.stdout.write(`claude plugin marketplace add ${JSON.stringify(path)}\nclaude plugin install agent-graph@agent-graph-local\n`);
  } else if (flag === "--codex-config") {
    if (dryRun) process.stdout.write(mergeCodexConfig(readExisting(path), { shimPath, nodePath }));
    else installCodexConfig({ configPath: path, shimPath, nodePath });
  } else if (flag === "--uninstall-codex-config") {
    if (dryRun) process.stdout.write(removeCodexConfig(readExisting(path)));
    else uninstallCodexConfig({ configPath: path });
  } else throw new Error(`Unknown option: ${flag}`);
}
}
