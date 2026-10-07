import assert from "node:assert/strict";
import test from "node:test";
import type { Fact, FactInput, RelationKind } from "../../src/ledger/facts.ts";
import { extractProvisionalName, projectConversations } from "../../src/ledger/projections/conversations.ts";
import { projectMessages } from "../../src/ledger/projections/messages.ts";
import { compareEventOrder } from "../../src/ledger/event-order.ts";
import { createNativeId, projectRelations, selectConfirmedRelations } from "../../src/ledger/projections/relations.ts";

const TS = "2026-01-01T00:00:00.000Z";
function createFact(input: FactInput): Fact {
  return { ...input, fact_id: `${input.source}:${input.source_event_id}`, seq: 1,
    observed_ts: TS, payload_hash: "hash", schema_version: 1, cursor: null,
    supersedes: input.supersedes ?? null } as Fact;
}
function createConversation(id: string, extra: Partial<Extract<FactInput, { kind: "conversation.created" }>["payload"]> = {}): Fact {
  return createFact({ source: "host-codex", source_event_id: id, kind: "conversation.created", subject: `conversation:${id}`,
    payload: { provider: "codex", native_id: id, origin: "managed", type: "interactive", history_format: "paginated", ...extra },
    source_ts: TS, confidence: "confirmed" });
}
function createRelation(type: RelationKind, confidence: "confirmed" | "inferred" | "unknown" = "confirmed"): Fact {
  return createFact({ source: "rollout-codex", source_event_id: type, kind: "relation.created", subject: `relation:${type}`,
    payload: { type, from_id: "a", to_id: type === "compacted" ? "a" : "b", evidence: { native: "edge" }, confidence, active: true },
    source_ts: TS, confidence });
}
function createMessage(id: string, body: string, nativeId = id): Fact {
  return createFact({ source: "host-codex", source_event_id: id, kind: "message.created", subject: `message:${id}`,
    payload: { provider: "codex", native_id: nativeId, version: 1, role: "user", body, body_state: "stored" },
    source_ts: TS, confidence: "confirmed" });
}
function createMembership(id: string, conversationId: string, messageId: string): Fact {
  return createFact({ source: "rollout-codex", source_event_id: id, kind: "message_membership.created", subject: `message_membership:${id}`,
    payload: { message_id: messageId, conversation_id: conversationId, active: true }, source_ts: TS, confidence: "confirmed" });
}

