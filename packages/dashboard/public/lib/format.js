// 文字の整形。契約の Status とモデル id を、画面に出す言葉へ直す。DOM に触れない。

// 契約の Status を画面の 6 種に落とす。旧版に無かった lost, timeout, denied, stalled も引く
export const STATUS_CLASS = {
  planned: "planned", running: "running", verifying: "running", reviewing: "running", merging: "running",
  waiting: "waiting", waiting_human: "waiting", conflict: "waiting", unverified: "waiting",
  done: "done", idle: "done",
  failed: "failed", rejected: "failed", timeout: "failed", denied: "failed", stalled: "failed",
  lost: "ended", ended: "ended",
};

export const STATUS_LABEL = {
  planned: "Planned", running: "Running", verifying: "Verifying", reviewing: "Reviewing", merging: "Merging",
  waiting: "Waiting", waiting_human: "Waiting", conflict: "Conflict", unverified: "Unverified",
  done: "Done", idle: "Done", failed: "Failed", rejected: "Rejected", timeout: "Timeout", denied: "Denied",
  stalled: "Stalled", lost: "Lost", ended: "Ended",
};

export function statusClass(status) { return STATUS_CLASS[status] || "planned"; }
export function statusLabel(status) { return STATUS_LABEL[status] || String(status || ""); }

// 系統。契約の family と executor から引く。分からなければ空
export function familyOf(node) {
  if (!node) return "";
  if (node.family === "anthropic" || node.family === "openai") return node.family;
  const executor = String(node.executor || "");
  if (executor === "codex") return "openai";
  if (["claude", "doc-light", "doc-heavy", "Explore", "Plan", "general-purpose", "reviewer"].includes(executor)) return "anthropic";
  if (node.client === "claude") return "anthropic";
  if (node.client === "codex") return "openai";
  return "";
}

// 丸の 1 行目。系統だけを出す。human と pr は Task のまま
const FAMILY_TITLE = { anthropic: "Claude", openai: "Codex" };
export function kindTitle(node) {
  if (!node) return "Task";
  if (node.kind === "root") return FAMILY_TITLE[familyOf(node)] || "Claude";
  return FAMILY_TITLE[familyOf(node)] || "Task";
}

// 丸の 3 行目。役割を 1 語で出す
// 契約の role（implement, research, document, review, orchestrate）と旧版の executor 名の両方を引く
const ROLE_LABEL = {
  implement: "Coding", coding: "Coding",
  reviewer: "Review", review: "Review",
  "doc-light": "Docs", "doc-heavy": "Docs", docs: "Docs", document: "Docs",
  Explore: "Research", Plan: "Research", "claude-code-guide": "Research", research: "Research",
  human: "Gate", pr: "PR", planner: "Plan", orchestrate: "Root", root: "Root",
};
const ROLE_KEYWORDS = {
  Research: ["調査", "探す", "確認", "特定", "洗い出し", "Investigate", "Research", "Find"],
  Docs: ["文書", "執筆", "Docs", "Write docs"],
};
export function roleLabel(node) {
  if (!node) return "";
  for (const key of [node.role, node.executor]) {
    if (key && Object.prototype.hasOwnProperty.call(ROLE_LABEL, key)) return ROLE_LABEL[key];
  }
  if (node.role) return node.role.length > 10 ? node.role.slice(0, 9) + "…" : node.role[0].toUpperCase() + node.role.slice(1);
  const text = [node.title || "", String(node.task || "").trim().split("\n", 1)[0]].join("\n");
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((keyword) => text.includes(keyword))) return role;
  }
  return familyOf(node) ? "Coding" : "Task";
}

// claude-<family>-<major>[-<minor>][-<yyyymmdd>] と gpt-<major>[.<minor>][-<name>] を短い名前にする
const CLAUDE_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const GPT_PATTERN = /^gpt-(\d+)(?:[.-](\d+))?(?:-([a-z][a-z-]*))?$/;
export function modelLabel(id) {
  if (!id) return "";
  const wide = /\[1m\]$/i.test(id);
  const base = wide ? id.slice(0, id.lastIndexOf("[")) : id;
  const claude = CLAUDE_PATTERN.exec(base);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}${claude[3] ? "." + claude[3] : ""}${wide ? " 1M" : ""}`;
  }
  const gpt = GPT_PATTERN.exec(base);
  if (gpt) {
    const name = (gpt[3] || "").split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
    return `GPT ${gpt[1]}${gpt[2] ? "." + gpt[2] : ""}${name ? " " + name : ""}`;
  }
  return id;
}

// 丸の中の 1 語を切らずに読めるよう、長い名前は 2 行に折る。行の長さで文字の大きさの段も決める
export function fitWords(text, maxChars = 9) {
  const label = String(text || "").trim();
  if (!label) return { lines: [], size: "" };
  if (label.length <= maxChars) return { lines: [label], size: "" };
  const words = label.split(" ");
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(" "), tail = words.slice(i).join(" ");
    const longest = Math.max(head.length, tail.length);
    if (!best || longest < best.longest) best = { lines: [head, tail], longest };
  }
  if (!best) {
    // 空白の無い 1 語。中央で折る
    const half = Math.ceil(label.length / 2);
    best = { lines: [label.slice(0, half), label.slice(half)], longest: half };
  }
  return { lines: best.lines, size: best.longest > maxChars + 3 ? "tight" : best.longest > maxChars ? "snug" : "" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d) ? null : d;
}

// 今日は時刻だけ、今年は月日まで、それ以外は年から出す。full なら常に年から出す
export function fmtWhen(value, full = false, now = new Date()) {
  const d = toDate(value);
  if (!d) return value ? String(value) : "";
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
  if (full) return `${d.getFullYear()} ${day}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  return d.getFullYear() === now.getFullYear() ? day : `${d.getFullYear()} ${day}`;
}

// リセットまでの残り。桁を落として短く出す
export function fmtUntil(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return "";
  const min = Math.round((d - now) / 60000);
  if (min <= 0) return "now";
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ${pad2(min % 60)}m`;
  return `${Math.floor(hour / 24)}d ${pad2(hour % 24)}h`;
}

// 経過時間の短い表記
export function fmtElapsed(started, ended, now = new Date()) {
  const from = toDate(started);
  if (!from) return "";
  const to = toDate(ended) || now;
  const sec = Math.max(0, Math.round((to - from) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h ${pad2(min % 60)}m`;
  return `${Math.floor(hour / 24)}d ${pad2(hour % 24)}h`;
}

export function fmtTokens(tokens) {
  if (!tokens) return "";
  const short = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  return `${short(tokens.input || 0)} in · ${short(tokens.output || 0)} out`;
}
