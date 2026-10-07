import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createNativeId, projectEntities } from "../../../core/src/ledger/index.ts";
import type { Fact, Ledger } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../observe/claude/index.ts";
import { observeClaudeContext } from "../observe/claude/context.ts";
import type { LocationResolver } from "../observe/location.ts";
import type { ClaudeObservation } from "../observe/claude/index.ts";
import type { FileCursor } from "../observe/files.ts";

export function observeClaudeHistories(ledger: Ledger, directory: string, facts: Fact[],
  batch: <T>(operation: () => T) => T = (operation) => operation(),
  paths?: string[], saved?: Map<string, FileCursor>, locate?: LocationResolver): ClaudeObservation[] {
  const cursors = new Map<string, FileCursor>();
  const conversations = new Map<string, Fact[]>();
  const identities = new Map(projectEntities(facts, "conversation").map((conversation) => [
    `conversation:${conversation.id}`, conversation.provider && conversation.native_id
      ? createNativeId(conversation.provider, conversation.native_id) : conversation.id,
  ]));
  for (const fact of facts) {
    if (fact.source === "transcript-claude" && fact.cursor) {
      const cursor = JSON.parse(fact.cursor) as FileCursor;
      cursors.set(cursor.path, cursor);
    }
    if (fact.source === "transcript-claude" && fact.kind === "observation.unsupported") {
      const path = fact.payload?.file_path;
      if (typeof path === "string") {
        const id = createNativeId("claude", basename(path, ".jsonl"));
        const history = conversations.get(id) ?? [];
        history.push(fact);
        conversations.set(id, history);
      }
    }
    // 会話の記録と hook の実行は、ターンの根拠を結ぶ先と直前の状態を決めるのに使う。
    if (fact.kind.startsWith("run.") && (fact.source === "transcript-claude" || fact.source === "hook")) {
      const raw = (fact.payload as { conversation_id?: unknown } | null)?.conversation_id;
      if (typeof raw !== "string") continue;
      const id = identities.get(`conversation:${raw}`) ?? raw;
      const history = conversations.get(id) ?? [];
      history.push(fact);
      conversations.set(id, history);
      continue;
    }
    const child = (fact.payload as { to_id?: string } | null)?.to_id;
    if (fact.kind.startsWith("relation.") && typeof child === "string") {
      const history = conversations.get(child) ?? [];
      history.push(fact); conversations.set(child, history);
      continue;
    }
    if (!fact.kind.startsWith("conversation.")) continue;
    const id = identities.get(fact.subject) ?? fact.subject.slice("conversation:".length);
    const history = conversations.get(id) ?? [];
    history.push(fact);
    conversations.set(id, history);
  }
  const results: ClaudeObservation[] = [];
  function visitFile(file: string): void {
    const id = createNativeId("claude", basename(file, ".jsonl"));
    // 部品の会話判定には、このファイルの会話の履歴だけを渡す。
    const history = conversations.get(id) ?? [];
    conversations.set(id, history);
    const fileLedger: Ledger = { ...ledger,
      readSince: (seq, limit) => history.filter((fact) => fact.seq > seq).slice(0, limit),
      append(input) {
        const result = ledger.append(input);
        if (result.status === "appended" && (input.kind.startsWith("conversation.") || input.kind.startsWith("run.") || input.kind.startsWith("relation."))) {
          history.push({ ...input, seq: result.seq, fact_id: result.fact_id } as Fact);
        }
        return result;
      },
    };
    let result;
    const start = saved?.get(resolve(file)) ?? cursors.get(resolve(file));
    try {
      result = batch(() => {
        const observation = observeClaudeFile(fileLedger, file, { cursor: start });
        // 発言の取り込みで読んだ行から、場所とターンの根拠を同じ取引で足す。
        const context = observeClaudeContext(fileLedger, file, { lines: observation.lines,
          fromStart: !start || observation.reset || start.offset === 0, ...(locate ? { locate } : {}) });
        return { ...observation, conflicts: [...observation.conflicts, ...context.conflicts] };
      });
    }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    results.push(result);
    if (!result.conflicts.length) saved?.set(resolve(file), result.cursor);
  }
  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        visitFile(file);
      }
    }
  }
  if (paths) {
    // 差分一覧だけを既存の形式読みに渡す。
    for (const file of paths) visitFile(file);
  } else visit(directory);
  return results;
}
