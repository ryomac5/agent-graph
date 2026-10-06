// 右の詳細パネル。root は会話の吹き出し、子は属性と往復と Accept と Scope と Review と Output
import { fmtElapsed, fmtTokens, fmtWhen, modelLabel, statusClass, statusLabel, statusDescription } from "../lib/format.js";
import { actionsFor } from "../lib/status.js";
import { parseMarkdown } from "../lib/markdown.js";
import { button, el } from "./dom.js";

const KIND_LABEL = { root: "Root", task: "Task", delegation: "Delegation", subagent: "Subagent" };
const CLAMP_LINES = 6;
const CLAMP_CHARS = 320;
const isLong = (text) => text.split("\n").length > CLAMP_LINES || text.length > CLAMP_CHARS;

function addRow(dl, label, value, mono, hover) {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return;
  dl.append(el("dt", label));
  const dd = el("dd");
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  if (mono) dd.append(el("code", text)); else dd.textContent = text;
  if (hover) dd.title = hover;
  dl.append(dd);
}

// 吹き出しの本文を行ごとに描く。文字列はすべて textContent で入れ、HTML として解釈させない
function renderMarkdown(body, text) {
  const lines = parseMarkdown(text);
  lines.forEach((line, index) => {
    const row = el("span", undefined, `md-${line.type}`);
    if (line.type === "bullet") row.append(el("span", "・", "md-mark"));
    for (const span of line.spans) {
      row.append(el(span.type === "text" ? "span" : span.type === "strong" ? "strong" : "code", span.text));
    }
    body.append(row);
    if (index < lines.length - 1) body.append(el("span", "\n"));
  });
}

// 吹き出し 1 つ。root は右、子は左。全文を出しているかは ctx に持つ
export function buildBubble(round, tone, key, ctx) {
  const fromRoot = round.role === "root";
  const wrap = el("div", undefined, `bubble ${fromRoot ? "from-root" : "from-agent"}${fromRoot ? "" : ` ${tone}`}`);
  const text = String(round.text == null ? "" : round.text);
  const open = ctx.expandedRounds.has(key);
  const body = el("div", undefined, `bubble-text${open ? "" : " clamp"}`);
  renderMarkdown(body, text);
  wrap.append(body);
  if (isLong(text)) {
    const more = button(open ? "Less" : "More", "more", () => {
      const nowOpen = !ctx.expandedRounds.has(key);
      if (nowOpen) ctx.expandedRounds.add(key); else ctx.expandedRounds.delete(key);
      body.classList.toggle("clamp", !nowOpen);
      more.textContent = nowOpen ? "Less" : "More";
    });
    wrap.append(more);
  }
  const time = fmtWhen(round.at);
  if (time) {
    const stamp = el("time", time, "bubble-time");
    stamp.title = round.at;
    wrap.append(stamp);
  }
  return wrap;
}

// 会話は末尾に追従する。上を見ている間は再描画で位置を動かさない
function keepChatAtEnd(ctx, key, chat) {
  const view = ctx.chatView;
  if (view.key !== key) { view.key = key; view.top = 0; view.stick = true; }
  chat.addEventListener("scroll", () => {
    view.top = chat.scrollTop;
    view.stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 24;
  });
  const settle = () => { chat.scrollTop = view.stick ? chat.scrollHeight : view.top; };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(settle); else settle();
}

function buildHead(tone, ctx) {
  const head = el("details", undefined, `node-head ${tone}`);
  head.open = ctx.factsOpen.value;
  head.addEventListener("toggle", () => { ctx.factsOpen.value = head.open; });
  return head;
}

