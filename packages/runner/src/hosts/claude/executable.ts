import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export interface ClaudeExecutable {
  path?: string;
  fingerprint: string;
}

export function resolveClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirectories = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", dirname(process.execPath)],
): ClaudeExecutable {
  // launchd の短い PATH を補う。シェルの初期化ファイルは実行しない。
  const directories = [...new Set([...(env.PATH?.split(delimiter) ?? []), ...fallbackDirectories])];
  for (const directory of directories) {
    const candidate = resolve(directory, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      // npm のリンクも実体に解決し、SDK が .js と native を正しく判別できるようにする。
      const path = realpathSync(candidate);
      const stat = statSync(path, { bigint: true });
      if (!stat.isFile()) continue;
      return { path, fingerprint: `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  return { fingerprint: "bundled" };
}
