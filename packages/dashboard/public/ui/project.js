// Project ページ。セッションごとの枠と goal と Started、planner のグラフの枠、終了セッションの畳み
import { fmtWhen, statusClass, statusLabel } from "../lib/format.js";
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
  const h3 = el("h3");
  h3.append(el("span", "", "dot"), el("span", scope.kind === "planner" ? `Graph ${scope.name}` : scope.name));
  if (scope.kind === "planner" && scope.sessionName) h3.append(el("small", `of ${scope.sessionName}`));
  if (scope.startedAt) {
    const when = el("small", `Started ${fmtWhen(scope.startedAt)}`);
    when.title = scope.startedAt;
    h3.append(when);
  }
  if (scope.kind === "session" && cls !== "ended") {
    // 取り消せない操作なのでここだけ確認する
    h3.append(button("End", undefined, () => {
      if (ctx.confirm(`End ${scope.name}?`)) ctx.onAction({ action: "end_session", sessionId: scope.sessionId });
    }));
  } else if (cls === "ended") {
    h3.append(el("small", statusLabel(scope.status)));
  }
  group.append(h3);
  if (scope.goal) group.append(el("p", scope.goal, "goal"));
  group.append(renderGraph(scope, ctx));
  return group;
}

// view は契約の ProjectView。終了したセッションは畳んで、生きているものだけを常に見せる。
// failure は /api/project の取得に失敗した理由。あれば Unavailable を出す
export function buildProjectSection(view, ctx, failure = "") {
  const section = el("section", undefined, "project");
  section.setAttribute("data-project", view.project.key);
  const heading = el("div", undefined, "project-heading");
  heading.append(el("h2", view.project.name), el("span", view.project.rootPath, "project-path"));
  section.append(heading);
  if (failure) section.append(el("p", `Unavailable: ${failure}`, "hint"));
  const sessions = view.sessions || [];
  const graphs = view.graphs || [];
  const endedBox = el("details", undefined, "ended-sessions");
  const ended = sessions.filter((s) => !isLive(s));
  endedBox.append(el("summary", `Ended sessions (${ended.length})`));
  for (const session of sessions) {
    const scope = sessionScope(session);
    (isLive(session) ? section : endedBox).append(buildGroup(scope, ctx));
    // planner のグラフはそのセッションの枠の直後に並べる
    for (const graph of graphs.filter((g) => g.sessionId === session.id)) {
      (isLive(session) ? section : endedBox).append(buildGroup(graphScope(graph, sessions), ctx));
    }
  }
  for (const graph of graphs.filter((g) => !sessions.some((s) => s.id === g.sessionId))) section.append(buildGroup(graphScope(graph, sessions), ctx));
  if (!sessions.length && !graphs.length) section.append(el("p", "No sessions yet", "empty"));
  if (ended.length) section.append(endedBox);
  return section;
}

// 詳細パネルが引く scope の一覧。表示順と同じ
export function scopesOf(view) {
  const sessions = (view && view.sessions) || [];
  const graphs = (view && view.graphs) || [];
  return [...sessions.map(sessionScope), ...graphs.map((g) => graphScope(g, sessions))];
}
