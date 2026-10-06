#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { ledgerDbPath, runnerSocketPath } from "./paths.ts";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./socket.ts";
import { serveRunner } from "./runtime.ts";

const STATUS_TIMEOUT_MS = 5000;
const HELP = "Usage: agent-graph-runner serve [--socket <path>] [--db <path>] | status [--socket <path>]";

export function queryStatus(path: string): Promise<unknown> {
  return new Promise((resolveStatus, reject) => {
    const socket = createConnection(path);
    const cmdId = randomUUID();
    let buffer = "";
    let completed = false;
    socket.setEncoding("utf8");
    socket.setTimeout(STATUS_TIMEOUT_MS, () => socket.destroy(new Error("Runner status timed out")));
    socket.on("error", reject);
    socket.on("close", () => { if (!completed) reject(new Error("Runner disconnected before status response")); });
    socket.on("connect", () => socket.write(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, role: "cli" }) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { socket.destroy(new Error("Runner response too large")); return; }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); }
        catch { socket.destroy(new Error("Invalid runner response")); return; }
        if (!message || typeof message !== "object") { socket.destroy(new Error("Invalid runner response")); return; }
        buffer = buffer.slice(end + 1);
        if (message.type === "hello") {
          if (message.version !== PROTOCOL_VERSION || message.role !== "runner") { socket.destroy(new Error("Runner protocol mismatch")); return; }
          socket.write(JSON.stringify({ type: "req", cmd_id: cmdId, command: "status" }) + "\n");
        } else if (message.type === "res" && message.cmd_id === cmdId) {
          completed = true;
          socket.destroy();
          if (message.ok) resolveStatus(message.result);
          else reject(new Error(message.error));
        }
      }
    });
  });
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...flags] = args;
  if (command === "--help" || command === "-h") { console.log(HELP); return; }
  if (command !== "serve" && command !== "status") throw new TypeError(HELP);
  let socketPath = runnerSocketPath();
  let dbPath = ledgerDbPath();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${flag}`);
    if (flag === "--socket") socketPath = resolve(value);
    else if (flag === "--db" && command === "serve") dbPath = resolve(value);
    else throw new TypeError(`Unknown option: ${flag}`);
  }
  if (command === "status") { console.log(JSON.stringify(await queryStatus(socketPath))); return; }
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const ledger = openLedger(dbPath);
  let runner: Awaited<ReturnType<typeof serveRunner>> | undefined;
  let stop: () => void = () => {};
  try {
    runner = await serveRunner(ledger, socketPath);
    console.log(JSON.stringify({ socket: socketPath, db: dbPath }));
    await new Promise<void>((resolveStop) => {
      stop = resolveStop;
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try { await runner?.close(); } finally { ledger.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