for (const type of ["continued", "forked", "copied", "delegated", "adopted"] as const) {
  test(`${type} は端点を残し、会話と共有の発言を別に投影する`, () => {
    const facts = [createConversation("a"), createConversation("b"), createRelation(type),
      createMessage("m1", "最初の指示。次の文。", "shared"), createMessage("m2", "最初の指示。次の文。", "shared"),
      createMembership("a-m", "a", "m1"), createMembership("b-m", "b", "m2")];
    const conversations = projectConversations(facts);
    const messages = projectMessages(facts);
    assert.equal(conversations.conversations.length, 2);
    assert.equal(conversations.relations[0].type, type);
    assert.equal(conversations.relations[0].from_id, createNativeId("codex", "a"));
    assert.equal(conversations.relations[0].to_id, createNativeId("codex", "b"));
    assert.ok(conversations.conversations.some((conversation) => conversation.id === conversations.relations[0].from_id));
    assert.ok(conversations.conversations.some((conversation) => conversation.id === conversations.relations[0].to_id));
    assert.equal(messages.messages.length, 1);
    assert.equal(messages.message_memberships.length, 2);
    assert.deepEqual(new Set(messages.message_memberships.map((membership) => membership.message_id)), new Set([createNativeId("codex", "shared")]));
    assert.equal(conversations.conversations[0].name, "最初の指示。");
    assert.equal(conversations.conversations[0].name_is_provisional, true);
  });
}
test("compacted は会話を増やさず、要約を別の発言にする", () => {
  const facts = [createConversation("a"), createRelation("compacted"), createMessage("original", "元の本文"),
    createMessage("summary", "要約"), createMembership("original", "a", "original"), createMembership("summary", "a", "summary")];
  assert.equal(projectConversations(facts).conversations.length, 1);
  const relation = projectRelations(facts)[0];
  assert.equal(relation.from_id, createNativeId("codex", "a"));
  assert.equal(relation.to_id, relation.from_id);
  assert.equal(projectMessages(facts).messages.length, 2);
});
test("推定と不明の関係は会話の統合や操作先の選択に使わない", () => {
  for (const confidence of ["inferred", "unknown"] as const) {
    const projection = projectConversations([createConversation("a"), createConversation("b"), createRelation("continued", confidence)]);
    assert.equal(projection.conversations.length, 2);
    assert.equal(selectConfirmedRelations(projection.relations).length, 0);
    assert.deepEqual(projection.operation_targets, [createNativeId("codex", "a"), createNativeId("codex", "b")]);
  }
});
test("訂正は関係を取り消し、元の事実と未変更の列を保つ", () => {
  const original = createRelation("continued", "inferred");
  const correction = createFact({ source: "ui", source_event_id: "cancel", kind: "relation.corrected", subject: original.subject,
    payload: { active: false, confidence: "confirmed" }, supersedes: original.fact_id, source_ts: TS, confidence: "confirmed" });
  const facts = [original, correction];
  const snapshot = structuredClone(facts);
  const relations = projectRelations(facts);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].active, false);
  assert.equal(relations[0].type, "continued");
  assert.equal(selectConfirmedRelations(relations).length, 0);
  assert.deepEqual(facts, snapshot);
  assert.deepEqual(projectRelations([...facts].reverse()), relations);
});
test("継続元の再開でも、両端は独立した操作先として残る", () => {
  const facts = [createConversation("a"), createConversation("b"), createRelation("continued"),
    createFact({ source: "host-codex", source_event_id: "resume-a", kind: "run.created", subject: "run:a-2",
      payload: { conversation_id: "a", generation: 2, state: "running" }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" })];
  assert.deepEqual(projectConversations(facts).operation_targets, [createNativeId("codex", "a"), createNativeId("codex", "b")]);
});
test("到着順、seq、受信時刻、再送で投影は変わらない", () => {
  const facts = [createConversation("a"), createConversation("b"), createRelation("forked"), createMessage("m", "指示"), createMembership("membership", "a", "m")];
  const expected = projectConversations(facts);
  for (let index = 0; index < facts.length; index += 1) {
    const reordered = [...facts.slice(index), ...facts.slice(0, index)].reverse().map((fact, seq) => ({ ...fact, seq,
      observed_ts: "2026-02-01T00:00:00.000Z" }));
    assert.deepEqual(projectConversations([...reordered, ...reordered]), expected);
    assert.deepEqual(projectMessages(reordered), projectMessages(facts));
  }
});
test("native ID が同じ観測はホストへ寄せ、未対応の履歴も隠さない", () => {
  const host = createConversation("a", { history_format: "future-format" });
  const observation = createFact({ source: "rollout-codex", source_event_id: "observed", kind: "conversation.created", subject: "conversation:observed",
    payload: { provider: "codex", native_id: "a", origin: "observed", type: "interactive", history_format: "legacy" },
    source_ts: "2026-02-01T00:00:00.000Z", confidence: "confirmed" });
  const projection = projectConversations([host, observation]);
  assert.equal(projection.conversations.length, 1);
  assert.equal(projection.conversations[0].origin, "managed");
  assert.equal(projection.conversations[0].history_format, "future-format");
  assert.equal(projection.conversations[0].name, null);
});
test("ホストの発言を優先し、履歴との差を欠落として返す", () => {
  const host = createMessage("m", "ホストの本文");
  const observation = createFact({ source: "rollout-codex", source_event_id: "history", kind: "message.created", subject: "message:history",
    payload: { provider: "codex", native_id: "m", version: 1, role: "user", body: "異なる本文", body_state: "stored" },
    source_ts: "2026-02-01T00:00:00.000Z", confidence: "confirmed" });
  const projection = projectMessages([observation, host]);
  assert.equal(projection.messages[0].body, "ホストの本文");
  assert.deepEqual(projection.discrepancies, [{ message_id: createNativeId("codex", "m"), fact_ids: [observation.fact_id] }]);
});
test("部分訂正の連鎖と所属の取り消しを順序によらず反映する", () => {
  const message = createMessage("m", "元の本文");
  const correction = createFact({ source: "host-codex", source_event_id: "correct", kind: "message.corrected", subject: message.subject,
    payload: { body: "訂正本文" }, supersedes: message.fact_id, source_ts: TS, confidence: "confirmed" });
  const second = createFact({ source: "host-codex", source_event_id: "correct-2", kind: "message.corrected", subject: message.subject,
    payload: { role: "assistant" }, supersedes: correction.fact_id, source_ts: TS, confidence: "confirmed" });
  const membership = createMembership("member", "a", "m");
  const cancellation = createFact({ source: "ui", source_event_id: "cancel", kind: "message_membership.corrected", subject: membership.subject,
    payload: { active: false }, supersedes: membership.fact_id, source_ts: TS, confidence: "confirmed" });
  const facts = [second, cancellation, message, membership, correction, createConversation("a")];
  const projection = projectMessages(facts);
  assert.equal(projection.messages[0].body, "訂正本文");
  assert.equal(projection.messages[0].role, "assistant");
  assert.equal(projection.message_memberships[0].active, false);
  assert.deepEqual(projectMessages([...facts].reverse()), projection);
});

test("発言の新版を時刻より優先し、古い版の訂正で巻き戻さない", () => {
  const original = createMessage("m", "旧版");
  const newer = createFact({ source: "host-codex", source_event_id: "new-version", kind: "message.version_created", subject: original.subject,
    payload: { provider: "codex", native_id: "m", version: 2, role: "assistant", body: "新版", body_state: "stored" },
    source_ts: TS, confidence: "confirmed" });
  const oldCorrection = createFact({ source: "host-codex", source_event_id: "old-correction", kind: "message.corrected", subject: original.subject,
    payload: { body: "旧版の訂正" }, supersedes: original.fact_id, source_ts: "2026-03-01T00:00:00.000Z", confidence: "confirmed" });
  const projection = projectMessages([newer, original, oldCorrection]);
  assert.equal(projection.messages[0].version, 2);
  assert.equal(projection.messages[0].body, "新版");
  assert.deepEqual(projectMessages([oldCorrection, original, newer]), projection);
});
test("provider が異なる native ID は別実体で、保持整理後も一覧に残る", () => {
  const codex = createConversation("a");
  const claude = createConversation("claude", { provider: "claude", native_id: "a", origin: "observed", type: "subagent", history_format: "jsonl" });
  const purged = { ...createConversation("purged"), payload: null } as Fact;
  const conversations = projectConversations([codex, claude, purged]).conversations;
  assert.equal(conversations.length, 3);
  assert.equal(conversations.find((conversation) => conversation.provider === "claude")?.type, "subagent");
  const codexMessage = createMessage("m", "Codex");
  const claudeMessage = createFact({ source: "host-claude", source_event_id: "claude-m", kind: "message.created", subject: "message:claude-m",
    payload: { provider: "claude", native_id: "m", version: 1, role: "user", body: "Claude", body_state: "stored" },
    source_ts: TS, confidence: "confirmed" });
  assert.equal(projectMessages([codexMessage, claudeMessage]).messages.length, 2);
});
test("未採番の作業があっても会話は先頭の文を仮名として表示する", () => {
  const task = createFact({ source: "intake", source_event_id: "task", kind: "task.created", subject: "task:task",
    payload: { project: "agent-graph", purpose: "指示", state: "open" }, source_ts: TS, confidence: "confirmed" });
  const facts = [task, createConversation("a", { task_id: "task" }), createMessage("m", "指示。続き。"), createMembership("member", "a", "m")];
  const projection = projectConversations(facts);
  assert.equal(projection.conversations[0].name, "指示。");
  assert.equal(projection.conversations[0].name_is_provisional, true);
  assert.equal(projection.tasks[0].name, undefined);
  const namedTask = { ...task, payload: { ...task.payload, name: "agent-graph-1" } } as Fact;
  assert.equal(projectConversations([namedTask, ...facts.slice(1)]).conversations[0].name, "agent-graph-1");
});
test("関係の根拠のキー順や所属の別 subject は実体を増やさない", () => {
  const original = createRelation("copied");
  const duplicate = createFact({ source: "hook", source_event_id: "duplicate", kind: "relation.created", subject: "relation:duplicate",
    payload: { type: "copied", from_id: "a", to_id: "b", evidence: { first: 1, second: 2 }, confidence: "confirmed", active: true },
    source_ts: TS, confidence: "confirmed" });
  const reverseKeys = createFact({ source: "ui", source_event_id: "duplicate-2", kind: "relation.created", subject: "relation:duplicate-2",
    payload: { type: "copied", from_id: "a", to_id: "b", evidence: { second: 2, first: 1 }, confidence: "confirmed", active: true },
    source_ts: TS, confidence: "confirmed" });
  assert.equal(projectRelations([duplicate, reverseKeys]).length, 1);
  assert.equal(projectRelations([original, duplicate]).length, 2);
  const facts = [createConversation("a"), createMessage("m", "本文"), createMembership("one", "a", "m"), createMembership("two", "a", "m")];
  assert.equal(projectMessages(facts).message_memberships.length, 1);
});
test("別 subject の端点と native の端点も同じ関係へ寄せ、訂正で取り消せる", () => {
  const original = createRelation("continued");
  const duplicate = createFact({ source: "hook", source_event_id: "duplicate-edge", kind: "relation.created",
    subject: "relation:duplicate-edge", payload: { type: "continued", from_id: "observed-a",
      to_id: createNativeId("codex", "b"), evidence: { native: "edge" }, confidence: "confirmed", active: true },
    source_ts: TS, confidence: "confirmed" });
  const correction = createFact({ source: "ui", source_event_id: "cancel-edge", kind: "relation.corrected",
    subject: duplicate.subject, payload: { active: false }, supersedes: duplicate.fact_id,
    source_ts: TS, confidence: "confirmed" });
  const facts = [createConversation("a"), createConversation("b"),
    createConversation("observed-a", { native_id: "a" }), original, duplicate,
    createMessage("m", "本文"), createMembership("member", "observed-a", "m")];
  const snapshot = structuredClone(facts);
  const relations = projectRelations(facts);
  assert.equal(relations.length, 1);
  assert.equal(relations[0].from_id, projectMessages(facts).message_memberships[0].conversation_id);
  assert.equal(relations[0].id, JSON.stringify(["continued", createNativeId("codex", "a"),
    createNativeId("codex", "b"), '{"native":"edge"}']));
  const cancelled = projectRelations([...facts, correction]);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].active, false);
  assert.deepEqual(projectRelations([correction, ...facts].reverse()), cancelled);
  assert.deepEqual(projectRelations([...facts].reverse()), relations);
  assert.deepEqual(facts, snapshot);
});
test("会話 ID の部分訂正を関係と所属の両方に反映し、未知の端点を残す", () => {
  const conversation = createConversation("a");
  const correction = createFact({ source: "host-codex", source_event_id: "native-correction",
    kind: "conversation.corrected", subject: conversation.subject,
    payload: { native_id: "corrected-a" }, supersedes: conversation.fact_id,
    source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
  const facts = [conversation, correction, createRelation("continued"), createMessage("m", "本文"),
    createMembership("member", "a", "m")];
  const projection = projectConversations(facts);
  assert.equal(projection.relations[0].from_id, projection.conversations[0].id);
  assert.equal(projection.relations[0].from_id, projectMessages(facts).message_memberships[0].conversation_id);
  assert.equal(projection.relations[0].to_id, "b");
  assert.deepEqual(projectConversations([...facts].reverse()), projection);
});

test("会話の所属変更はホストの作成より後なら ui からも反映する", () => {
  const conversation = createConversation("a", { task_id: "t1" });
  const changed = createFact({ source: "ui", source_event_id: "move", kind: "conversation.task_changed",
    subject: conversation.subject, payload: { task_id: "t2" }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
  const detached = createFact({ source: "ui", source_event_id: "detach", kind: "conversation.task_changed",
    subject: conversation.subject, payload: { task_id: null }, source_ts: "2026-01-03T00:00:00.000Z", confidence: "confirmed" });
  assert.equal(projectConversations([changed, conversation]).conversations[0].task_id, "t2");
  const facts = [detached, conversation, changed];
  const projection = projectConversations(facts);
  assert.equal(projection.conversations[0].task_id, null);
  assert.deepEqual(projectConversations([...facts].reverse()), projection);
});

test("関係の状態変更は作成の出所によらず時刻の後勝ちにする", () => {
  for (const source of ["ui", "intake"] as const) {
    const relation = createFact({ source, source_event_id: "edge", kind: "relation.created", subject: "relation:edge",
      payload: { type: "continued", from_id: "a", to_id: "b", evidence: "native", confidence: "confirmed", active: true },
      source_ts: TS, confidence: "confirmed" });
    const cancelled = createFact({ source: "hook", source_event_id: "cancel", kind: "relation.state_changed",
      subject: relation.subject, payload: { active: false }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
    const restored = createFact({ source: "rollout-codex", source_event_id: "restore", kind: "relation.state_changed",
      subject: relation.subject, payload: { active: true }, source_ts: "2026-01-03T00:00:00.000Z", confidence: "confirmed" });
    assert.equal(projectRelations([cancelled, relation])[0].active, false);
    const facts = [restored, relation, cancelled];
    const projection = projectRelations(facts);
    assert.equal(projection[0].active, true);
    assert.deepEqual(projectRelations([...facts].reverse()), projection);
  }
});

test("作業と所属と本文保存状態の変更も出所で巻き戻さない", () => {
  const task = createFact({ source: "host-codex", source_event_id: "task", kind: "task.created", subject: "task:t",
    payload: { project: "agent-graph", purpose: "目的", state: "open" }, source_ts: TS, confidence: "confirmed" });
  const taskChanged = createFact({ source: "ui", source_event_id: "close", kind: "task.state_changed", subject: task.subject,
    payload: { state: "closed" }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
  const message = createMessage("m", "本文");
  const bodyChanged = createFact({ source: "rollout-codex", source_event_id: "omit", kind: "message.body_state_changed",
    subject: message.subject, payload: { body_state: "omitted" }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
  const membership = createMembership("member", "a", "m");
  const membershipChanged = createFact({ source: "ui", source_event_id: "remove", kind: "message_membership.state_changed",
    subject: membership.subject, payload: { active: false }, source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
  const facts = [task, taskChanged, message, bodyChanged, membership, membershipChanged, createConversation("a")];
  const projection = projectMessages(facts);
  assert.equal(projection.messages[0].body_state, "omitted");
  assert.equal(projection.message_memberships[0].active, false);
  assert.equal(projectConversations(facts).tasks[0].state, "closed");
  assert.deepEqual(projectMessages([...facts].reverse()), projection);
  assert.deepEqual(projectConversations([...facts].reverse()), projectConversations(facts));
});

test("作成より古い所属変更では所属を巻き戻さない", () => {
  const conversation = createConversation("a", { task_id: "t2" });
  const old = createFact({ source: "ui", source_event_id: "old", kind: "conversation.task_changed",
    subject: conversation.subject, payload: { task_id: "t1" }, source_ts: "2025-12-31T00:00:00.000Z", confidence: "confirmed" });
  assert.equal(projectConversations([old, conversation]).conversations[0].task_id, "t2");
  assert.deepEqual(projectConversations([old, conversation]), projectConversations([conversation, old]));
});

test("履歴の新版はホストの旧版に勝ち、同じ版はホストを優先する", () => {
  const original = createMessage("m", "ホストの旧版");
  const newer = createFact({ source: "rollout-codex", source_event_id: "history-v2", kind: "message.version_created",
    subject: "message:history", payload: { provider: "codex", native_id: "m", version: 2,
      role: "assistant", body: "履歴の新版", body_state: "stored" }, source_ts: TS, confidence: "confirmed" });
  const facts = [original, newer];
  const projection = projectMessages(facts);
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.messages[0].version, 2);
  assert.equal(projection.messages[0].body, "履歴の新版");
  assert.deepEqual(projectMessages([...facts].reverse()), projection);
  const host = createFact({ source: "host-codex", source_event_id: "host-v2", kind: "message.version_created",
    subject: original.subject, payload: { provider: "codex", native_id: "m", version: 2,
      role: "assistant", body: "ホストの新版", body_state: "stored" }, source_ts: TS, confidence: "confirmed" });
  assert.equal(projectMessages([newer, host, original]).messages[0].body, "ホストの新版");
  assert.deepEqual(projectMessages([newer, host, original]), projectMessages([original, host, newer]));
});

test("仮の名前の先頭文を全角の疑問符と感嘆符で区切る", () => {
  for (const punctuation of ["？", "！"]) {
    const projection = projectConversations([createConversation("a"), createMessage("m", `最初${punctuation}次の文。`),
      createMembership("member", "a", "m")]);
    assert.equal(projection.conversations[0].name, `最初${punctuation}`);
  }
});

test("同じ subject の会話 ID が競合してもホストと端点と所属を揃える", () => {
  const host = createConversation("a");
  const observation = createFact({ source: "rollout-codex", source_event_id: "conflicting-id",
    kind: "conversation.created", subject: host.subject,
    payload: { provider: "codex", native_id: "wrong-a", origin: "observed", type: "interactive", history_format: "legacy" },
    source_ts: "2026-02-01T00:00:00.000Z", confidence: "confirmed" });
  const facts = [host, observation, createRelation("continued"), createMessage("m", "先頭。次。"),
    createMembership("member", "a", "m")];
  const projection = projectConversations(facts);
  assert.equal(projection.conversations[0].id, createNativeId("codex", "a"));
  assert.equal(projection.conversations[0].name, "先頭。");
  assert.equal(projection.relations[0].from_id, projection.conversations[0].id);
  assert.equal(projectMessages(facts).message_memberships[0].conversation_id, projection.conversations[0].id);
  assert.deepEqual(projectConversations([...facts].reverse()), projection);
});

test("発言の native ID の部分訂正でも本文と時刻と所属を揃える", () => {
  const original = createMessage("m", "本文");
  const correction = createFact({ source: "host-codex", source_event_id: "correct-native-id",
    kind: "message.corrected", subject: original.subject, payload: { native_id: "corrected-m" },
    supersedes: original.fact_id, source_ts: "2026-02-01T00:00:00.000Z", confidence: "confirmed" });
  const facts = [original, correction, createConversation("a"), createMembership("member", "a", "m")];
  const projection = projectMessages(facts);
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.messages[0].id, createNativeId("codex", "corrected-m"));
  assert.equal(projection.messages[0].source_ts, TS);
  assert.equal(projection.messages[0].body, "本文");
  assert.equal(projection.message_memberships[0].message_id, projection.messages[0].id);
  assert.deepEqual(projectMessages([...facts].reverse()), projection);
});

test("空白だけの発言を仮名にせず、次の先頭文を使う", () => {
  const facts = [createConversation("a"), createMessage("first", " \n "), createMessage("second", "有効な文。続き。"),
    createMembership("first-member", "a", "first"), createMembership("second-member", "a", "second")];
  assert.equal(projectConversations(facts).conversations[0].name, "有効な文。");
});

test("仮の名前は、ホストが差し込んだ AGENTS.md や skills の本文を飛ばして利用者の最初の文を使う", () => {
  assert.equal(extractProvisionalName("<skills_instructions>\nUse /eli5 for explanations.\n</skills_instructions>\n/eli5が使えるようにしたい。詳細は後で。"), "/eli5が使えるようにしたい。");
  assert.equal(extractProvisionalName("# AGENTS.md\n\n## 目的\nこのリポジトリの規約。\n"), "");
  assert.equal(extractProvisionalName("# タスク X5: 横断検索を作る\n\n## 目的\n横断検索を作る。"), "横断検索を作る");
  assert.equal(extractProvisionalName("無人実行です。質問せずに作業を完了し、最後に結果を報告してください。\n元の依頼:\nChanges の画面を直す。"), "Changes の画面を直す。");
  assert.equal(extractProvisionalName("<recommended_plugins>\nnpx がパッケージ確認で待機しています"), "");
  assert.equal(extractProvisionalName("done"), "done");
});

test("名前の規則は、同じ行の札、Codex の AGENTS.md、依頼を包む札、元の依頼の後の本文を正しく読む", () => {
  assert.equal(extractProvisionalName("<multi_agent_role>You are `/root`, the primary agent.</multi_agent_role>\n画面の名前を直す。"), "画面の名前を直す。");
  assert.equal(extractProvisionalName("<multi_agent_role>You are `/root`, the primary agent."), "");
  assert.equal(extractProvisionalName("<permissions instructions>\nsandbox\n</permissions instructions>\n依頼の本文。"), "依頼の本文。");
  assert.equal(extractProvisionalName("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"), "");
  assert.equal(extractProvisionalName("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n# 規約\n本文\n</INSTRUCTIONS>\n検索を速くする。続き"), "検索を速くする。");
  assert.equal(extractProvisionalName("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n# 規約\n</INSTRUCTIONS>"), "");
  assert.equal(extractProvisionalName("<task>\nPort best.py to C++. Keep the output.\n</task>"), "Port best.py to C++.");
  assert.equal(extractProvisionalName("<task>Read /repo/best.py and report.</task>"), "Read /repo/best.py and report.");
  assert.equal(extractProvisionalName("元の依頼:\n# タスク D1: 画面への配信を作る\n本文"), "画面への配信を作る");
  assert.equal(extractProvisionalName("無人実行です。質問せずに作業を完了してください。読み取り専用のタスクです。設計を読む。"), "設計を読む。");
  assert.equal(extractProvisionalName("Review a delegated task. Do not edit files.\nJudge the fixed artifact.\n\nOriginal request:\n{\"title\":\"Intake check\",\"task\":\"Reply OK.\"}\n\nImplementer reply:\nOK"), "Review of Intake check");
  assert.equal(extractProvisionalName("Review a delegated task.\n# タスク X5: 横断検索を作る\nレビュー"), "Review of 横断検索を作る");
  assert.equal(extractProvisionalName("レビュー対象: タスク T2: イベント型を実装\n本文"), "Review of イベント型を実装");
  assert.equal(extractProvisionalName("# 解法を見直す\n\n## 目的\n手数を縮める。"), "解法を見直す");
  assert.equal(extractProvisionalName("candidates/v32/main.py を土台に v33 を作る。背景"), "candidates/v32/main.py を土台に v33 を作る。");
  assert.equal(extractProvisionalName("- 相手との結合は共有市場だけ。"), "相手との結合は共有市場だけ。");
  assert.equal(extractProvisionalName("Base directory for this skill: /Users/r/.claude/skills/plan\n\n# plan"), "");
  assert.equal(extractProvisionalName("This session is being continued from a previous conversation that ran out of context.\nSummary"), "");
  assert.equal(extractProvisionalName([{ type: "tool_result", content: "出力。" }]), "");
  assert.equal(extractProvisionalName([{ type: "input_text", text: "Codex への依頼。続き" }]), "Codex への依頼。");
  assert.equal(extractProvisionalName("あ".repeat(400)).length, 160);
});

test("名前と依頼の抜粋は利用者の発言だけから作り、無人実行は抜粋を仮の名前にする", () => {
  const message = (id: string, role: string, body: string, second: number) => createFact({ source: "rollout-codex", source_event_id: id,
    kind: "message.created", subject: `message:${id}`, payload: { provider: "codex", native_id: id, version: 1, role, body, body_state: "stored" },
    source_ts: new Date(Date.parse(TS) + second * 1000).toISOString(), confidence: "confirmed" });
  const facts = [createConversation("a"), createConversation("u", { type: "unattended" }),
    message("developer", "developer", "<skills_instructions>\nskills\n</skills_instructions>\nスキルの一覧。", 0),
    message("reply", "assistant", "応答を先に記録した。", 1),
    message("agents", "user", "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n規約\n</INSTRUCTIONS>", 2),
    message("request", "user", "依頼の本文。続き", 3),
    ...["developer", "reply", "agents", "request"].flatMap(id => [createMembership(`a-${id}`, "a", id), createMembership(`u-${id}`, "u", id)])];
  const conversations = projectConversations(facts).conversations;
  const named = conversations.find(row => row.native_id === "a")!;
  const unattended = conversations.find(row => row.native_id === "u")!;
  assert.deepEqual([named.name, named.name_is_provisional, named.first_request_excerpt], ["依頼の本文。", true, "依頼の本文。"]);
  assert.deepEqual([unattended.name, unattended.name_is_provisional, unattended.first_request_excerpt], ["依頼の本文。", true, "依頼の本文。"]);
  assert.deepEqual(projectConversations([...facts].reverse()).conversations, conversations);
});

test("同じ時刻の発言は、識別子に含まれる行の位置を数として比べ、桁数が違っても逆転しない", () => {
  assert.ok(compareEventOrder("message:rollout-a.jsonl:9999:ff:1", "message:rollout-a.jsonl:104048:aa:1") < 0);
  assert.ok(compareEventOrder("message:rollout-a.jsonl:104048:aa:1", "message:rollout-a.jsonl:9999:ff:1") > 0);
  assert.ok(compareEventOrder("x:2", "x:10") < 0 && compareEventOrder("x:a", "x:1") > 0 && compareEventOrder("x:7", "x:7") === 0);
  const line = (offset: number, body: string) => createFact({ source: "rollout-codex", source_event_id: `message:rollout-a.jsonl:${offset}:h:1`,
    kind: "message.created", subject: `message:m${offset}`, payload: { provider: "codex", native_id: `m${offset}`, version: 1, role: "user", body, body_state: "stored" },
    source_ts: TS, confidence: "confirmed" });
  const facts = [createConversation("a"), line(104048, "後の依頼。"), line(9999, "最初の依頼。"),
    createMembership("first", "a", "m9999"), createMembership("later", "a", "m104048")];
  assert.equal(projectConversations(facts).conversations[0].name, "最初の依頼。");
  assert.equal(projectConversations([...facts].reverse()).conversations[0].name, "最初の依頼。");
});
