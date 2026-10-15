import { spawn } from "node:child_process";
import { basename, relative, resolve } from "node:path";
import { readProcessStarts, type SessionScan } from "../../service/session-scan.ts";
import { normalizeProcessStart } from '../../../../core/src/state/process.ts';

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
  signal: AbortSignal): Promise<Map<string, number>> {
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
  const live = new Map<string, number>();
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
        live.set(match[1], pid);
      }
    } else if (!line.startsWith("f")) {
      throw new Error("Invalid lsof observation");
    }
  }
  // ps と lsof の間に消えた PID も、不完全な周期として次回へ保留する。
  if (seen.size !== pids.size) throw new Error("Incomplete lsof observation");
  return live;
}

/** 所持の観測を返す。台帳へ idle や終了を書き込まない。 */
export async function scanCodexSessions(codexHome: string, reader: CodexProcessReader = processReader,
  now = Date.now, readStarts = readProcessStarts): Promise<SessionScan> {
  let status: SessionScan['status'] = 'succeeded';
  let sessions: SessionScan['sessions'] = [], processes: SessionScan['processes'] = [];
  try {
    const live = await readLiveConversations(reader, codexHome, new AbortController().signal);
    const starts = await readStarts();
    processes = [...starts].map(([pid, procStart]) => ({ pid, procStart: normalizeProcessStart(procStart, 'local') }));
    for (const [sessionId, pid] of live) {
      const procStart = processes.find(process => process.pid === pid)?.procStart;
      if (!procStart) { status = 'partial'; continue; }
      sessions.push({ sessionId, pid, procStart, startedAt: /^\d+$/.test(procStart) ? Number(procStart) : Date.parse(procStart) });
    }
  } catch { status = 'failed'; }
  const at = now();
  return { id: `codex:${at}`, provider: 'codex', at, status, sessions, processes };
}
