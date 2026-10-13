import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../../../../scripts/inventory/history-kinds.mjs", import.meta.url);
for (const unknown of [false, true]) {
  test(`棚卸しの終了コードと秘匿（未分類: ${unknown}）`, t => {
    const home = mkdtempSync(join(tmpdir(), "history-inventory-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const claude = join(home, ".claude/projects/private-project");
    const codex = join(home, ".codex/sessions/private-project");
    mkdirSync(claude, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const rows = [
      { type: "user", uuid: "private-identifier", message: { content: "private-body" }, cwd: "/private/path" },
      { type: "attachment", attachment: { type: unknown ? "future_attachment" : "queued_command",
        commandMode: "prompt", origin: { kind: "human" }, prompt: "private-body", source_uuid: "private-identifier" } },
      { type: "user", uuid: "private-identifier", message: { content: [{ type: unknown ? "future_block" : "text", text: "private-body" }] } },
    ];
    writeFileSync(join(claude, "private-name.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n{broken}\n{}\n");
    writeFileSync(join(codex, "private-name.jsonl"), JSON.stringify({ type: "event_msg", payload: { type: unknown ? "future_event" : "token_count", text: "private-body" } }) + "\n");
    const result = spawnSync(process.execPath, [script.pathname], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    assert.equal(result.status, unknown ? 1 : 0, result.stderr);
    assert.equal(result.stderr, "");
    const output = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(output.at(-1), { files: 2, kinds: 4, unclassified: unknown ? 3 : 0 });
    const user = output.find(row => row.kind?.type === "user" && row.kind.field === "");
    assert.equal(user.count, 2);
    assert.deepEqual(user.first, { file: "claude:file-1", line: 1 });
    for (const privateValue of ["private-body", "private-identifier", "/private/path", "private-name", "private-project", home]) {
      assert.ok(!result.stdout.includes(privateValue));
    }
    assert.equal(output.filter(row => row.sample).length, unknown ? 3 : 0);
  });
}

for (const flag of ["isCompactSummary", "isMeta", "isVisibleInTranscriptOnly", "isFutureInternal", "futureBoolean", "invalid"]) {
  test(`user の旗を独立に棚卸しし、未分類の旗だけでも失敗する (${flag})`, t => {
    const home = mkdtempSync(join(tmpdir(), "history-flag-inventory-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const claude = join(home, ".claude/projects");
    mkdirSync(claude, { recursive: true });
    mkdirSync(join(home, ".codex/sessions"), { recursive: true });
    const row = { type: "user", uuid: "private-identifier", message: { role: "user", content: "private-body" } };
    const field = flag === "invalid" ? "isMeta" : flag;
    writeFileSync(join(claude, "fixture.jsonl"), [row, { ...row, [field]: flag === "invalid" ? "private-value" : true }]
      .map(row => JSON.stringify(row)).join("\n") + "\n");
    const result = spawnSync(process.execPath, [script.pathname], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    const unknown = ["isFutureInternal", "futureBoolean", "invalid"].includes(flag);
    assert.equal(result.status, unknown ? 1 : 0, result.stderr);
    const output = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(output.at(-1), { files: 1, kinds: 2, unclassified: unknown ? 1 : 0 });
    const entry = output.find(entry => entry.kind?.field === `flag.${field}`);
    assert.equal(entry.count, 1);
    assert.equal(entry.classification, unknown ? "unclassified" : "ignore");
    if (unknown) assert.equal(entry.sample[field], flag === "invalid" ? "[redacted]" : true);
    for (const privateValue of ["private-body", "private-identifier", "private-value", home]) assert.ok(!result.stdout.includes(privateValue));
  });
}
