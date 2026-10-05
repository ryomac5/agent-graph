import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = fileURLToPath(new URL("../../../scripts/bootstrap-tools.sh", import.meta.url));
const installer = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const NODE_SHA = "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057";

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
}

function createFixture(t: { after: (callback: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-clean-mac-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "commands");
  mkdirSync(bin);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, FIXTURE_HOME: home };
  writeExecutable(join(bin, "uname"), 'if [[ "$1" == -m ]]; then echo arm64; else echo Darwin; fi');
  writeExecutable(join(bin, "node"), "exit 1");
  writeExecutable(join(bin, "xcrun"), "exit 0");
  writeExecutable(join(bin, "shasum"), `printf '%s  file\\n' '${NODE_SHA}'`);
  writeExecutable(join(bin, "curl"), `
for value in "$@"; do [[ "$value" != https:* ]] || url="$value"; done
while [[ "$#" -gt 0 ]]; do if [[ "$1" == -o ]]; then output="$2"; break; fi; shift; done
printf '%s\\n' "$url" >> "$FIXTURE_HOME/downloads"
case "$url" in
  https://nodejs.org/*) cp "$FIXTURE_HOME/node.tar.gz" "$output" ;;
  https://claude.ai/install.sh) cp "$FIXTURE_HOME/claude-install.sh" "$output" ;;
  https://herdr.dev/install.sh) cp "$FIXTURE_HOME/herdr-install.sh" "$output" ;;
  https://codeload.github.com/*) cp "$FIXTURE_HOME/source.tar.gz" "$output" ;;
  *) echo "unexpected download" >&2; exit 1 ;;
esac`);
  return { home, bin, env };
}

function runBootstrap(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync("/bin/bash", ["-c", 'set -euo pipefail; source "$1"; shift; agent_graph_prepare_tools "$@"', "bootstrap", bootstrap, ...args], { env, encoding: "utf8", timeout: 10_000 });
}

function prepareDownloads(home: string) {
  const stage = join(home, "stage");
  const nodeRoot = "node-v24.21.0-darwin-arm64";
  mkdirSync(join(stage, nodeRoot, "bin"), { recursive: true });
  writeExecutable(join(stage, nodeRoot, "bin", "node"), 'if [[ "${1:-}" == -e ]]; then exit 0; fi; exec /bin/bash "$@"');
  writeExecutable(join(stage, nodeRoot, "bin", "npm"), `
while [[ "$#" -gt 0 ]]; do if [[ "$1" == --prefix ]]; then prefix="$2"; break; fi; shift; done
mkdir -p "$prefix/bin"
printf '#!/bin/sh\\necho codex-ready\\n' > "$prefix/bin/codex"
chmod +x "$prefix/bin/codex"`);
  const packed = spawnSync("/usr/bin/tar", ["-czf", join(home, "node.tar.gz"), "-C", stage, nodeRoot]);
  assert.equal(packed.status, 0);
  writeExecutable(join(home, "claude-install.sh"), `mkdir -p "$HOME/.local/bin"; printf '#!/bin/sh\\necho claude-ready\\n' > "$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"`);
  writeExecutable(join(home, "herdr-install.sh"), `mkdir -p "$HERDR_INSTALL_DIR"; printf '#!/bin/sh\\necho herdr-ready\\n' > "$HERDR_INSTALL_DIR/herdr"; chmod +x "$HERDR_INSTALL_DIR/herdr"`);
}

test("Node・CLI・HomebrewなしのMacに必要なツールをユーザー領域へ導入する", (t) => {
  const f = createFixture(t);
  prepareDownloads(f.home);
  const result = runBootstrap(f.env);
  assert.equal(result.status, 0, result.stderr);
  const tools = join(f.home, ".local", "share", "agent-graph", "tools");
  for (const path of [join(tools, "node-v24.21.0-darwin-arm64", "bin", "node"), join(tools, "bin", "codex"), join(tools, "bin", "herdr"), join(f.home, ".local", "bin", "claude")]) assert.ok(existsSync(path), path);
  const downloads = readFileSync(join(f.home, "downloads"), "utf8");
  assert.equal(downloads.trim().split("\n").length, 3);
  const repeated = runBootstrap(f.env);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(join(f.home, "downloads"), "utf8"), downloads);
  assert.equal(runBootstrap(f.env, ["--doctor"]).status, 0);
});

test("公式Nodeのチェックサムが一致しなければ実行せず止める", (t) => {
  const f = createFixture(t);
  prepareDownloads(f.home);
  writeExecutable(join(f.bin, "shasum"), "echo wrong-checksum");
  const result = runBootstrap(f.env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /チェックサム/);
  assert.equal(existsSync(join(f.home, ".local", "bin", "claude")), false);
});

test("ダウンロードが失敗すれば後続のCLI導入へ進まない", (t) => {
  const f = createFixture(t);
  writeExecutable(join(f.bin, "curl"), "exit 22");
  const result = runBootstrap(f.env);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.home, ".local")), false);
});

test("Gitなしでコードを取得し、保存先とオプションをセットアップに渡す", (t) => {
  const f = createFixture(t);
  const source = join(f.home, "source", "agent-graph-main", "scripts");
  mkdirSync(source, { recursive: true });
  writeExecutable(join(source, "setup.sh"), 'printf "%s\\n" "$PWD" "$@" > "$HOME/setup-called"');
  assert.equal(spawnSync("/usr/bin/tar", ["-czf", join(f.home, "source.tar.gz"), "-C", join(f.home, "source"), "agent-graph-main"]).status, 0);
  const result = spawnSync("/bin/bash", [installer, "--skip-login"], { env: f.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(f.home, "setup-called"), "utf8"), /--skip-login/);
  assert.ok(existsSync(join(f.home, ".local", "share", "agent-graph", "releases", NODE_SHA, "scripts", "setup.sh")));
});

test("取得入口のdry-runは通信もファイル作成もしない", (t) => {
  const f = createFixture(t);
  const result = spawnSync("/bin/bash", [installer, "--dry-run"], { env: f.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.home, "downloads")), false);
  assert.equal(existsSync(join(f.home, ".local")), false);
});

test("同じ版の配布物が欠落していたら退避し、完全な配布物を復元する", (t) => {
  const f = createFixture(t);
  const source = join(f.home, "source", "agent-graph-main");
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, "packages", "core", "src", "assign"), { recursive: true });
  writeExecutable(join(source, "scripts", "setup.sh"), "exit 0");
  writeFileSync(join(source, "packages", "core", "src", "assign", "policy.ts"), "export const valid = true;\n");
  assert.equal(spawnSync("/usr/bin/tar", ["-czf", join(f.home, "source.tar.gz"), "-C", join(f.home, "source"), "agent-graph-main"]).status, 0);
  const run = () => spawnSync("/bin/bash", [installer], { env: f.env, encoding: "utf8" });
  assert.equal(run().status, 0);
  const releases = join(f.home, ".local", "share", "agent-graph", "releases");
  const policy = join(releases, NODE_SHA, "packages", "core", "src", "assign", "policy.ts");
  rmSync(policy);
  const repaired = run(); assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(readFileSync(policy, "utf8"), "export const valid = true;\n");
  assert.equal(readdirSync(releases).filter((name) => name.includes(".incomplete-")).length, 1);
  assert.equal(run().status, 0);
  assert.equal(readdirSync(releases).length, 2, "正常な同一版は再配置しない");
});
