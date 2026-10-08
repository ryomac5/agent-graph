import { spawn } from "node:child_process";
import { basename, relative, resolve } from "node:path";
import { projectConversations, projectRuns } from "../../../../core/src/ledger/index.ts";
import type { Ledger, RunPayload } from "../../../../core/src/ledger/index.ts";

const MINUTE_MS = 60_000;
const PROCESS_POLL_MS = 30_000;
const STARTUP_GRACE_MS = 2 * MINUTE_MS;
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BYTES = 16 * 1024 * 1024;
const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexProcessReader {
  listProcesses(signal?: AbortSignal): string | Promise<string>;
  readOpenFiles(pids: readonly number[], signal?: AbortSignal): string | Promise<string>;
}

function readCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { timeout: COMMAND_TIMEOUT_MS, signal,
      stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let incomplete = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > COMMAND_MAX_BYTES) { incomplete = true; child.kill(); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", () => { incomplete = true; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal || incomplete) reject(new Error(`Incomplete ${command} observation`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

const processReader: CodexProcessReader = {
  listProcesses: signal => readCommand("ps", ["-axo", "pid=,comm="], signal),
  readOpenFiles: (pids, signal) => readCommand("lsof", ["-nP", "-p", pids.join(","), "-F", "pn"], signal),
};

async function readLiveConversations(reader: CodexProcessReader, codexHome: string,
  signal: AbortSignal): Promise<Set<string>> {
  const pids = new Set<number>();
  for (const line of (await reader.listProcesses(signal)).split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) {
      throw new Error("Incomplete ps observation");
    }
    if (basename(match[2].trim()) === "codex") pids.add(Number(match[1]));
  }
  signal.throwIfAborted();
  const live = new Set<string>();
  if (!pids.size) return live;
  const seen = new Set<number>();
  let pid: number | undefined;
  const sessions = resolve(codexHome, "sessions");
  for (const line of (await reader.readOpenFiles([...pids], signal)).split("\n")) {
    if (!line) continue;
    if (line.startsWith("p")) {
      if (!/^p\d+$/.test(line) || !pids.has(Number(line.slice(1)))) throw new Error("Invalid lsof PID");
      pid = Number(line.slice(1));
      seen.add(pid);
    } else if (line.startsWith("n") && pid !== undefined) {
      const path = line.slice(1);
      const match = ROLLOUT_NAME.exec(basename(path));
      const location = relative(sessions, path);
      if (match && path.startsWith("/") && location && !location.startsWith("../") && location !== "..") {
        live.add(match[1]);
      }
    } else if (!line.startsWith("f")) {
      throw new Error("Invalid lsof observation");
    }
  }
  // ps と lsof の間に消えた PID も、不完全な周期として次回へ保留する。
  if (seen.size !== pids.size) throw new Error("Incomplete lsof observation");
  return live;
}

