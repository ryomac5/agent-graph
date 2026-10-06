// Agents タブ。過去と今のセッションを新しい順に並べ、何を頼んで何を委譲したかを見せる。
// 行を押すと右に会話を開き、その下に子のエージェントを並べる。子を押すと子とのやり取りを開く
import { fmtAgo, fmtWhen, modelLabel, statusClass, statusLabel } from "../lib/format.js";
import { isLive } from "../lib/status.js";
import { button, el } from "./dom.js";

const CLIENT_LABEL = { claude: "Claude", codex: "Codex", planner: "Planner" };
// 一覧の会話は daemon が直近 50 往復だけ送る。それ以上は「50+」と出す
const TURN_PAGE = 50;

function lastAt(session) {
  const turns = session.turns || [];
  return [turns.length ? turns[turns.length - 1].at : "", session.endedAt || "", session.startedAt || ""].filter(Boolean).sort().pop() || "";
}

// 人が書いた最後の指示。タグで包まれたコマンドや通知は飛ばす
function lastPrompt(session) {
  const turns = (session.turns || []).filter((turn) => !turn.hidden && turn.prompt && !/^\s*</.test(turn.prompt));
  return turns.length ? turns[turns.length - 1].prompt : "";
}

const oneLine = (text) => String(text || "").replace(/\s+/g, " ").trim();

function matches(session, query) {
  if (!query) return true;
  const haystack = [session.name, session.client, session.model, modelLabel(session.model), session.goal, lastPrompt(session),
    ...(session.nodes || []).map((node) => node.title)].join("\n").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function childRow(scope, node, ctx) {
  const row = button(undefined, `agent-child on-${statusClass(node.status)}${ctx.selectedNode === node.id ? " selected" : ""}`, () => ctx.onSelect(scope, node.id));
  row.append(el("span", "", "agent-dot"), el("span", node.title || node.id, "agent-child-title"));
  const who = [node.executor === "codex" ? "Codex" : node.executor === "claude" ? "Claude" : node.executor, modelLabel(node.model)].filter(Boolean).join(" · ");
  row.append(el("span", who, "agent-child-model"), el("span", statusLabel(node.status), "agent-child-state"));
  return row;
}

// commits は session id → そのセッションが作ったコミットの数。Changes を読んでいなければ空
export function buildAgents(view, ctx, sessionScope, commits = new Map()) {
  const box = el("div", undefined, "agents");
  const search = el("input", undefined, "agent-search");
  search.type = "search";
  search.placeholder = "Search sessions, prompts, agents…";
  search.setAttribute("aria-label", "Search sessions");
  search.value = ctx.agentQuery || "";
  box.append(search);
  const list = el("div", undefined, "agent-list-rows");
  box.append(list);
  const sessions = [...(view.sessions || [])].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || lastAt(b).localeCompare(lastAt(a)));
  const rows = [];
  for (const session of sessions) {
    const scope = sessionScope(session);
    const selected = ctx.selectedScope === session.id;
    const item = el("div", undefined, `agent-item${selected ? " selected" : ""}`);
    const row = button(undefined, `agent-row on-${statusClass(session.status)}`, () => ctx.onSelect(scope, null));
    row.setAttribute("aria-pressed", String(selected));
    const line = el("div", undefined, "agent-line");
    line.append(el("span", "", "agent-dot"));
    if (session.client) line.append(el("span", CLIENT_LABEL[session.client] || session.client, `client-badge ${session.client}`));
    line.append(el("strong", session.name, "agent-name"));
    if (session.model) line.append(el("span", modelLabel(session.model), "agent-model"));
    const when = isLive(session) ? `Live · ${fmtAgo(lastAt(session))}` : `${fmtWhen(session.startedAt)} → ${fmtWhen(session.endedAt || lastAt(session))}`;
    line.append(el("span", when, "agent-when"));
    row.append(line);
    const goal = oneLine(session.goal);
    if (goal) row.append(el("div", goal, "agent-goal"));
    const latest = oneLine(lastPrompt(session));
    if (latest && latest !== goal) row.append(el("div", `Last: ${latest}`, "agent-last"));
    const children = (session.nodes || []).filter((node) => node.kind !== "root");
    const turns = (session.turns || []).length;
    const meta = [`${turns}${turns >= TURN_PAGE ? "+" : ""} ${turns === 1 ? "turn" : "turns"}`];
    if (children.length) meta.push(`${children.length} ${children.length === 1 ? "agent" : "agents"}`);
    const made = (session.memberIds || [session.id]).reduce((sum, id) => sum + (commits.get(id) || 0), 0);
    if (made) meta.push(`${made} ${made === 1 ? "commit" : "commits"}`);
    meta.push(statusLabel(session.status));
    row.append(el("div", meta.join(" · "), "agent-meta"));
    item.append(row);
    if (selected && children.length) {
      const nested = el("div", undefined, "agent-children");
      for (const node of children) nested.append(childRow(scope, node, ctx));
      item.append(nested);
    }
    rows.push([item, session]);
    list.append(item);
  }
  const empty = el("p", "No sessions match.", "empty");
  empty.hidden = true;
  box.append(empty);
  // 打つたびに描き直すと入力欄が作り直されるので、行の表示だけを切り替える
  const apply = () => {
    ctx.onAgentQuery(search.value);
    let shown = 0;
    for (const [item, session] of rows) { item.hidden = !matches(session, search.value); if (!item.hidden) shown++; }
    empty.hidden = shown > 0;
  };
  search.addEventListener("input", apply);
  for (const [item, session] of rows) item.hidden = !matches(session, search.value);
  empty.hidden = !sessions.length || rows.some(([item]) => !item.hidden);
  if (!sessions.length) box.append(el("p", "No sessions yet.", "empty"));
  return box;
}
