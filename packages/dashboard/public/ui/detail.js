// 右の詳細パネル。root は会話の吹き出し、子は属性と往復と Accept と Scope と Review と Output
import { fmtElapsed, fmtTokens, fmtWhen, modelLabel, statusClass, statusLabel } from "../lib/format.js";
import { actionsFor } from "../lib/status.js";
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

// 吹き出し 1 つ。root は右、子は左。全文を出しているかは ctx に持つ
export function buildBubble(round, tone, key, ctx) {
  const fromRoot = round.role === "root";
  const wrap = el("div", undefined, `bubble ${fromRoot ? "from-root" : "from-agent"}${fromRoot ? "" : ` ${tone}`}`);
  const text = String(round.text == null ? "" : round.text);
  const open = ctx.expandedRounds.has(key);
  const body = el("div", text, `bubble-text${open ? "" : " clamp"}`);
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

// root。会話の吹き出しと 1 往復の非表示。End の確認
export function renderRootDetail(aside, scope, ctx) {
  const cls = statusClass(scope.status);
  const tone = `tone-${cls}`;
  const head = buildHead(tone, ctx);
  const summary = el("summary");
  summary.append(el("span", "", "dot"), el("span", scope.name, "node-name"));
  if (cls === "waiting") summary.append(el("span", scope.waitingReason ? `Waiting · ${scope.waitingReason}` : "Waiting", "node-state"));
  else if (cls === "ended") summary.append(el("span", statusLabel(scope.status), "node-state"));
  summary.append(el("span", fmtElapsed(scope.startedAt, scope.endedAt), "node-elapsed"));
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
    row.append(button("End", undefined, () => {
      if (ctx.confirm(`End ${scope.name}?`)) ctx.onAction({ action: "end_session", sessionId: scope.sessionId });
    }));
    head.append(row);
  }
  const chat = el("div", undefined, "chat");
  const turns = (scope.turns || []).filter((t) => !t.hidden && !ctx.hiddenTurns.has(`${scope.id}::${t.id}`));
  if (!turns.length) chat.append(el("p", "No messages", "chat-empty"));
  for (const t of turns) {
    const asked = buildBubble({ role: "root", text: t.prompt || "", at: t.at }, tone, `${scope.id}/${t.id}/prompt`, ctx);
    asked.classList.add("has-close");
    const close = button("×", "bubble-close", (ev) => { ev.preventDefault(); ev.stopPropagation(); ctx.onHideTurn(scope, t.id); });
    close.title = "Hide";
    close.setAttribute("aria-label", "Hide");
    asked.append(close);
    chat.append(asked);
    chat.append(buildBubble({ role: "agent", text: t.summary || "Running…", at: t.at }, tone, `${scope.id}/${t.id}/reply`, ctx));
  }
  aside.replaceChildren(head, chat);
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
  const model = modelLabel(node.model);
  if (model) summary.append(el("span", model, "node-model"));
  summary.append(el("span", fmtElapsed(node.startedAt, node.endedAt), "node-elapsed"));
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
        const message = await ctx.onAction({ action, graphId: scope.graphId, taskId: node.id, sessionId: scope.sessionId, nodeId: node.id });
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
  aside.replaceChildren(...parts);
  keepChatAtEnd(ctx, `${scope.id}/${node.id}`, chat);
}

export function renderDetail(aside, scope, nodeId, ctx) {
  if (!scope) { aside.replaceChildren(el("p", "No sessions", "empty")); return; }
  const node = (scope.nodes || []).find((n) => n.id === nodeId);
  if (!node || node.kind === "root") {
    if (scope.kind === "planner") renderPlannerDetail(aside, scope, ctx); else renderRootDetail(aside, scope, ctx);
    return;
  }
  renderNodeDetail(aside, scope, node, ctx);
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
