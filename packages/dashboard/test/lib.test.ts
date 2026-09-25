import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as lib from "../src/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/project.json", import.meta.url), "utf8")) as {
  sessions: { id: string; nodes: lib.VisibleScope["nodes"]; edges: lib.VisibleScope["edges"]; turns: { at: string }[] }[];
  graphs: { id: string; nodes: lib.LayoutNode[]; edges: lib.LayoutEdge[] }[];
};

test("段組みは入力順によらず決定的で、root が最上段、深い層ほど下に置く", () => {
  const session = fixture.sessions[0];
  const view = { nodes: session.nodes!, edges: session.edges! };
  const first = lib.layoutGraph(view);
  const reversed = lib.layoutGraph({ nodes: [...view.nodes].reverse(), edges: [...view.edges].reverse() });
  assert.deepEqual([...first.pos.entries()], [...reversed.pos.entries()]);
  assert.deepEqual(first.rows, reversed.rows);
  const root = first.pos.get("s10")!;
  const child = first.pos.get("C0")!;
  const grandchild = first.pos.get("RV")!;
  assert.ok(root.y < child.y && child.y < grandchild.y);
  assert.equal(first.rows[0][0], "s10");
  // 戻りの辺は層の計算に入れない
  assert.equal(first.rows[1].length, 10);
});

test("段組みは maxWidth を超える層を折り返し、planner のグラフは入る辺の無い task を最上段にする", () => {
  const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, kind: "delegation" }));
  const edges = nodes.map((n) => ({ from: "r", to: n.id, kind: "delegate" }));
  const wide = lib.layoutGraph({ nodes: [{ id: "r", kind: "root" }, ...nodes], edges });
  const wrapped = lib.layoutGraph({ nodes: [{ id: "r", kind: "root" }, ...nodes], edges }, { maxWidth: 700 });
  assert.ok(wrapped.width < wide.width);
  assert.equal(wrapped.rows.length, 3);
  assert.equal(wrapped.rows[1].length + wrapped.rows[2].length, 9);
  assert.ok(wrapped.width <= 700);
  const graph = fixture.graphs[0];
  const planner = lib.layoutGraph({ nodes: graph.nodes, edges: graph.edges });
  assert.deepEqual(planner.rows[0], ["C0", "P1"]);
  assert.deepEqual(planner.rows[planner.rows.length - 1], ["PR"]);
  assert.equal(lib.fitScale(1200, 400, 600), 0.5);
  assert.equal(lib.fitScale(300, 400, 600), 1);
});

test("辺の曲線と中点と膨らみ", () => {
  assert.equal(lib.edgeCurve(0, 0, 100, 100), "M0,0 C0,40 100,60 100,100");
  assert.deepEqual(lib.edgeMid(0, 0, 100, 100, 40), { x: 80, y: 50 });
  assert.deepEqual(lib.edgePoint(0, 0, 100, 100, 0, 0.5), { x: 50, y: 50 });
  assert.ok(lib.backBulge(10, 20, 800) > 0);
  assert.ok(lib.backBulge(300, 320, 800) < 0);
});

