import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { installDocument, FakeElement } from "./helpers/dom.ts";

// ui/ は document を呼ぶたびに引くので、読み込む前に差し替える
const doc = installDocument();
const { renderGraph, directionWord } = await import("../public/ui/graph.js");
const { renderOverview } = await import("../public/ui/overview.js");
const { renderHeader } = await import("../public/ui/header.js");
const { buildProjectSection, scopesOf } = await import("../public/ui/project.js");
const { renderDetail, buildBubble } = await import("../public/ui/detail.js");
const { renderDiff } = await import("../public/ui/diff.js");

type Json = Record<string, unknown>;
const project = JSON.parse(readFileSync(new URL("./fixtures/project.json", import.meta.url), "utf8")) as Json;
const overview = JSON.parse(readFileSync(new URL("./fixtures/overview.json", import.meta.url), "utf8")) as Json;

function ctx(extra: Json = {}): Json {
  return {
    dismissed: new Set<string>(), expandedArchive: new Set<string>(), selectedScope: null, selectedNode: null,
    knownEdges: new Map(), knownNodes: new Map(), fresh: new Map(), zoom: new Map(), orbSlots: new Map(),
    expandedRounds: new Set<string>(), hiddenTurns: new Set<string>(), factsOpen: { value: false }, chatView: { key: "", top: 0, stick: true },
    maxWidth: 900, projectName: "agent-graph", confirm: () => true, onOpen() {}, onSelect() {}, onToggleDismiss() {}, onToggleArchive() {},
    onAction: async () => "ok", onHideTurn() {}, ...extra,
  };
}

