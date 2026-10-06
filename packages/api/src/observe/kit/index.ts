import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectConversations, projectProjects } from "../../../../core/src/ledger/index.ts";
import type { Ledger } from "../../../../core/src/ledger/index.ts";

export interface KitSnapshot {
  names: ReadonlyMap<string, string>;
  source_ts: string | null;
  deferred: boolean;
}

export function kitNamesPath(rootPath: string): string {
  return join(rootPath, ".agents", "state", "sessions.json");
}

export function createKitReader() {
  const snapshots = new Map<string, KitSnapshot>();
  return {
    readNames(rootPath: string): KitSnapshot {
      const path = kitNamesPath(rootPath);
      let snapshot: KitSnapshot;
      try {
        const sourceTs = statSync(path).mtime.toISOString();
        const data: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!data || typeof data !== "object" || Array.isArray(data)
          || Object.entries(data).some(([id, name]) => !id || typeof name !== "string" || !name)) {
          throw new SyntaxError("キットの会話 ID と名前の辞書が未完成です");
        }
        snapshot = { names: new Map(Object.entries(data) as [string, string][]), source_ts: sourceTs, deferred: false };
      } catch (error) {
        if (!(error instanceof SyntaxError)
          && !(error instanceof Error && "code" in error
            && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code)))) throw error;
        const previous = snapshots.get(path);
        return { names: new Map(previous?.names), source_ts: previous?.source_ts ?? null, deferred: true };
      }
      snapshots.set(path, snapshot);
      return { ...snapshot, names: new Map(snapshot.names) };
    },
  };
}

export interface KitObservationResult {
  appended: number;
  duplicates: number;
  pending: number;
  deferred: number;
}

/** 登録済みプロジェクトを一巡する。呼び出し側が再読み取りの周期を決める。 */
export function createKitObserver(ledger: Ledger) {
  const reader = createKitReader();
  // hook より先に届いた番号は、ファイルの次の更新でも捨てない。
  const pending = new Map<string, { repository_id: string; native_id: string; name: string; source_ts: string }>();
  return {
    observe(): KitObservationResult {
      const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
      const projects = projectProjects(facts).filter((entry) => entry.state === "registered" && entry.root_path);
      const registered = new Set(projects.map((entry) => entry.id));
      const conversations = new Map<string, string[]>();
      for (const conversation of projectConversations(facts).conversations) {
        if (!conversation.native_id) continue;
        const matches = conversations.get(conversation.native_id) ?? [];
        matches.push(conversation.id);
        conversations.set(conversation.native_id, matches);
      }
      const result: KitObservationResult = { appended: 0, duplicates: 0, pending: 0, deferred: 0 };
      for (const project of projects) {
        const snapshot = reader.readNames(project.root_path!);
        if (snapshot.deferred) result.deferred += 1;
        if (!snapshot.source_ts) continue;
        for (const [nativeId, name] of snapshot.names) {
          const key = JSON.stringify([project.id, nativeId, name]);
          if (!pending.has(key)) pending.set(key, {
            repository_id: project.id, native_id: nativeId, name, source_ts: snapshot.source_ts,
          });
        }
      }
      for (const [key, entry] of pending) {
        if (!registered.has(entry.repository_id)) continue;
        const matches = conversations.get(entry.native_id);
        // キットには provider がないため、曖昧な一致は保留する。
        if (matches?.length !== 1) {
          result.pending += 1;
          continue;
        }
        const entityId = matches[0];
        const eventId = JSON.stringify(["alias", entry.repository_id, entityId, entry.name]);
        const aliasId = createHash("sha256").update(eventId).digest("hex");
        const appended = ledger.append({
          source: "kit", source_event_id: eventId, kind: "alias.created", subject: `alias:${aliasId}`,
          payload: { entity_id: entityId, kind: "kit", name: entry.name },
          source_ts: entry.source_ts, confidence: "confirmed",
        });
        if (appended.status === "conflict") throw new Error(`キットの別名の事実が衝突しました: ${eventId}`);
        if (appended.status === "appended") result.appended += 1;
        else result.duplicates += 1;
        pending.delete(key);
      }
      return result;
    },
  };
}