test("モデル名の整形。日付と 1M を扱い、規則に合わない id はそのまま", () => {
  assert.equal(lib.modelLabel("claude-fable-5-1"), "Fable 5.1");
  assert.equal(lib.modelLabel("claude-fable-5-1[1m]"), "Fable 5.1 1M");
  assert.equal(lib.modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(lib.modelLabel("claude-opus-5"), "Opus 5");
  assert.equal(lib.modelLabel("gpt-6-astra"), "GPT 6 Astra");
  assert.equal(lib.modelLabel("gpt-5.6-terra"), "GPT 5.6 Terra");
  assert.equal(lib.modelLabel("gpt-6"), "GPT 6");
  assert.equal(lib.modelLabel("o3-pro"), "o3-pro");
  assert.equal(lib.modelLabel(undefined), "");
});

test("長いモデル名は 2 行に折り、切らない", () => {
  assert.deepEqual(lib.fitWords("Fable 5.1"), { lines: ["Fable 5.1"], size: "" });
  assert.deepEqual(lib.fitWords("GPT 5.6 Terra"), { lines: ["GPT 5.6", "Terra"], size: "" });
  assert.deepEqual(lib.fitWords("GPT 6 Astra"), { lines: ["GPT 6", "Astra"], size: "" });
  const long = lib.fitWords("Fable 5.1 Extended Thinking");
  assert.equal(long.lines.join(" "), "Fable 5.1 Extended Thinking");
  assert.equal(long.size, "tight");
  assert.deepEqual(lib.fitWords("abcdefghijklmnop").lines, ["abcdefgh", "ijklmnop"]);
});

test("役割の推定と系統の題名", () => {
  assert.equal(lib.roleLabel({ kind: "subagent", executor: "reviewer" }), "Review");
  assert.equal(lib.roleLabel({ kind: "subagent", executor: "doc-light" }), "Docs");
  assert.equal(lib.roleLabel({ kind: "subagent", executor: "Explore" }), "Research");
  assert.equal(lib.roleLabel({ kind: "task", executor: "human" }), "Gate");
  assert.equal(lib.roleLabel({ kind: "task", executor: "pr" }), "PR");
  assert.equal(lib.roleLabel({ kind: "delegation", executor: "codex", title: "契約を固定する" }), "Coding");
  assert.equal(lib.roleLabel({ kind: "delegation", executor: "codex", title: "旧版を調査する" }), "Research");
  assert.equal(lib.roleLabel({ kind: "delegation", executor: "codex", role: "review" }), "Review");
  assert.equal(lib.roleLabel({ kind: "task" }), "Task");
  assert.equal(lib.kindTitle({ kind: "root", family: "anthropic" }), "Claude");
  assert.equal(lib.kindTitle({ kind: "delegation", executor: "codex" }), "Codex");
  assert.equal(lib.kindTitle({ kind: "task", executor: "human" }), "Task");
  assert.equal(lib.familyOf({ executor: "doc-heavy" }), "anthropic");
});

test("状態表は契約の全 Status を引け、lost と ended は沈んだ灰にする", () => {
  const statuses = ["planned", "running", "waiting", "waiting_human", "conflict", "done", "failed", "rejected", "lost", "timeout", "denied", "ended"];
  for (const s of statuses) assert.ok(lib.STATUS_CLASS[s], `${s} が状態表に無い`);
  assert.equal(lib.statusClass("lost"), "ended");
  assert.equal(lib.statusClass("stalled"), "failed");
  assert.equal(lib.statusClass("denied"), "failed");
  assert.equal(lib.statusClass("waiting_human"), "waiting");
  assert.equal(lib.statusLabel("waiting_human"), "Waiting");
  assert.equal(lib.statusLabel("lost"), "Lost");
});

test("隠す処理と畳む処理。× で隠した子孫もまとめ、古い完了の末端は自動で畳む", () => {
  const session = fixture.sessions[0];
  const plain = lib.visibleView(session);
  // R1, D1 は直近 2 ターンより前に完了した末端なので畳まれ、RV も同様
  assert.equal(plain.archived, 3);
  assert.ok(plain.nodes.some((n) => n.kind === "archive" && n.title === "3 hidden"));
  assert.ok(!plain.nodes.some((n) => n.id === "R1"));
  assert.ok(plain.edges.some((e) => e.to === lib.ARCHIVE_ID));
  const expanded = lib.visibleView(session, new Set(), true);
  assert.ok(expanded.nodes.some((n) => n.id === "R1"));
  assert.equal(expanded.archived, 3);
  // C0 を × で隠すと子孫の RV も隠れる。作業中の子は隠さない
  const dismissed = new Set([lib.dismissKey("s10", "C0")]);
  const manual = lib.visibleView(session, dismissed);
  assert.ok(!manual.nodes.some((n) => n.id === "C0"));
  assert.ok(!manual.nodes.some((n) => n.id === "RV"));
  assert.ok(manual.nodes.some((n) => n.id === "V2"));
  assert.equal(manual.archived, 4);
  assert.ok(lib.isDismissable({ id: "x", kind: "delegation", status: "done" }));
  assert.ok(lib.isDismissable({ id: "x", kind: "delegation", status: "lost" }));
  assert.ok(!lib.isDismissable({ id: "x", kind: "delegation", status: "running" }));
  assert.ok(!lib.isDismissable({ id: "x", kind: "root", status: "done" }));
});

test("新しい辺とノードは 2 回目以降だけ拾う", () => {
  const first = lib.diffKnown(undefined, ["a", "b"]);
  assert.equal(first.fresh.size, 0);
  const second = lib.diffKnown(first.known, ["a", "b", "c"]);
  assert.deepEqual([...second.fresh], ["c"]);
  assert.ok(second.known.has("c"));
});

test("状態の優先表示。Waiting > Failed > Running > Done、Quiet と Idle と Unavailable", () => {
  assert.deepEqual(lib.orbState({ counts: { running: 2, waiting: 1, failed: 3, done: 4 }, liveSessions: 1 }), { key: "waiting", text: "Waiting 1", quiet: false });
  assert.deepEqual(lib.orbState({ counts: { running: 2, waiting: 0, failed: 3, done: 4 }, liveSessions: 1 }), { key: "failed", text: "Failed 3", quiet: false });
  assert.deepEqual(lib.orbState({ counts: { running: 2, waiting: 0, failed: 0, done: 4 }, liveSessions: 1 }), { key: "running", text: "Running 2", quiet: false });
  assert.deepEqual(lib.orbState({ counts: { running: 0, waiting: 0, failed: 0, done: 4 }, liveSessions: 1 }), { key: "done", text: "Done 4", quiet: false });
  assert.deepEqual(lib.orbState({ counts: { running: 0, waiting: 0, failed: 0, done: 0 }, liveSessions: 1 }), { key: "", text: "Idle", quiet: false });
  assert.deepEqual(lib.orbState({ counts: { running: 0, waiting: 0, failed: 0, done: 9 }, liveSessions: 0 }), { key: "", text: "Quiet", quiet: true });
  assert.deepEqual(lib.orbState({ counts: {}, liveSessions: 1, error: "boom" }), { key: "", text: "Unavailable", quiet: true });
});

test("件数の集計は root と隠したノードを除き、終了したセッションを数えない", () => {
  const counts = lib.countProject(fixture as unknown as Parameters<typeof lib.countProject>[0]);
  assert.equal(counts.waiting, 2);
  assert.equal(counts.failed, 2);
  const hidden = lib.countProject(fixture as unknown as Parameters<typeof lib.countProject>[0], new Set([lib.dismissKey("s10", "F1")]));
  assert.equal(hidden.failed, 1);
  assert.deepEqual(lib.sumCounts([{ running: 1 }, { running: 2, done: 3 }]), { running: 3, waiting: 0, failed: 0, done: 3 });
});

test("利用枠の色分け。70% で warn、90% で high", () => {
  assert.equal(lib.usageLevel(0), "");
  assert.equal(lib.usageLevel(69.9), "");
  assert.equal(lib.usageLevel(70), "warn");
  assert.equal(lib.usageLevel(89), "warn");
  assert.equal(lib.usageLevel(90), "high");
  assert.equal(lib.usageLevel(140), "high");
  assert.equal(lib.usageLevel(undefined), "");
});

test("判断待ちの操作。task の waiting_human は 3 つ、失敗は 2 つ、子の失敗は Retry だけ", () => {
  assert.deepEqual(lib.actionsFor({ kind: "task", status: "waiting_human" }).map((a) => a[0]), ["approve", "retry", "reject"]);
  assert.deepEqual(lib.actionsFor({ kind: "task", status: "conflict" }).map((a) => a[0]), ["approve", "retry", "reject"]);
  assert.deepEqual(lib.actionsFor({ kind: "task", status: "failed" }).map((a) => a[0]), ["retry", "reject"]);
  assert.deepEqual(lib.actionsFor({ kind: "delegation", status: "lost" }).map((a) => a[0]), ["retry"]);
  assert.deepEqual(lib.actionsFor({ kind: "delegation", status: "done" }), []);
});

test("日時と残り時間と経過時間の整形", () => {
  const now = new Date(2026, 8, 25, 15, 40);
  assert.equal(lib.fmtWhen(new Date(2026, 8, 25, 10, 5), false, now), "10:05");
  assert.equal(lib.fmtWhen(new Date(2026, 8, 24, 10, 5), false, now), "Sep 24 10:05");
  assert.equal(lib.fmtWhen(new Date(2025, 8, 24, 10, 5), false, now), "2025 Sep 24 10:05");
  assert.equal(lib.fmtWhen(new Date(2026, 8, 25, 10, 5), true, now), "2026 Sep 25 10:05");
  assert.equal(lib.fmtUntil(new Date(now.getTime() + 30 * 60000), now), "30m");
  assert.equal(lib.fmtUntil(new Date(now.getTime() + 125 * 60000), now), "2h 05m");
  assert.equal(lib.fmtUntil(new Date(now.getTime() - 60000), now), "now");
  assert.equal(lib.fmtElapsed(new Date(now.getTime() - 5 * 3600000).toISOString(), undefined, now), "5h 00m");
  assert.equal(lib.fmtTokens({ input: 48210, output: 612 }), "48k in · 612 out");
});
