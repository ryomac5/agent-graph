import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installShellCommands } from "../src/setup-shell.ts";

test("既存シェル設定を保持・バックアップし、引用を含むPATHを実行できる形で登録する", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-shell-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, ".zprofile");
  const original = 'export EXISTING="kept"\n';
  writeFileSync(profile, original);
  const entry = join(home, "O'Brien $HOME");
  installShellCommands(home, "/bin/zsh", [entry], join(home, "source code"));
  const config = readFileSync(profile, "utf8");
  assert.ok(config.startsWith(original));
  assert.equal(readFileSync(`${profile}.agent-graph.bak`, "utf8"), original);
  const result = spawnSync("/bin/bash", ["-c", 'PATH=original-path; source "$1"; printf "%s\\n" "$PATH" "$EXISTING"', "check", profile], { env: { HOME: home, PATH: "original-path" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${entry}:original-path\nkept\n`);
  installShellCommands(home, "/bin/zsh", [entry], join(home, "source code"));
  assert.equal(readFileSync(profile, "utf8"), config);
  assert.equal(readFileSync(`${profile}.agent-graph.bak`, "utf8"), original);
  assert.ok(readFileSync(join(home, ".local", "bin", "agent-graph"), "utf8").includes("source code/scripts/setup.sh"));
});

test("Bashの設定に登録し、独自の同名コマンドは上書きしない", (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-shell-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installShellCommands(home, "/bin/bash", ["/tools/bin"], "/app");
  assert.ok(existsSync(join(home, ".bash_profile")));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const launcher = join(home, ".local", "bin", "agent-graph");
  writeFileSync(launcher, "my existing command");
  assert.throws(() => installShellCommands(home, "/bin/bash", ["/tools/bin"], "/app"), /上書きしません/);
  assert.equal(readFileSync(launcher, "utf8"), "my existing command");
});
