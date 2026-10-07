import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createNativeId, projectEntities } from "../../../core/src/ledger/index.ts";
import type { Fact, Ledger } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../observe/claude/index.ts";
import type { ClaudeObservation } from "../observe/claude/index.ts";
import type { FileCursor } from "../observe/files.ts";

export function observeClaudeHistories(ledger: Ledger, directory: string, facts: Fact[],
  batch: <T>(operation: () => T) => T = (operation) => operation(),
  paths?: string[], saved?: Map<string, FileCursor>): ClaudeObservation[] {
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
        if (result.status === "appended" && input.kind.startsWith("conversation.")) {
          history.push({ ...input, seq: result.seq, fact_id: result.fact_id } as Fact);
        }
        return result;
      },
    };
    let result;
    try { result = batch(() => observeClaudeFile(fileLedger, file, { cursor: saved?.get(resolve(file)) ?? cursors.get(resolve(file)) })); }
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
