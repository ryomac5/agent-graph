import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAction, performAction } from "./actions.ts";
import { findPaneId, sayToSession } from "./say.ts";
import { switchCodexModel, type PaneControl } from "./codex-model.ts";
import { findModelChoice } from "./models.ts";
import { NotFoundError } from "./sessions.ts";
import { getRepo, listDelegations } from "../../core/src/store/queries.ts";
import type { Store } from "../../core/src/store/store.ts";
import type { ActionResult } from "./http/contract.ts";
import { runDelegation, type DelegationDeps } from "../../core/src/delegate/run.ts";
import type { DelegateRequest } from "../../core/src/delegate/types.ts";

const execFileAsync = promisify(execFile);
const SWITCH_POLL_MS = 200;
const SWITCH_POLL_ATTEMPTS = 10;
const SWITCH_PROMPT = "Switching models";
const pendingRetries = new Set<string>();

export interface ControlClient {
  run(args: string[]): Promise<string>;
}
const client: ControlClient = {
  async run(args) { return (await execFileAsync("herdr", args, { encoding: "utf8", timeout: 10_000 })).stdout; },
};

function findCreatedPane(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (typeof row.pane_id === "string" && /^[A-Za-z0-9:_-]+$/.test(row.pane_id)) return row.pane_id;
  for (const nested of Object.values(row)) {
    const pane = findCreatedPane(nested);
    if (pane) return pane;
  }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// herdr の操作を Codex の選択画面の操作の形にする
function paneControl(control: ControlClient): PaneControl {
  return {
    read: (pane) => control.run(["pane", "read", pane, "--source", "visible"]),
    keys: async (pane, ...keys) => { for (const key of keys) await control.run(["pane", "send-keys", pane, key]); },
    prompt: async (pane, text) => { await control.run(["agent", "prompt", pane, text]); },
  };
}

async function waitForSwitch(control: ControlClient, pane: string, present: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < SWITCH_POLL_ATTEMPTS; attempt++) {
    const text = await control.run(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "20"]);
    if (text.includes(SWITCH_PROMPT) === present) return true;
    await new Promise((resolve) => setTimeout(resolve, SWITCH_POLL_MS));
  }
  return false;
}

