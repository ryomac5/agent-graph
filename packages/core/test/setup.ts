import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDirectory = mkdtempSync(join(tmpdir(), "agent-graph-core-test-"));

for (const key of ["XDG_CONFIG_HOME", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
  process.env[key] = configDirectory;
}

process.once("exit", () => {
  rmSync(configDirectory, { recursive: true, force: true });
});
