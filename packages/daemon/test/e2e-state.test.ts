import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore } from "../../core/src/store/store.ts";

for (const mode of ["root", "session-only", "nested"] as const) {
  test(`e2e state checker resolves ${mode} caller context`, (t) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ag-e2e-state-")));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, "repo");
    mkdirSync(root);
    const key = repoKey(root);
    const traceId = "1".repeat(32);
    const spanId = "2".repeat(16);
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_STATE_HOME: join(dir, "state"),
      TRACEPARENT: `00-${traceId}-${spanId}-01`, AGENT_GRAPH_SESSION: "session",
      AGENT_GRAPH_CLIENT: "claude" };
    delete env.TRACESTATE;
    if (mode === "session-only") env.TRACESTATE = "agent-graph=session:session";
    if (mode === "nested") {
      env.TRACESTATE = "agent-graph=session:session;delegation:parent";
      env.AGENT_GRAPH_SESSION = "ignored";
    }
    const script = fileURLToPath(new URL("../../../scripts/e2e-stage2-state.ts", import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], {
      cwd: root, env, encoding: "utf8",
    });
    if (mode === "nested") {
      const seeded = run(["seed", "implement", "claude"]);
      assert.equal(seeded.status, 0, seeded.stderr);
    }
    const store = openStore(stateDbPath(key, env));
    t.after(() => store.close());
    if (mode !== "nested") {
      store.upsertRepo({ key, rootPath: root, name: "repo" });
      store.insertSession({ id: "session", repoKey: key, name: "session", client: "claude",
        traceId, startedAt: new Date().toISOString() });
    }
    store.insertDelegation({ id: "child", repoKey: key, sessionId: "session",
      ...(mode === "nested" ? { parentId: "parent" } : {}),
      role: "implement", title: "child", status: "done" });
    store.insertAssignment("child", { executor: "codex", model: "fixture", family: "openai",
      tier: "low", reason: [], policyVersion: "test" });
    const attributes = { "agent.role": "implement", "agent.executor": "codex",
      "agent.model": "fixture", "agent.session": "session", "agent.delegation": "child" };
    store.insertSpan({ trace: { traceId, spanId: "3".repeat(16), parentSpanId: spanId },
      name: "delegate", startedAt: new Date().toISOString(), status: "ok",
      attributes });
    // 実行・再指示の span が増えても委譲は一回として検証する。
    for (const id of ["4", "5"]) store.insertSpan({
      trace: { traceId, spanId: id.repeat(16), parentSpanId: "3".repeat(16) },
      name: "execute", startedAt: new Date().toISOString(), status: "ok",
      attributes,
    });
    const args = [mode === "nested" ? "check" : "check-root", "implement", "codex"];
    const checked = run(args);
    assert.equal(checked.status, 0, checked.stderr);
    store.insertDelegation({ id: "duplicate", repoKey: key, sessionId: "session",
      role: "implement", title: "duplicate", status: "denied" });
    assert.notEqual(run(args).status, 0, "duplicate calls without assignments must fail validation");
    store.db.prepare("DELETE FROM delegations WHERE id = 'duplicate'").run();
    store.finishDelegation("child", "failed");
    assert.notEqual(run(args).status, 0, "unsuccessful delegations must still fail validation");
  });
}