test("Overview は稼働中を Active に、最近終わったものを Recent に、状態と件数と直近のセッションを添えて出す", () => {
  const canvas = doc.getElementById("canvas")!;
  const c = ctx({ now: () => new Date("2026-09-25T07:00:00.000Z") });
  renderOverview(canvas, overview, c);
  const html = String(canvas);
  for (const word of ["Kaggriculture", "agent-graph", "dotfiles", "obsidian", "Failed 7", "Waiting 1", "Running 3", "Idle", "on-failed", "on-waiting", "on-running", "card-slot",
    "~/00_project/agent-graph", "agent-graph-001", "Opus 5.5", "Needs permission · 3 delegated", "一覧画面を作り直して", "Codex", "GPT 6.1 Sol", "No prompts yet"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  assert.ok(canvas.classList.contains("overview"));
  assert.ok(!html.includes("project-filters"), "Active と All の切り替えは無い");
  const [activeSection, recentSection] = canvas.querySelectorAll(".overview-section");
  assert.ok(String(activeSection).includes("Kaggriculture") && !String(activeSection).includes("notes-003"));
  assert.ok(String(recentSection).includes("notes-003"), "7 日以内に動いた終わったプロジェクトは Recent に出す");
  for (const hidden of ["fde-lecture", "/private/tmp/scratch", "~/00_project/stale"]) assert.ok(!html.includes(hidden), `${hidden} は出さない`);
  renderOverview(canvas, overview, c);
  // カードは使い回す
  const before = (c.orbSlots as Map<string, FakeElement>).get("dotfiles");
  renderOverview(canvas, overview, c);
  assert.equal((c.orbSlots as Map<string, FakeElement>).get("dotfiles"), before);
});

test("ヘッダーはピル列と件数と利用枠の色分けと Live を出す", () => {
  const projects = overview.projects as Json[];
  renderHeader(doc, { projects, selected: ["agent-graph"], counts: { running: 3, waiting: 1, failed: 1, done: 12 }, usage: overview.usage, connection: "live", updatedAt: "2026-09-25T06:40:12.000Z" }, ctx());
  const html = String(doc.body);
  for (const word of ["All projects", "1 / 8 projects", "Running 3", "Waiting 1", "Failed 1", "Done 12", "on-running", "on-waiting", "Session", "Week Fable", "usage-fill high", "usage-fill warn", "92%", "36%", "Live", "connection live", "Updated"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  assert.equal(doc.getElementById("head-sub")!.hidden, false);
  assert.equal(doc.title, "(3) ⏸ Agent Console · agent-graph");
  renderHeader(doc, { projects, selected: [], counts: { running: 0, waiting: 0, failed: 0, done: 0 }, usage: { windows: [] }, connection: "offline", updatedAt: "" }, ctx());
  assert.ok(String(doc.body).includes("Offline"));
  assert.ok(String(doc.body).includes("8 projects"));
  assert.equal(doc.getElementById("head-sub")!.hidden, true);
});

test("グラフは root と子の丸を 3 語で描き、辺と矢印と戻りの破線と触れたときのラベルを持つ", () => {
  const scope = scopesOf(project)[0];
  const holder = renderGraph(scope, ctx({ selectedScope: scope.id, selectedNode: "C0" }));
  const html = String(holder);
  for (const word of ["orb-root", "Claude", "orb-node", "Codex", "GPT 6", "Astra", "Coding", "on-running", "on-waiting", "on-failed", "on-done", "on-ended",
    "edge-back", "marker-end", "edge-label", "Claude → Codex", "Codex → Claude", "契約を固定する", "chip", "3 hidden", "dismiss", "to-running", "node running", "class=\"edge sel\"", "graph-hint"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  // 3 語だけ。題名や id を丸に書かない
  assert.ok(!html.includes("orb-name\">契約"));
  const svg = holder.firstElementChild!;
  assert.ok(Number(svg.getAttribute("width")) <= 900);
  // モデル名を切らない
  assert.ok(!html.includes("…"));
});

test("辺のラベルは本文と向きの語を分け、向きの語は縮めない。行きと戻りのラベルは別の位置に置く", () => {
  const scope = scopesOf(project)[0];
  const holder = renderGraph(scope, ctx());
  const labels = holder.querySelectorAll("foreignObject").filter((fo: FakeElement) => fo.querySelector(".edge-label"));
  const byEdge = new Map<string, FakeElement>();
  for (const label of labels) byEdge.set(label.parentNode!.getAttribute("data-edge")!, label);
  const forward = byEdge.get("s10->C0")!;
  const back = byEdge.get("C0->s10")!;
  assert.ok(forward && back, "行きと戻りのラベルが無い");
  // 向きの語は本文と別の要素。本文だけが省略の対象
  assert.equal(forward.querySelector(".dir")!.textContent, "Claude → Codex");
  assert.equal(forward.querySelector(".txt")!.textContent, "契約を固定する");
  assert.equal(back.querySelector(".dir")!.textContent, "Codex → Claude");
  assert.equal(back.querySelector(".txt")!.textContent, "報告");
  // 同じ 2 つのノードをつなぐ行きと戻りは、はっきり違う高さに置く
  const gap = Math.abs(Number(forward.getAttribute("y")) - Number(back.getAttribute("y")));
  assert.ok(gap >= 22, `行きと戻りのラベルの高さの差が ${gap}px しか無い`);
  // 箱は本文に合わせて縮み、向きの語は flex: none で守る
  const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  assert.match(css, /\.edge-label \.dir \{[^}]*flex: none/);
  assert.match(css, /\.edge-label \.txt \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.edge-label \.edge-pill \{[^}]*max-width: 100%/);
});

test("planner のグラフは task を同じ丸で描き、waiting_human を紫にする", () => {
  const scope = scopesOf(project)[2];
  const html = String(renderGraph(scope, ctx()));
  assert.ok(html.includes("on-waiting"));
  assert.ok(html.includes("Gate"));
  assert.ok(html.includes("PR"));
  assert.ok(html.includes("on-planned"));
  assert.equal(directionWord({ fromFamily: "anthropic", toFamily: "openai" }), "Claude → Codex");
  assert.equal(directionWord({ fromFamily: "openai", toFamily: "openai" }), "");
});

test("プロジェクトは Graph と Changes と Agents のタブを持ち、Graph は生きたセッションの切替とグラフを出す", () => {
  const section = buildProjectSection(project, ctx());
  const html = String(section);
  assert.equal(section.querySelector(".session-group")!.tagName, "section", "グラフは開閉枠に隠さない");
  for (const word of ["agent-graph", "agent-graph-001-s10", "session-picker", "Plan", "planner", "project-tabs", "Graph", "Changes", "Agents"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  assert.ok(!html.includes("History ·"), "終わったセッションの畳みは無い");
  assert.ok(!html.includes("agent-graph-001-s9"), "終わったセッションは選ぶまで Graph に並べない");
  const picked = String(buildProjectSection(project, ctx({ selectedScope: "s9" })));
  assert.ok(picked.includes("agent-graph-001-s9"), "選んだ終わったセッションは切替に並べる");
});

test("Changes はコミットをツリーで並べ、行で差分を開き、セッションの札で会話を開く", () => {
  const opened: string[] = [];
  const commits: string[] = [];
  const commit = (sha: string, subject: string, parents: string[], sessions: Json[], refs: string[] = []) => ({ sha, short: sha.slice(0, 7), subject, author: "r",
    at: "2026-09-25T05:00:00.000Z", parents, refs, files: 2, insertions: 10, deletions: 3, sessions });
  const s10 = { id: "s10", name: "agent-graph-001-s10", client: "claude" };
  const data = { branch: "main", branches: ["main", "feat/tabs"], hasMore: true, commits: [
    commit("ddddddd4", "タブを足す", ["bbbbbbb2"], [s10], ["feat/tabs"]),
    commit("aaaaaaa1", "Merge branch 'feat/list'", ["ccccccc3", "bbbbbbb2"], [s10], ["main"]),
    commit("bbbbbbb2", "一覧を作る", ["ccccccc3"], [s10]),
    commit("ccccccc3", "手で直す", [], []),
  ] };
  const section = buildProjectSection(project, ctx({ projectTab: "changes", changesFor: () => ({ data }), selectedCommit: "bbbbbbb2",
    onOpenSession: (session: Json) => opened.push(String(session.id)), onOpenCommit: (repo: string, sha: string) => commits.push(`${repo}:${sha}`), onMoreChanges() {} }));
  const html = String(section);
  for (const word of ["main and 1 open branch", "change-tree", "change-lanes", "feat/tabs", "change-ref is-base", "タブを足す", "一覧を作る",
    "aaaaaaa", "merge", "+10 −3", "2 files", "No agent", "手で直す", "Load older commits", "session-chip claude", "change-row selected"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  assert.equal(section.querySelectorAll(".change-row").length, 4);
  assert.equal(section.querySelectorAll("circle").length, 4, "コミットごとに点を 1 つ描く");
  (section.querySelectorAll(".change-row")[1] as FakeElement).dispatch("click");
  assert.deepEqual(commits, ["agent-graph:aaaaaaa1"]);
  (section.querySelector(".session-chip") as FakeElement).dispatch("click", { stopPropagation() {} });
  assert.deepEqual(opened, ["s10"]);
  assert.ok(String(buildProjectSection(project, ctx({ projectTab: "changes", changesFor: () => ({ loading: true }) }))).includes("Loading git history"));
  assert.ok(String(buildProjectSection(project, ctx({ projectTab: "changes", changesFor: () => ({ error: "Could not read git history: x" }) }))).includes("Could not read git history"));
});

test("差分はファイルの一覧と行番号つきの行を出し、長いファイルと二進は閉じる", () => {
  const aside = doc.getElementById("detail")!;
  const long = Array.from({ length: 500 }, (_, i) => ({ kind: "add", new: i + 1, text: `line ${i}` }));
  const data = { sha: "abc", short: "abc1234", subject: "一覧を作る", body: "本文", author: "r", at: "2026-09-25T05:00:00.000Z", parents: ["p"], base: "p", truncated: false,
    files: [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, binary: false, truncated: false,
        hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [{ kind: "del", old: 1, text: "<b>old</b>" }, { kind: "add", new: 1, text: "new" }, { kind: "ctx", old: 2, new: 2, text: "keep" }] }] },
      { path: "big.txt", status: "added", additions: 500, deletions: 0, binary: false, truncated: true, hunks: [{ header: "@@ -0,0 +1,500 @@", lines: long }] },
      { path: "img.png", oldPath: "old.png", status: "renamed", additions: 0, deletions: 0, binary: true, truncated: false, hunks: [] },
    ] };
  renderDiff(aside, { data }, { sessions: [{ id: "s10", name: "agent-graph-001-s10", client: "claude" }], parents: ["p"] }, project, ctx({ onCloseCommit() {}, onExpandDetail() {}, onOpenSession() {} }));
  const html = String(aside);
  for (const word of ["一覧を作る", "abc1234", "本文", "3 files changed", "+501", "−1", "src/a.ts", "old.png → img.png", "@@ -1,2 +1,2 @@",
    "diff-line del", "diff-line add", "Binary file", "This file is too long", "Close diff", "agent-graph-001-s10"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  const blocks = aside.querySelectorAll(".diff-file");
  assert.deepEqual(blocks.map((block) => block.open), [true, false, false]);
  assert.equal(aside.querySelectorAll("b").length, 0, "差分の中の HTML を要素にしない");
  renderDiff(aside, { loading: true }, undefined, project, ctx({ onCloseCommit() {}, onExpandDetail() {} }));
  assert.ok(String(aside).includes("Loading diff"));
});

test("Agents は今と過去のセッションを並べ、選んだセッションの子を出し、検索で絞り込む", () => {
  const selected: string[] = [];
  const data = { branch: "main", hasMore: false, branches: [], commits: [{ sha: "a", short: "a", subject: "x", author: "r", at: "2026-09-25T05:00:00.000Z",
    files: 1, insertions: 1, deletions: 0, sessions: [{ id: "s9", name: "agent-graph-001-s9", client: "codex" }] }] };
  const section = buildProjectSection(project, ctx({ projectTab: "agents", selectedScope: "s10", changesFor: () => ({ data }),
    onSelect: (scope: Json, node: string | null) => selected.push(`${scope.id}:${node}`), onAgentQuery() {} }));
  const html = String(section);
  for (const word of ["agent-search", "agent-graph-001-s10", "agent-graph-001-s9", "Live", "1 commit", "agent-children", "旧版のダッシュボード"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  const rows = section.querySelectorAll(".agent-item");
  assert.ok(String(rows[0]).includes("agent-graph-001-s10"), "生きたセッションを先に並べる");
  (section.querySelector(".agent-child") as FakeElement).dispatch("click");
  assert.match(selected[0], /^s10:/);
  const search = section.querySelector(".agent-search") as FakeElement & { value: string };
  search.value = "段 6 の";
  search.dispatch("input");
  assert.equal(rows[0].hidden, true);
  assert.equal(rows[1].hidden, false);
});

test("root の詳細は会話の吹き出しと Show more と × を出し、隠した往復を除く", () => {
  const aside = doc.getElementById("detail")!;
  const scope = scopesOf(project)[0];
  renderDetail(aside, scope, null, ctx());
  const html = String(aside);
  for (const word of ["agent-graph-001-s10", "from-root", "from-agent", "Show more", "bubble-close", "Running…", "契約を固定して", "Archive", "Goal", "Session ID"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  renderDetail(aside, scope, null, ctx({ hiddenTurns: new Set([`${scope.id}::t1`]) }));
  assert.ok(!String(aside).includes("契約を固定して"));
});

test("子の詳細は属性と往復と Accept と Scope と Violations と Review と Output と割り当ての理由を出す", () => {
  const aside = doc.getElementById("detail")!;
  const scope = scopesOf(project)[0];
  renderDetail(aside, scope, "C0", ctx());
  let html = String(aside);
  for (const word of ["契約を固定する", "gpt-6-sol", "Assignment", "段 1: 契約の固定", "policy 2026-09-20.3", "policyVersion", "Round trips", "Tokens", "48k in", "Reviewer", "claude · Fable 5.1", "Accept: pass", "pnpm@10 typecheck", "verdict\">pass", "Scope", "packages/daemon/src/http/**", "Outputs", "Review: Approve", "契約は文書と一致している", "Output", "テスト 17 件が通過", "from-root", "from-agent"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  renderDetail(aside, scope, "F1", ctx());
  html = String(aside);
  for (const word of ["Accept: fail", "fail (exit=1)", "Violations", "packages/core/src/paths.ts", "Review: Changes", "Feedback", "テストが落ちた", "class=\"retry\"", "Retry"]) {
    assert.ok(html.includes(word), `${word} が無い`);
  }
  assert.ok(!html.includes("Approve"));
});

test("判断待ちの task は Approve, Retry, Reject を出し、Reject は確認してから送る", async () => {
  const aside = doc.getElementById("detail")!;
  const scope = scopesOf(project)[2];
  const sent: Json[] = [];
  let asked = 0;
  const c = ctx({ confirm: () => { asked += 1; return false; }, onAction: async (body: Json) => { sent.push(body); return "ok"; } });
  renderDetail(aside, scope, "P1", c);
  const buttons = aside.querySelectorAll(".actions")[0].children;
  assert.deepEqual(buttons.map((b) => b.textContent), ["Approve", "Retry", "Reject"]);
  buttons[2].dispatch("click");
  assert.equal(asked, 1);
  assert.equal(sent.length, 0);
  buttons[0].dispatch("click");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "approve");
  assert.equal(sent[0].graphId, "agent-graph-001-s10");
  assert.equal(sent[0].taskId, "P1");
});

test("吹き出しは Markdown の記号を外して見出しと太字とコードを要素で描き、HTML は文字のまま入れる", () => {
  const bubble = buildBubble({ role: "agent", text: "## 完了報告\n- **notes.md** を `test -f` で確認\n<b>x</b>" }, "done", "k", { expandedRounds: new Set() });
  const html = String(bubble);
  assert.ok(!html.includes("## "), "見出しの記号が残っている");
  assert.ok(!html.includes("**"), "太字の記号が残っている");
  assert.ok(html.includes("md-heading") && html.includes("<strong") && html.includes("<code"));
  assert.ok(html.includes("notes.md") && html.includes("test -f"));
  // 偽の DOM は文字列化で文字を逃がさないので、要素として作られていないことを検索で確かめる
  assert.equal(bubble.querySelectorAll("b").length, 0, "外からの HTML が要素になった");
  assert.ok(html.includes("<b>x</b>"), "外からの HTML が文字として残っていない");
});

test("モデルの切り替えは版つきの全モデルと、選んだモデルが受け付ける effort から選び、変わるときだけ送る", async () => {
  const sent: Json[] = [];
  const models = {
    claude: [{ id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "high", "max"] }, { id: "claude-opus-5", label: "Opus 5", efforts: ["low"] },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] }],
    codex: [{ id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "ultra"], defaultEffort: "medium" }],
  };
  const scope = { ...scopesOf(project)[0], client: "claude", status: "running", model: "claude-opus-5-5" };
  const aside = document.createElement("aside");
  renderDetail(aside, scope, null, ctx({ models, onAction: async (request: Json) => { sent.push(request); return "ok"; } }));
  const form = aside.querySelector(".model-form")! as unknown as FakeElement & { dispatch: (name: string, event?: unknown) => void };
  const [modelSelect, effortSelect] = form.querySelectorAll("select") as unknown as ({ value: string; disabled: boolean; dispatch: (name: string) => void; children: { value: string; textContent: string }[] })[];
  assert.deepEqual(modelSelect.children.map((option) => option.textContent), ["Opus 5.5 (current)", "Opus 5", "Haiku 4.5"]);
  assert.equal(modelSelect.value, "claude-opus-5-5");
  assert.deepEqual(effortSelect.children.map((option) => option.value), ["", "low", "high", "max"]);
  const submit = form.querySelector("button")! as unknown as { disabled: boolean };
  assert.equal(submit.disabled, true, "何も変えていないのに押せる");
  // 同じモデルでも effort を選べば送れる
  effortSelect.value = "max"; effortSelect.dispatch("change");
  assert.equal(submit.disabled, false);
  form.dispatch("submit", { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sent.map((request) => [request.model, request.effort]), [["claude-opus-5-5", "max"]]);
  // effort を持たないモデルに替えると effort の欄は使えない
  modelSelect.value = "claude-haiku-4-5-20251001"; modelSelect.dispatch("change");
  assert.equal(effortSelect.disabled, true);
  // Codex のセッションには Codex の一覧と既定の印を出す
  const codexAside = document.createElement("aside");
  renderDetail(codexAside, { ...scope, client: "codex", model: "gpt-6-astra" } as unknown as typeof scope, null, ctx({ models }));
  const codexSelects = codexAside.querySelectorAll("select") as unknown as { children: { textContent: string }[] }[];
  assert.deepEqual(codexSelects[0].children.map((option) => option.textContent), ["GPT-6-Astra (current)"]);
  assert.deepEqual(codexSelects[1].children.map((option) => option.textContent), ["Keep effort", "Low", "Medium (default)", "Ultra"]);
});
