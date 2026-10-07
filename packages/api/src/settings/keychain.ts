import { spawn } from "node:child_process";
import type { KeychainPort } from "./index.ts";

const SERVICE = "agent-graph";
const ACCOUNT = "claude-api-key";
const ITEM_NOT_FOUND = 44;
const SECURITY_TIMEOUT_MS = 30_000;
const SECURITY_LINE_BYTES = 4096;
export type SecurityExecutor = (args: string[], input?: string) => Promise<number>;

// 出力には秘密が含まれうるため、stdout と stderr は読み出さない。
export const executeSecurity: SecurityExecutor = (args, input) => new Promise((resolve, reject) => {
  const child = spawn("/usr/bin/security", args, { stdio: ["pipe", "ignore", "ignore"], timeout: SECURITY_TIMEOUT_MS });
  child.on("error", () => reject(new Error("Keychain unavailable")));
  child.stdin.on("error", () => reject(new Error("Keychain unavailable")));
  child.on("close", code => code === null ? reject(new Error("Keychain unavailable")) : resolve(code));
  child.stdin.end(input);
});

export function createKeychain(execute: SecurityExecutor = executeSecurity): KeychainPort {
  async function run(args: string[], input?: string): Promise<number> {
    try { return await execute(args, input); }
    catch { throw new Error("Keychain unavailable"); }
  }
  return {
    async setClaudeApiKey(value) {
      if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid API key");
      // security の対話モードへ渡し、プロセスの引数に値を残さない。
      const quoted = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const input = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w "${quoted}"\n`;
      // security の行バッファを超えると、残りが別のコマンドになるため拒否する。
      if (Buffer.byteLength(input, "utf8") >= SECURITY_LINE_BYTES) throw new Error("Invalid API key");
      const code = await run(["-i"], input);
      if (code !== 0) throw new Error("Keychain unavailable");
    },
    async deleteClaudeApiKey() {
      const code = await run(["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
      if (code !== 0 && code !== ITEM_NOT_FOUND) throw new Error("Keychain unavailable");
    },
    async hasClaudeApiKey() {
      const code = await run(["find-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
      if (code === ITEM_NOT_FOUND) return false;
      if (code !== 0) throw new Error("Keychain unavailable");
      return true;
    },
  };
}