/** 実機で確認した、Codex が開いている rollout と会話 ID の対応を使う。 */
export function createCodexSessionObserver(ledger: Ledger, codexHome: string,
  reader: CodexProcessReader = processReader) {
  let lastSignature: string | undefined;
  let lastScanMs = Number.NEGATIVE_INFINITY;
  let lastPollMs = Number.NEGATIVE_INFINITY;
  let pending = false;
  let completed: { live?: Set<string>; checkedTs: string } | undefined;
  const controller = new AbortController();
  function observeCodexSessions(timestamp = new Date().toISOString()): number {
    const pollMs = Date.parse(timestamp);
    if (!Number.isFinite(pollMs) || controller.signal.aborted) return 0;
    const result = completed;
    completed = undefined;
    // 完了を受け取ってからも間隔を空け、遅い ps による lsof の連続起動を防ぐ。
    if (result) lastPollMs = pollMs;
    if (!pending && pollMs - lastPollMs >= PROCESS_POLL_MS) {
      lastPollMs = pollMs;
      pending = true;
      // 非同期の取得は結果の保管だけを行い、台帳は次の周期で扱う。
      void readLiveConversations(reader, codexHome, controller.signal).then(live => {
        if (!controller.signal.aborted) completed = { live, checkedTs: timestamp };
      }, () => {
        if (!controller.signal.aborted) completed = { checkedTs: timestamp };
      }).finally(() => { pending = false; });
    }
    if (!result?.live) return 0;
    const { live, checkedTs } = result;
    const now = Date.parse(checkedTs);
    const signature = JSON.stringify([...live].sort());
    if (signature === lastSignature && now - lastScanMs < MINUTE_MS) return 0;
    lastSignature = signature;
    lastScanMs = now;

    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const conversations = projectConversations(facts, new Map()).conversations;
    const eligible = new Map(conversations.filter(row => row.provider === "codex" && row.origin === "observed")
      .flatMap(row => [[row.id, row], [`codex:${row.native_id}`, row]] as const));
    const subjects = new Map<string, `run:${string}`>();
    const subjectConversations = new Map<string, string>();
    const fileConversations = new Map<string, string>();
    for (const fact of facts) {
      if (fact.kind === "run.created" && fact.payload) {
        const payload = fact.payload as Partial<RunPayload>;
        subjects.set(JSON.stringify([payload.conversation_id, payload.generation]), fact.subject as `run:${string}`);
        const conversation = eligible.get(payload.conversation_id!);
        if (conversation) subjectConversations.set(fact.subject, conversation.id);
      }
      if (fact.kind === "conversation.created" || fact.kind === "conversation.corrected") {
        const id = fact.subject.slice("conversation:".length);
        const conversation = eligible.get(id);
        if (!conversation) continue;
        subjectConversations.set(fact.subject, conversation.id);
        if (fact.source === "rollout-codex" && fact.cursor) {
          const fileId = (JSON.parse(fact.cursor) as { file_id?: string }).file_id;
          if (fileId && ROLLOUT_NAME.exec(basename(fileId))?.[1] === conversation.native_id) {
            fileConversations.set(fileId, conversation.id);
          }
        }
      }
    }
    const lastRecords = new Map<string, number>();
    for (const fact of facts) {
      const fileId = fact.source === "rollout-codex" && fact.cursor
        ? (JSON.parse(fact.cursor) as { file_id?: string }).file_id : undefined;
      const id = subjectConversations.get(fact.subject) ?? (fileId ? fileConversations.get(fileId) : undefined);
      if (id) lastRecords.set(id, Math.max(lastRecords.get(id) ?? 0, Date.parse(fact.source_ts)));
    }
    const latest = new Map<string, ReturnType<typeof projectRuns>[number]>();
    for (const run of projectRuns(facts)) {
      const conversation = eligible.get(run.conversation_id);
      if (conversation && run.generation > (latest.get(conversation.id)?.generation ?? -1)) latest.set(conversation.id, run);
    }
    const known = new Set(facts.filter(fact => fact.source === "rollout-codex").map(fact => fact.source_event_id));
    const minute = Math.floor(now / MINUTE_MS);
    let appended = 0;
    for (const [id, run] of latest) {
      const conversation = eligible.get(id)!;
      if (live.has(conversation.native_id!) || !["running", "waiting_approval", "waiting_input"].includes(run.state)) continue;
      const lastRecord = Math.max(lastRecords.get(id) ?? 0, Date.parse(run.last_evidence_ts ?? ""));
      if (!Number.isFinite(lastRecord) || now - lastRecord <= STARTUP_GRACE_MS) continue;
      const eventId = `process_absent:${id}:${minute}`;
      const subject = subjects.get(JSON.stringify([run.conversation_id, run.generation]));
      if (!subject || known.has(eventId)) continue;
      const result = ledger.append({ source: "rollout-codex", source_event_id: eventId,
        kind: "run.state_changed", subject, confidence: "confirmed", source_ts: checkedTs, observed_ts: checkedTs,
        payload: { conversation_id: run.conversation_id, generation: run.generation, state: "idle",
          last_evidence: { kind: "process_absent", checked_ts: checkedTs }, last_evidence_ts: checkedTs } });
      if (result.status === "conflict") throw new Error(`Conflicting Codex process observation: ${id}`);
      if (result.status === "appended") appended += 1;
    }
    return appended;
  }
  observeCodexSessions.close = () => { controller.abort(); completed = undefined; };
  return observeCodexSessions;
}