// 再実行中も HTTP と SSE は応答する。元の履歴を残し、新しい委譲として起動する。
export async function controlAction(body: unknown, stores: Map<string, Store>, control = client,
  retryDeps: Partial<DelegationDeps> = {}): Promise<ActionResult> {
  const request = parseAction(body);
  if (!["new_session", "set_model", "rerun_delegation", "stop_session"].includes(request.action)) return performAction(body, stores);
  const store = stores.get(request.repo);
  const repo = store && getRepo(store.db, request.repo);
  if (!store || !repo) throw new NotFoundError(`Repo not found: ${request.repo}`);
  try {
    if (request.action === "new_session") {
      const created = await control.run(["workspace", "create", "--label", repo.name, "--cwd", repo.rootPath, "--no-focus"]);
      const pane = findCreatedPane(JSON.parse(created));
      if (!pane) return { ok: false, message: "起動先を取得できませんでした" };
      const executable = process.env[request.client === "claude" ? "AGENT_GRAPH_CLAUDE_BIN" : "AGENT_GRAPH_CODEX_BIN"] || request.client!;
      await control.run(["pane", "run", pane, `export HERDR_PANE_ID=${pane}; export PATH=${quoteShell(process.env.PATH ?? "")}; ${quoteShell(executable)}`]);
      return { ok: true, message: `${repo.name} で ${request.client} を起動しました` };
    }
    const session = store.getSession(request.sessionId!);
    if (!session || session.repoKey !== repo.key) throw new NotFoundError(`Session not found: ${request.sessionId}`);
    if (session.status === "ended") return { ok: false, message: "終了済みのセッションには操作できません" };
    if (request.action === "stop_session") {
      if (session.client !== "claude") return { ok: false, message: "このセッションは元の画面から停止してください" };
      if (store.countActiveDelegations(session.id)) return { ok: false, message: "子が実行中なので停止できません" };
      const pane = findPaneId(await control.run(["agent", "list"]), session.id);
      if (!pane) return { ok: false, message: "Herdr で起動したセッションが見つかりません" };
      await control.run(["agent", "prompt", pane, "/exit"]);
      return { ok: true, message: `${session.name} に終了を送りました。終了を観測すると履歴に移ります` };
    }
    if (request.action === "set_model") {
      if (session.client !== "claude" && session.client !== "codex") return { ok: false, message: "このセッションはモデルを切り替えられません" };
      const choice = findModelChoice(session.client, request.model ?? "");
      if (!choice) return { ok: false, message: `${request.model} はこのセッションで選べるモデルではありません` };
      if (request.effort && !choice.efforts.includes(request.effort)) return { ok: false, message: `${choice.label} は ${request.effort} を選べません` };
      const pane = findPaneId(await control.run(["agent", "list"]), session.id);
      if (!pane) return { ok: false, message: "Herdr で起動したセッションが見つかりません" };
      if (session.client === "codex") {
        // Codex の /model は引数を受け取らない。選択画面を読みながら操作し、その会話だけに効かせる
        const result = await switchCodexModel(paneControl(control), pane, { slug: choice.id, label: choice.label, effort: request.effort });
        return { ok: result.ok, message: `${session.name}: ${result.message}` };
      }
      await control.run(["agent", "prompt", pane, `/model ${request.model}`]);
      if (await waitForSwitch(control, pane, true)) {
        await control.run(["pane", "send-keys", pane, "enter"]);
        if (!await waitForSwitch(control, pane, false)) return { ok: false, message: "モデル変更の確認が完了していません" };
      }
      // Claude Code の /effort は引数をそのまま受け付ける
      if (request.effort) await control.run(["agent", "prompt", pane, `/effort ${request.effort}`]);
      // 送信成功と適用確認を混同しない。現在モデルは後続の観測で更新する。
      return { ok: true, message: `${session.name} に ${choice.label}${request.effort ? ` ${request.effort}` : ""} への変更を送りました。適用後のモデルは観測で更新されます` };
    }
    const row = listDelegations(store.db, repo.key).find((item) => item.id === request.delegationId && item.sessionId === session.id);
    if (!row) throw new NotFoundError(`Delegation not found: ${request.delegationId}`);
    if (!["failed", "lost", "timeout"].includes(row.status)) return { ok: false, message: "再実行できる状態ではありません" };
    const retryKey = `${repo.key}:${row.id}`;
    if (pendingRetries.has(retryKey)) return { ok: false, message: "この委譲は再実行中です" };
    if (row.kind === "subagent") {
      if (!row.task) return { ok: false, message: "再実行する依頼文が記録されていません" };
      return sayToSession({ repo: repo.key, sessionId: session.id,
        text: `失敗または追跡が途切れたサブエージェント「${row.title}」を再実行し、結果を確認してください。依頼文: ${row.task}` }, stores,
        { list: () => control.run(["agent", "list"]), prompt: async (pane, text) => { await control.run(["agent", "prompt", pane, text]); } });
    }
    const saved = store.db.prepare("SELECT request FROM delegation_requests WHERE delegation_id = ?").get(row.id);
    if (!saved) return { ok: false, message: "元の実行条件が保存されていません。親セッションから再依頼してください" };
    const original = JSON.parse(String(saved.request)) as DelegateRequest;
    pendingRetries.add(retryKey);
    void runDelegation(original, { repoKey: repo.key, repoRoot: repo.rootPath, sessionId: session.id,
      parentDelegationId: row.parentId, orchestratorModel: session.model }, { ...retryDeps, store })
      .catch((error) => console.error("delegation retry:", error))
      .finally(() => pendingRetries.delete(retryKey));
    return { ok: true, message: `「${row.title}」の再実行を開始しました` };
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    return { ok: false, message: `操作に失敗しました: ${error instanceof Error ? error.message : String(error)}` };
  }
}