// Claude セッションへのメッセージ送信欄。Enter は改行、cmd+Enter か ctrl+Enter で送信。
function buildSayForm(scope, ctx) {
  const form = el("form", undefined, "say");
  const box = el("textarea");
  box.rows = 2;
  box.placeholder = "メッセージを入力…";
  box.setAttribute("aria-label", `${scope.name} へのメッセージ`);
  box.value = ctx.drafts?.get(scope.id) || "";
  box.addEventListener("input", () => ctx.drafts?.set(scope.id, box.value));
  const button = el("button", "送信 ↑", "say-send");
  button.type = "submit";
  box.title = "⌘ / Ctrl + Enter で送信";
  const note = el("p", "", "say-note");
  const submit = async () => {
    const text = box.value.trim();
    if (!text || button.disabled) return;
    button.disabled = true; note.textContent = "Sending…";
    const result = await ctx.onSay(scope.sessionId, text);
    note.textContent = result.message;
    if (result.ok) { box.value = ""; ctx.drafts?.delete(scope.id); }
    button.disabled = false;
  };
  form.addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
  box.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    if (!(ev.metaKey || ev.ctrlKey)) return;
    ev.preventDefault();
    submit();
  });
  form.append(box, button, note);
  return form;
}

// root。会話の吹き出しと 1 往復の非表示。End の確認
export function renderRootDetail(aside, scope, ctx) {
  const cls = statusClass(scope.status);
  const tone = `tone-${cls}`;
  const head = buildHead(tone, ctx);
  const summary = el("summary");
  summary.append(el("span", "", "dot"), el("span", scope.name, "node-name"));
  if (cls === "waiting") summary.append(el("span", scope.waitingReason ? `Waiting · ${scope.waitingReason}` : "Waiting", "node-state"));
  else if (cls === "ended") summary.append(el("span", statusLabel(scope.status), "node-state"));
  summary.append(el("span", scope.model || "モデル未取得", "node-model"));
  const more = el("span", "⋯", "facts-label");
  more.title = "セッション情報・操作";
  summary.append(more);
  head.append(summary);
  const dl = el("dl");
  addRow(dl, "Project", ctx.projectName);
  addRow(dl, "Client", scope.client);
  addRow(dl, "Model", modelLabel(scope.model));
  addRow(dl, "Started", fmtWhen(scope.startedAt, true), false, scope.startedAt);
  addRow(dl, "Ended", fmtWhen(scope.endedAt, true), false, scope.endedAt);
  addRow(dl, "Session ID", scope.sessionId, true);
  addRow(dl, "Goal", scope.goal);
  head.append(dl);
  if (cls !== "ended") {
    const row = el("p", undefined, "end-row");
    row.append(button("履歴へ移す", undefined, () => {
      if (ctx.confirm(`${scope.name} を履歴へ移します。プロセスは停止しません。`)) ctx.onAction({ action: "end_session", sessionId: scope.sessionId });
    }));
    if (scope.client === "claude") row.append(button("停止", undefined, () => {
      if (ctx.confirm(`${scope.name} を停止しますか？`)) ctx.onAction({ action: "stop_session", sessionId: scope.sessionId });
    }));
    head.append(row);
  }
  const chat = el("div", undefined, "chat");
  if (ctx.onLoadHistory && !ctx.historyEnd?.has(scope.id)) chat.append(button("以前の会話を読み込む", "toolbar-button", async (event) => {
    const control = event.currentTarget;
    control.disabled = true;
    await ctx.onLoadHistory(scope);
    control.disabled = false;
  }));
  const turns = (scope.turns || []).filter((t) => !t.hidden && !ctx.hiddenTurns.has(`${scope.id}::${t.id}`));
  if (!turns.length) chat.append(el("p", "会話はまだありません。メッセージが記録されると、ここに表示されます。", "chat-empty"));
  for (const t of turns) {
    const asked = buildBubble({ role: "root", text: t.prompt || "", at: t.at }, tone, `${scope.id}/${t.id}/prompt`, ctx);
    asked.classList.add("has-close");
    const close = button("×", "bubble-close", (ev) => { ev.preventDefault(); ev.stopPropagation(); ctx.onHideTurn(scope, t.id); });
    close.title = "Hide";
    close.setAttribute("aria-label", "Hide");
    asked.append(close);
    chat.append(asked);
    chat.append(buildBubble({ role: "agent", text: t.reply || t.summary || "Running…", at: t.at }, tone, `${scope.id}/${t.id}/reply`, ctx));
  }
  const parts = [head, chat];
  const description = statusDescription(scope.status);
  if (description) parts.splice(1, 0, el("p", description, "status-note"));
  if (scope.client && ["claude", "codex"].includes(scope.client) && cls !== "ended") parts.push(buildSayForm(scope, ctx));
  if ((scope.client === "claude" || scope.client === "codex") && cls !== "ended") head.append(buildModelForm(scope, ctx));
  aside.replaceChildren(...parts);
  keepChatAtEnd(ctx, `${scope.id}/root`, chat);
}

