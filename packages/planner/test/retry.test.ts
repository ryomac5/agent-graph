import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSpec } from "../src/spec.ts";
import { nextAttempt } from "../src/retry.ts";

const task = { executor: "codex", model: "gpt", retry: { max: 1, escalate_to: "doc-heavy" } } as TaskSpec;
test("同じ役割で再試行し、系統を変えて昇格し、最後は人を待つ", () => {
  assert.deepEqual(nextAttempt(task, { attempts: 1 }).state, "planned");
  const escalated = nextAttempt(task, { attempts: 2 });
  assert.equal(escalated.executor, "doc-heavy");
  assert.equal(escalated.model, "");
  assert.equal(nextAttempt(task, { ...escalated, attempts: 3 }).state, "waiting_human");
});
test("同じ系統への昇格は model を保持し、既定は人に昇格する", () => {
  assert.equal(nextAttempt({ ...task, executor: "doc-light", retry: { max: 0, escalate_to: "doc-heavy" } }, { attempts: 1, model: "sonnet" }).model, "sonnet");
  assert.equal(nextAttempt({ ...task, retry: undefined } as unknown as TaskSpec, { attempts: 2 }).state, "waiting_human");
});
