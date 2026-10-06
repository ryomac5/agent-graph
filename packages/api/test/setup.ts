import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDirectory = mkdtempSync(join(tmpdir(), "agent-graph-api-test-"));

for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
  process.env[key] = configDirectory;
}

process.once("exit", () => {
  rmSync(configDirectory, { recursive: true, force: true });
});
