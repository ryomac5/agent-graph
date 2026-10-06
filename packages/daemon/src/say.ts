import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRepo } from "../../core/src/store/queries.ts";
import type { Store } from "../../core/src/store/store.ts";
import type { ActionResult } from "./http/contract.ts";
import { NotFoundError } from "./sessions.ts";

const execFileAsync = promisify(execFile);

const SAY_MAX_CHARS = 4000;
// 制御文字は送信時に取り除く。改行は Enter として解釈されるので 1 行に潰す。
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface SayInput {
  repo: string;
  sessionId: string;
  text: string;
}

// herdr への呼び出し。テストでは差し替える。list は pane 一覧の JSON、prompt は送信の成否。
export interface Herdr {
  list(): Promise<string>;
  prompt(paneId: string, text: string): Promise<void>;
}

export const herdr: Herdr = {
  async list() { return (await execFileAsync("herdr", ["agent", "list"], { encoding: "utf8" })).stdout; },
  async prompt(paneId, text) { await execFileAsync("herdr", ["agent", "prompt", paneId, text], { encoding: "utf8" }); },
};

// body を検べて SayInput にする。不正なら TypeError。
export function parseSay(body: unknown): SayInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Invalid say body");
  const { repo, sessionId, text } = body as Record<string, unknown>;
  if (typeof repo !== "string" || !repo || repo.includes("\0")) throw new TypeError("Invalid repo");
  if (typeof sessionId !== "string" || !sessionId || sessionId.includes("\0")) throw new TypeError("Invalid sessionId");
  if (typeof text !== "string") throw new TypeError("Invalid text");
  return { repo, sessionId, text };
}

// herdr agent list の JSON を読んで、agent_session.value が sessionId の pane を探す。
// herdr が動いていなければ undefined。
export function findPaneId(listJson: string, sessionId: string): string | undefined {
  let parsed: { result?: { agents?: Array<{ pane_id?: string; agent_session?: { value?: string } }> } };
  try { parsed = JSON.parse(listJson) as typeof parsed; }
  catch { return undefined; }
  const agents = parsed?.result?.agents;
  if (!Array.isArray(agents)) return undefined;
  const pane = agents.find((agent) => agent.agent_session?.value === sessionId && typeof agent.pane_id === "string");
  return pane ? pane.pane_id : undefined;
}

// herdr agent prompt で Claude セッションへテキストを送る。pane が無いときは ok: false。
export async function sayToSession(body: unknown, stores: Map<string, Store>, client: Herdr = herdr): Promise<ActionResult> {
  const input = parseSay(body);
  const text = input.text.replace(CONTROL_CHARS, "").trim();
  if (!text) return { ok: false, message: "The message is empty" };
  if (text.startsWith("/")) return { ok: false, message: "Messages starting with / cannot be sent" };
  if (text.length > SAY_MAX_CHARS) return { ok: false, message: `Too long (max ${SAY_MAX_CHARS} characters)` };
  const store = stores.get(input.repo);
  if (!store) throw new NotFoundError(`Repo not found: ${input.repo}`);
  const session = store.getSession(input.sessionId);
  if (!session || session.repoKey !== input.repo) throw new NotFoundError(`Session not found: ${input.sessionId}`);
  if (!["claude", "codex"].includes(session.client)) return { ok: false, message: "This session cannot receive messages" };
  if (session.status === "ended") return { ok: false, message: `${session.name} has already ended` };
  let paneId: string | undefined;
  try { paneId = findPaneId(await client.list(), input.sessionId); }
  catch { paneId = undefined; }
  if (!paneId) return { ok: false, message: `No Herdr pane found for ${session.name}. Only sessions started in Herdr can receive messages.` };
  const oneLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  try {
    await client.prompt(paneId, oneLine);
  } catch (error) {
    const detail = error && typeof error === "object" && "message" in error ? String((error as Error).message) : String(error);
    return { ok: false, message: `Send failed: ${detail.slice(0, 200)}` };
  }
  const name = getRepo(store.db, input.repo)?.name ?? input.repo;
  return { ok: true, message: `Sent to ${session.name} in ${name}` };
}
