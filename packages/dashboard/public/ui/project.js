// Project ページ。セッションごとの枠と goal と Started、planner のグラフの枠、終了セッションの畳み
import { statusClass, statusLabel } from "../lib/format.js";
import { isLive } from "../lib/status.js";
import { button, el } from "./dom.js";
import { renderGraph } from "./graph.js";

// SessionView と GraphView を、グラフの描画が読む共通の scope にする
export function sessionScope(session) {
  return { id: session.id, kind: "session", name: session.name, status: session.status, goal: session.goal,
    startedAt: session.startedAt, endedAt: session.endedAt, turns: session.turns || [], nodes: session.nodes || [], edges: session.edges || [],
    sessionId: session.id, waitingReason: session.waitingReason, client: session.client, model: session.model };
}

export function graphScope(graph, sessions = []) {
  const nodes = graph.nodes || [];
  const running = nodes.some((n) => statusClass(n.status) === "running");
  const waiting = nodes.some((n) => statusClass(n.status) === "waiting");
  const failed = nodes.some((n) => statusClass(n.status) === "failed");
  const finished = nodes.length > 0 && nodes.every((n) => ["done", "ended"].includes(statusClass(n.status)));
  const status = waiting ? "waiting_human" : running ? "running" : failed ? "failed" : finished ? "done" : "planned";
  const session = sessions.find((s) => s.id === graph.sessionId);
  return { id: `graph:${graph.id}`, kind: "planner", name: graph.id, status, goal: graph.goal, turns: [],
    nodes, edges: graph.edges || [], graphId: graph.id, sessionId: graph.sessionId, sessionName: session ? session.name : "" };
}

function buildGroup(scope, ctx) {
  const cls = statusClass(scope.status);
  const group = el("section", undefined, `session-group ${cls}${scope.kind === "planner" ? " planner" : ""}${cls === "ended" ? " ended" : ""}`);
  group.setAttribute("data-scope", scope.id);
  if (scope.kind === "planner") {
    const title = el("h4", "実行計画", "graph-title");
    title.title = scope.goal || scope.name;
    group.append(title);
  }
  group.append(renderGraph(scope, ctx));
  const roster = el("div", undefined, "node-roster");
  for (const node of scope.nodes.filter((n) => n.kind !== "root")) {
    const control = button(node.title || node.id, `toolbar-button ${node.id === ctx.selectedNode ? "selected" : ""}`, () => ctx.onSelect(scope, node.id));
    control.append(el("small", `${node.model || "モデル未取得"} · ${statusLabel(node.status)}`));
    roster.append(control);
  }
  if (roster.children.length) {
    const list = el("details", undefined, "agent-list");
    list.append(el("summary", `エージェント一覧 · ${roster.children.length}`), roster);
    group.append(list);
  }
  return group;
}

// view は契約の ProjectView。終了したセッションは畳んで、生きているものだけを常に見せる。
// failure は /api/project の取得に失敗した理由。あれば Unavailable を出す
export function buildProjectSection(view, ctx, failure = "") {
  const section = el("section", undefined, "project");
  section.setAttribute("data-project", view.project.key);
  const heading = el("div", undefined, "project-heading");
  section.setAttribute("aria-label", view.project.name);
  const controls = el("div", undefined, "project-actions");
  if (ctx.onNewSession) {
    const menu = el("details", undefined, "new-session-menu");
    const summary = el("summary", "＋");
    summary.setAttribute("aria-label", "新規セッション");
    summary.title = "新規セッション";
    menu.append(summary);
    const choices = el("div", undefined, "new-session-choices");
    for (const client of ["claude", "codex"]) choices.append(button(client === "claude" ? "Claude" : "Codex", "toolbar-button", () => { menu.open = false; ctx.onNewSession(view.project.key, client); }));
    menu.append(choices);
    controls.append(menu);
  }
  section.append(heading);
  if (failure) section.append(el("p", `Unavailable: ${failure}`, "hint"));
  const sessions = view.sessions || [];
  const graphs = view.graphs || [];
  const selectedId = graphs.find((g) => `graph:${g.id}` === ctx.selectedScope)?.sessionId || ctx.selectedScope;
  const picker = el("nav", undefined, "session-picker");
  picker.setAttribute("aria-label", "セッション");

  const addSession = (session, target) => {
    const scope = sessionScope(session);
    const control = button(undefined, session.id === selectedId ? "selected" : "", () => ctx.onSelect(scope, null));
    control.setAttribute("aria-pressed", String(session.id === selectedId));
    control.title = `${session.name} · ${session.model || "モデル未取得"} · ${statusLabel(session.status)}`;
    control.setAttribute("aria-label", `${session.name} · ${statusLabel(session.status)}`);
    control.append(el("span", "", `session-state on-${statusClass(session.status)}`), el("strong", session.name));
    target.append(control);
  };
  for (const session of sessions.filter(isLive)) addSession(session, picker);
  heading.append(picker, controls);
  let archiveBox;
  const ended = sessions.filter((s) => !isLive(s));
  if (ended.length) {
    const archive = el("details", undefined, "ended-sessions");
    archive.open = ended.some((s) => s.id === ctx.selectedScope);
    archive.append(el("summary", `履歴 · ${ended.length}`));
    // 履歴は高さを閉じ込めず、キャンバスごとスクロールして下まで見られるようにする
    const list = el("nav", undefined, "session-picker session-history");
    for (const session of ended) addSession(session, list);
    archive.append(list);
    archiveBox = archive;
  }
  const selected = sessions.find((s) => s.id === selectedId) || sessions.find(isLive) || sessions[0];
  if (selected) {
    if (ctx.onOpenConversation) controls.append(button("会話を開く", "toolbar-button open-conversation", () => ctx.onOpenConversation(sessionScope(selected))));
    section.append(buildGroup(sessionScope(selected), ctx));
    for (const graph of graphs.filter((g) => g.sessionId === selected.id)) section.append(buildGroup(graphScope(graph, sessions), ctx));
  }
  for (const graph of graphs.filter((g) => !sessions.some((s) => s.id === g.sessionId))) section.append(buildGroup(graphScope(graph, sessions), ctx));
  if (!sessions.length && !graphs.length) section.append(el("p", "セッションがありません。＋ から開始できます。", "empty"));
  if (archiveBox) section.append(archiveBox);
  return section;
}

// 詳細パネルが引く scope の一覧。表示順と同じ
export function scopesOf(view) {
  const sessions = (view && view.sessions) || [];
  const graphs = (view && view.graphs) || [];
  return [...sessions.map(sessionScope), ...graphs.map((g) => graphScope(g, sessions))];
}
