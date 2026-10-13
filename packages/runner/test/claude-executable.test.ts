import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test, type TestContext } from "node:test";
import { resolveClaudeExecutable } from "../src/hosts/claude/executable.ts";
import { ClaudeHost } from "../src/hosts/claude/index.ts";

function createDirectory(t: TestContext): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-executable-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Claude executable resolves PATH in order before fallback locations", (t) => {
  const directory = createDirectory(t);
  const first = join(directory, "first"), second = join(directory, "second");
  mkdirSync(first); mkdirSync(second);
  writeFileSync(join(first, "claude"), "first", { mode: 0o700 });
  writeFileSync(join(second, "claude"), "second", { mode: 0o700 });
  assert.equal(resolveClaudeExecutable({ PATH: [first, second].join(delimiter) }, [second]).path, join(first, "claude"));
});

test("Claude executable supplements a sparse launchd PATH with install locations", (t) => {
  const directory = createDirectory(t);
  const bin = join(directory, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "native", { mode: 0o700 });
  assert.equal(resolveClaudeExecutable({ PATH: join(directory, "missing") }, [bin]).path, join(bin, "claude"));
  assert.equal(resolveClaudeExecutable({}, [bin]).path, join(bin, "claude"));
});

test("Claude executable falls back to the SDK for missing, non-executable, directory and broken links", (t) => {
  const directory = createDirectory(t);
  const entries = ["missing", "not-executable", "directory", "broken"].map((name) => join(directory, name));
  for (const entry of entries) mkdirSync(entry);
  writeFileSync(join(entries[1], "claude"), "not executable", { mode: 0o600 });
  mkdirSync(join(entries[2], "claude"));
  symlinkSync(join(directory, "absent"), join(entries[3], "claude"));
  assert.deepEqual(resolveClaudeExecutable({ PATH: entries.join(delimiter) }, []), { fingerprint: "bundled" });
});

test("Claude executable resolves npm JavaScript links and detects replacement at the same path", (t) => {
  const directory = createDirectory(t);
  const script = join(directory, "cli.js");
  writeFileSync(script, "old", { mode: 0o700 });
  symlinkSync(script, join(directory, "claude"));
  const before = resolveClaudeExecutable({ PATH: directory }, []);
  assert.equal(before.path, script);
  const replacement = join(directory, "replacement");
  writeFileSync(replacement, "new", { mode: 0o700 });
  renameSync(replacement, script);
  const after = resolveClaudeExecutable({ PATH: directory }, []);
  assert.equal(after.path, script);
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("Claude executable detects native installer symlink updates on every resolution", (t) => {
  const directory = createDirectory(t);
  for (const version of ["2.1.291", "2.1.296"]) writeFileSync(join(directory, version), "native", { mode: 0o700 });
  symlinkSync(join(directory, "2.1.291"), join(directory, "claude"));
  const before = resolveClaudeExecutable({ PATH: directory }, []);
  symlinkSync(join(directory, "2.1.296"), join(directory, "updated"));
  renameSync(join(directory, "updated"), join(directory, "claude"));
  const after = resolveClaudeExecutable({ PATH: directory }, []);
  assert.equal(after.path, join(directory, "2.1.296"));
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test("installed SDK discovers models from the resolved CLI and refreshes after replacement", { timeout: 10_000 }, async (t) => {
  const directory = createDirectory(t);
  const script = join(directory, "cli.mjs");
  symlinkSync(script, join(directory, "claude"));
  const writeCli = (displayName: string) => writeFileSync(script, `
    import { createInterface } from "node:readline";
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.type === "user") throw new Error("Model discovery must not send a prompt");
      if (request.type === "control_request" && request.request.subtype === "initialize") {
        console.log(JSON.stringify({ type: "control_response", response: {
          subtype: "success", request_id: request.request_id, response: {
            models: [{ value: "haiku", displayName: ${JSON.stringify(displayName)}, description: "fixture" }],
          },
        } }));
      }
    }
  `, { mode: 0o700 });
  writeCli("Haiku 4.5");
  const host = new ClaudeHost(undefined, { resolveExecutable: () => resolveClaudeExecutable({ PATH: directory }, []) });
  assert.deepEqual(await host.listModels(), [{ model: "haiku", displayName: "Haiku 4.5" }]);
  writeCli("Haiku 5.5");
  assert.deepEqual(await host.listModels(), [{ model: "haiku", displayName: "Haiku 5.5" }]);
});