// 会話の素材。rounds が無いノードは task と output から組む
function roundsOf(node) {
  if (Array.isArray(node.rounds) && node.rounds.length) {
    return node.rounds.map((r) => ({ role: r.kind === "report" ? "agent" : "root", text: r.text, at: r.at }));
  }
  const built = [];
  if (node.task) built.push({ role: "root", text: node.task, at: node.startedAt });
  if (node.output) built.push({ role: "agent", text: node.output, at: node.endedAt || node.startedAt });
  return built;
}

function listSection(title, items, itemClass) {
  const ul = el("ul");
  for (const item of items) ul.append(el("li", item, itemClass));
  return [el("h3", title), ul];
}

// 子。属性、往復、判断待ちの操作、Feedback、Accept、Scope、Violations、Review、Output
export function renderNodeDetail(aside, scope, node, ctx) {
  const cls = statusClass(node.status);
  const tone = `tone-${cls}`;
  const head = buildHead(tone, ctx);
  const summary = el("summary");
  summary.append(el("span", "", "dot"), el("span", node.title || node.id, "node-name"));
  const model = node.model || "モデル未取得";
  if (model) summary.append(el("span", model, "node-model"));
  head.append(summary);
  const dl = el("dl");
  addRow(dl, "Kind", KIND_LABEL[node.kind] || node.kind);
  addRow(dl, "Status", statusLabel(node.status));
  addRow(dl, "Role", node.role);
  addRow(dl, "Executor", node.executor);
  addRow(dl, "Model", node.model, true);
  addRow(dl, "Parent", node.parentId || (scope.edges || []).filter((e) => e.to === node.id && e.kind !== "return").map((e) => e.from));
  addRow(dl, "Depends on", node.dependsOn);
  addRow(dl, "Attempts", node.attempts);
  addRow(dl, "Round trips", node.roundTrips);
  addRow(dl, "Tokens", fmtTokens(node.tokens));
  addRow(dl, "Reviewer", node.review && node.review.reviewer ? `${node.review.reviewer.executor} · ${modelLabel(node.review.reviewer.model)}` : "");
  addRow(dl, "Started", fmtWhen(node.startedAt, true), false, node.startedAt);
  addRow(dl, "Ended", fmtWhen(node.endedAt, true), false, node.endedAt);
  addRow(dl, "branch", node.branch, true);
  addRow(dl, "worktree", node.worktree, true);
  addRow(dl, "PR", node.prUrl, true);
  addRow(dl, "id", node.id, true);
  head.append(dl);
  const parts = [head];
  const description = statusDescription(node.status);
  if (description) parts.push(el("p", description, "status-note"));

  if (node.assignment && (node.assignment.reason || []).length) {
    const ul = el("ul");
    for (const reason of node.assignment.reason) ul.append(el("li", reason, "reason"));
    const policy = el("li", `policy ${node.assignment.policyVersion || "?"}`, "reason");
    policy.append(el("small", "policyVersion"));
    ul.append(policy);
    parts.push(el("h3", "Assignment"), ul);
  }

  const chat = el("div", undefined, "chat");
  const rounds = roundsOf(node);
  if (!rounds.length) chat.append(el("p", "No messages", "chat-empty"));
  rounds.forEach((round, i) => chat.append(buildBubble(round, tone, `${scope.id}/${node.id}/${i}`, ctx)));
  parts.push(chat);

  const actions = actionsFor(node);
  if (actions.length) {
    const bar = el("div", "", "actions");
    const result = el("p", "", "");
    result.id = "action-result";
    for (const [action, label] of actions) {
      bar.append(button(label, action, async () => {
        // reject は取り消せない。誤クリックで走らないよう確認を挟む
        if (action === "reject" && !ctx.confirm(`${node.id} を却下します。取り消せません。`)) return;
        for (const b of bar.children) b.disabled = true;
        // 契約の ActionRequest の項目だけ。2 つ目の引数は画面の隠し設定を外す鍵
        const message = await ctx.onAction(node.kind === "task"
          ? { action, graphId: scope.graphId, taskId: node.id, sessionId: scope.sessionId }
          : { action: "rerun_delegation", delegationId: node.id, sessionId: scope.sessionId }, node.id);
        result.textContent = message || "";
        for (const b of bar.children) b.disabled = false;
      }));
    }
    parts.push(bar, result);
  }
  if (node.feedback) parts.push(el("h3", "Feedback"), el("pre", node.feedback));
  const acceptance = node.acceptance;
  if (acceptance && (acceptance.results || []).length) {
    parts.push(el("h3", `Accept: ${acceptance.passed ? "pass" : "fail"}`));
    const ul = el("ul");
    for (const r of acceptance.results) {
      const ok = r.exitCode === 0;
      const li = el("li", "", ok ? "pass" : "fail");
      li.append(el("code", r.command), el("span", ok ? "pass" : `fail (exit=${r.exitCode})`, "verdict"));
      if (!ok && r.output) { const d = el("details"); d.append(el("summary", "Output"), el("pre", r.output)); li.append(d); }
      ul.append(li);
    }
    parts.push(ul);
  }
  if ((node.scope || []).length) parts.push(...listSection("Scope", node.scope));
  if (acceptance && (acceptance.scopeViolations || []).length) parts.push(...listSection("Violations", acceptance.scopeViolations, "fail"));
  if ((node.outputs || []).length) parts.push(...listSection("Outputs", node.outputs));
  if (node.review && node.review.verdict) {
    parts.push(el("h3", `Review: ${node.review.verdict === "approve" ? "Approve" : "Changes"}`));
    if (node.review.comment) { const d = el("details"); d.append(el("summary", "Review"), el("pre", node.review.comment)); parts.push(d); }
  }
  if (node.output) { const d = el("details"); d.append(el("summary", "Text"), el("pre", node.output)); parts.push(el("h3", "Output"), d); }
  const technical = parts.filter((part) => part !== head && part !== chat && !part.classList.contains("status-note") && !part.classList.contains("actions") && part.id !== "action-result");
  const info = el("details", undefined, "execution-info");
  info.append(el("summary", "検証・実行情報"), ...technical);
  aside.replaceChildren(head, ...parts.filter((part) => part.classList.contains("status-note")), chat,
    ...parts.filter((part) => part.classList.contains("actions") || part.id === "action-result"), ...(technical.length ? [info] : []));

  keepChatAtEnd(ctx, `${scope.id}/${node.id}`, chat);
}

