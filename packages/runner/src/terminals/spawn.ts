import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";

const require = createRequire(import.meta.url);

function prepareSpawnHelper(): void {
  if (process.platform !== "darwin") return;
  const root = dirname(require.resolve("node-pty/package.json"));
  const helper = [resolve(root, "build/Release/spawn-helper"), resolve(root, "build/Debug/spawn-helper"),
    resolve(root, `prebuilds/${process.platform}-${process.arch}/spawn-helper`)].find(path => existsSync(path));
  if (!helper) throw new Error("Terminal helper unavailable");
  const mode = statSync(helper).mode;
  // node-pty の配布物で欠ける helper の実行権限を、api と同じく起動直前に補う。
  if (!(mode & 0o100)) chmodSync(helper, mode | 0o100);
}

export function filterTerminalEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith("AGENT_GRAPH")
    && !entry[0].startsWith("CLAUDE_CODE") && entry[0] !== "CLAUDECODE"));
}

export function spawnTerminal(file: string, args: string[], options: Parameters<typeof spawn>[2]): IPty {
  prepareSpawnHelper();
  return spawn(file, args, { ...options, env: filterTerminalEnv(options?.env ?? process.env) });
}
