#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateClaudePlugin, renderClaudePlugin } from "./claude-plugin.ts";
import { installCodexConfig, mergeCodexConfig, renderCodexOverrides } from "./codex-config.ts";

const shimPath = fileURLToPath(new URL("../../daemon/src/shim.ts", import.meta.url));
const hookPath = fileURLToPath(new URL("./hook.ts", import.meta.url));
const nodePath = process.execPath;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--dry-run") continue;
  if (flag === "--print-codex-overrides") {
    process.stdout.write(`${renderCodexOverrides({ shimPath, nodePath }).join("\n")}\n`);
    continue;
  }
  const path = args[++i];
  if (!path) throw new Error(`Missing value for ${flag}`);
  if (flag === "--claude-plugin-dir") {
    if (dryRun) process.stdout.write(JSON.stringify(renderClaudePlugin({ outDir: path, shimPath, hookPath, nodePath }), null, 2) + "\n");
    else generateClaudePlugin({ outDir: path, shimPath, hookPath, nodePath });
  } else if (flag === "--codex-config") {
    if (dryRun) {
      let existing = "";
      try { existing = readFileSync(path, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      process.stdout.write(mergeCodexConfig(existing, { shimPath, nodePath }));
    } else installCodexConfig({ configPath: path, shimPath, nodePath });
  } else throw new Error(`Unknown option: ${flag}`);
}
