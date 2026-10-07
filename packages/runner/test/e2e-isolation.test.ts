import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { FakeHost } from "../src/host/contract.ts";
import { assertE2eIsolation, createE2eHostOptions, createE2eHosts } from "../src/e2e-isolation.ts";

test("E2E hosts disable both providers' history without changing authentication locations", () => {
  const options = createE2eHostOptions();
  assert.deepEqual(options, { claude: { persistSession: false }, codex: { persistSession: false } });
  let launched = false;
  const hosts = createE2eHosts(options, (settings) => {
    launched = true;
    assert.equal(settings.claude.persistSession, false);
    assert.equal(settings.codex.persistSession, false);
    return [new FakeHost("claude"), new FakeHost("codex")];
  });
  assert.equal(launched, true);
  assert.equal(hosts.length, 2);
});

test("E2E refuses persistence at inherited default locations before creating hosts", () => {
  for (const provider of ["claude", "codex"] as const) {
    for (const persistSession of [undefined, true]) {
      const options = createE2eHostOptions();
      options[provider] = { persistSession };
      let launches = 0;
      assert.throws(() => createE2eHosts(options, () => { launches++; return []; }), /Unsafe E2E.*default history/);
      assert.equal(launches, 0);
      assert.throws(() => assertE2eIsolation(options), /Unsafe E2E/);
    }
  }
});

test("E2E refuses both providers' default launch options before creating either host", () => {
  let launches = 0;
  assert.throws(() => createE2eHosts({ claude: {}, codex: {} }, () => {
    launches++;
    return [new FakeHost("claude"), new FakeHost("codex")];
  }), /Unsafe E2E.*default history/);
  assert.equal(launches, 0);
});

test("E2E refuses persistent launches with explicitly configured default history paths", () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CODEX_HOME = join(process.env.HOME!, ".codex");
    process.env.CLAUDE_CONFIG_DIR = join(process.env.HOME!, ".claude");
    for (const provider of ["claude", "codex"] as const) {
      const options = createE2eHostOptions();
      options[provider].persistSession = true;
      let launches = 0;
      assert.throws(() => createE2eHosts(options, () => {
        launches++;
        return [];
      }), /Unsafe E2E.*default history/);
      assert.equal(launches, 0);
    }
  } finally {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfig;
  }
});

test("E2E keeps the checked launch settings when the caller changes its options", () => {
  const options = createE2eHostOptions();
  let settings: ReturnType<typeof createE2eHostOptions> | undefined;
  createE2eHosts(options, (checked) => {
    settings = checked;
    return [new FakeHost("claude"), new FakeHost("codex")];
  });
  options.claude.persistSession = true;
  options.codex.persistSession = true;
  assert.ok(settings);
  for (const provider of ["claude", "codex"] as const) {
    assert.throws(() => { settings![provider].persistSession = true; }, TypeError);
    assert.throws(() => { settings![provider] = { persistSession: true }; }, TypeError);
  }
  assertE2eIsolation(settings);
  assert.throws(() => assertE2eIsolation(options), /Unsafe E2E/);
});