export function renderDetail(aside, scope, nodeId, ctx) {
  if (!scope) { aside.replaceChildren(el("p", "No sessions", "empty")); return; }
  const node = (scope.nodes || []).find((n) => n.id === nodeId);
  if (!node || node.kind === "root") {
    if (scope.kind === "planner") renderPlannerDetail(aside, scope, ctx); else renderRootDetail(aside, scope, ctx);
    addDetailToolbar(aside, ctx);
    return;
  }
  renderNodeDetail(aside, scope, node, ctx);
  addDetailToolbar(aside, ctx);
}

function addDetailToolbar(aside, ctx) {
  if (!ctx.onExpandDetail) return;
  const bar = el("div", undefined, "detail-toolbar");
  if (ctx.onBackToSessions) bar.append(button("‹ グラフ", "toolbar-button mobile-back", ctx.onBackToSessions));
  if (ctx.selectedNode) {
    const back = button("‹", "toolbar-button", () => ctx.onSelect({ id: ctx.selectedScope }, null));
    back.setAttribute("aria-label", "‹ セッションの会話");
    back.title = "セッションの会話へ戻る";
    bar.append(back);
  }
  const latest = button("↓", "toolbar-button", () => {
    const chat = aside.querySelector(".chat");
    if (chat) { chat.scrollTop = chat.scrollHeight; ctx.chatView.stick = true; }
  });
  latest.setAttribute("aria-label", "最新の会話へ");
  latest.title = "最新の会話へ";
  bar.append(latest);
  const expanded = globalThis.document.body.classList.contains("detail-expanded");
  const expand = button(expanded ? "↙" : "↗", "toolbar-button", ctx.onExpandDetail);
  expand.setAttribute("aria-label", expanded ? "縮小 ↙" : "拡大 ↗");
  expand.title = expanded ? "会話を縮小" : "会話を拡大";
  expand.setAttribute("aria-pressed", String(expanded));
  bar.append(expand);
  aside.insertBefore(bar, aside.firstChild);
}

// effort の表示名
const EFFORT_LABEL = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

// モデルと effort の切り替え。変更できる全モデルを版つきで選び、選んだモデルが受け付ける effort を選ぶ。
// いまと違うモデルか、effort を選んだときだけ送れる
function buildModelForm(scope, ctx) {
  const form = el("form", undefined, "model-form");
  const choices = (ctx.models && ctx.models[scope.client]) || [];
  const modelSelect = el("select", undefined, "model-select");
  modelSelect.setAttribute("aria-label", "モデル");
  const current = choices.find((choice) => choice.id === scope.model) ? scope.model : "";
  // 観測したモデルが一覧に無ければ、いまのモデルとして先頭に出す
  if (!current) {
    const unknown = el("option", scope.model ? `${modelLabel(scope.model)} (現在)` : "モデル不明");
    unknown.value = "";
    modelSelect.append(unknown);
  }
  for (const choice of choices) {
    const option = el("option", choice.id === current ? `${choice.label} (現在)` : choice.label);
    option.value = choice.id;
    if (choice.id === current) option.selected = true;
    modelSelect.append(option);
  }
  modelSelect.value = current;
  const effortSelect = el("select", undefined, "effort-select");
  effortSelect.setAttribute("aria-label", "effort");
  const submit = el("button", "変更", "toolbar-button");
  submit.type = "submit";
  const fillEfforts = () => {
    const choice = choices.find((item) => item.id === (modelSelect.value || current));
    const keep = el("option", "effort はそのまま");
    keep.value = "";
    effortSelect.replaceChildren(keep);
    for (const effort of (choice && choice.efforts) || []) {
      const option = el("option", choice.defaultEffort === effort ? `${EFFORT_LABEL[effort] || effort} (既定)` : EFFORT_LABEL[effort] || effort);
      option.value = effort;
      effortSelect.append(option);
    }
    effortSelect.value = "";
    effortSelect.disabled = !choice || !choice.efforts.length;
  };
  const sync = () => {
    const model = modelSelect.value || current;
    submit.disabled = !model || (model === current && !effortSelect.value);
  };
  modelSelect.addEventListener("change", () => { fillEfforts(); sync(); });
  effortSelect.addEventListener("change", sync);
  fillEfforts();
  sync();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const model = modelSelect.value || current;
    if (!model || (model === current && !effortSelect.value)) return;
    submit.disabled = true;
    await ctx.onAction({ action: "set_model", sessionId: scope.sessionId, model, ...(effortSelect.value ? { effort: effortSelect.value } : {}) });
    sync();
  });
  form.append(modelSelect, effortSelect, submit);
  return form;
}

// planner のグラフを選んだとき。goal とタスクの状態の一覧
function renderPlannerDetail(aside, scope, ctx) {
  const tone = `tone-${statusClass(scope.status)}`;
  const head = buildHead(tone, ctx);
  head.open = true;
  const summary = el("summary");
  summary.append(el("span", "", "dot"), el("span", `Graph ${scope.name}`, "node-name"), el("span", statusLabel(scope.status), "node-state"));
  head.append(summary);
  const dl = el("dl");
  addRow(dl, "Session", scope.sessionName || scope.sessionId);
  addRow(dl, "Goal", scope.goal);
  addRow(dl, "Tasks", scope.nodes.length);
  head.append(dl);
  const ul = el("ul");
  for (const n of scope.nodes) {
    const li = el("li", "", statusClass(n.status) === "done" ? "pass" : statusClass(n.status) === "failed" ? "fail" : "");
    li.append(el("code", n.id), el("span", `${n.title || ""} · ${statusLabel(n.status)}`, "verdict"));
    ul.append(li);
  }
  aside.replaceChildren(head, el("h3", "Tasks"), ul);
}
