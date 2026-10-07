import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { PROJECTION_TABLES } from "../../../core/src/ledger/rebuild.ts";
import { forwardScreenCommand } from "./commands.ts";
import type { openObservationService } from "../service/index.ts";
import { pollObservation } from "../service/poll.ts";
import { PROJECTION_POLL_MS } from "../service/index.ts";
import { ProjectionFeed, type ProjectionPatch } from "../service/projection-feed.ts";
import { RunnerClient, runnerSocketPath } from "../runner-client.ts";
import { authorize, createToken, readRequestUrl } from "./security.ts";
import { createSearchHandler } from "../search/index.ts";
import { createFilesApi, handleFilesCommand } from "../files/index.ts";
import { FILE_COMMANDS } from "./contract.ts";
import type { RedactionRules } from "../../../core/src/ledger/redact.ts";

export const DEFAULT_WS_PORT = 7421;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * MAX_FRAME_BYTES;
export interface WebSocketOptions {
  port?: number;
  runnerPath?: string;
  patchRetention?: number;
  readRedactionRules?: () => RedactionRules;
}

export async function startWebSocketServer(service: ReturnType<typeof openObservationService>, options: WebSocketOptions = {}) {
  const feed = new ProjectionFeed(service.dbPath, service.catchUp, options.patchRetention);
  const token = createToken();
  const clients = new Map<WebSocket, Set<string> | undefined>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  function send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { socket.terminate(); return; }
    socket.send(JSON.stringify(message));
  }
  function sendPatch(socket: WebSocket, patch: ProjectionPatch): void {
    const tables = clients.get(socket);
    send(socket, tables ? { ...patch, changes: Object.fromEntries(Object.entries(patch.changes)
      .filter(([table]) => tables.has(table))) } : patch);
  }
  function refresh(): void {
    const update = feed.refresh();
    if (!update) return;
    for (const socket of clients.keys()) {
      if (update === "resync") {
        clients.delete(socket);
        send(socket, { type: "resync", reason: "Projection rebuilt" });
      } else sendPatch(socket, update);
    }
  }
  const runner = new RunnerClient(options.runnerPath ?? runnerSocketPath(), (event) => {
    if ("seq" in event) pollObservation(refresh);
    else for (const socket of clients.keys()) send(socket, { type: "delta", ...event.delta });
  });
  let port = options.port ?? DEFAULT_WS_PORT;
  const searchDb = new DatabaseSync(service.dbPath, { readOnly: true });
  searchDb.exec("PRAGMA busy_timeout = 5000");
  const searchOptions = { port, token };
  const search = createSearchHandler(searchDb, searchOptions);
  const files = createFilesApi(searchDb, options.readRedactionRules);
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!authorize(request, port, token)) { response.writeHead(403).end(); return; }
    const path = readRequestUrl(request)?.pathname;
    if (path === "/api/search") { refresh(); search(request, response); return; }
    if (request.method !== "GET" || path !== "/snapshot") { response.writeHead(404).end(); return; }
    refresh();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(feed.snapshot()));
  });
  server.on("upgrade", (request, socket, head) => {
    if (!authorize(request, port, token) || readRequestUrl(request)?.pathname !== "/ws") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    socket.on("error", () => socket.terminate());
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (data, binary) => {
      if (binary) { socket.close(1003, "JSON required"); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1008, "Invalid JSON"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { socket.close(1008, "Invalid message"); return; }
      if (message.type === "hello") {
        const tables = message.scope?.tables;
        if (!Number.isSafeInteger(message.seq) || message.seq < 0
          || message.generation !== undefined && (!Number.isSafeInteger(message.generation) || message.generation < 0)
          || tables !== undefined && (!Array.isArray(tables) || tables.some((table: unknown) =>
            typeof table !== "string" || !(PROJECTION_TABLES as readonly string[]).includes(table)))) {
          socket.close(1008, "Invalid hello"); return;
        }
        refresh();
        const patches = feed.replay(message.seq, message.generation);
        if (!patches) {
          clients.delete(socket);
          send(socket, { type: "resync", reason: "Patch retention exhausted or projection rebuilt" });
          return;
        }
        clients.set(socket, tables === undefined ? undefined : new Set<string>(tables));
        for (const patch of patches) sendPatch(socket, patch);
      } else if (message.type === "cmd" && clients.has(socket) && typeof message.cmd_id === "string"
        && message.cmd_id.length > 0 && typeof message.command === "string" && message.command.length > 0) {
        if ((FILE_COMMANDS as readonly string[]).includes(message.command)) {
          refresh();
          void handleFilesCommand(files, message.command, message.payload).then((result) => {
            send(socket, { type: "ack", cmd_id: message.cmd_id, ok: true, result });
          }, () => {
            // Git の stderr やファイルの内容を失敗の応答へ複製しない。
            send(socket, { type: "ack", cmd_id: message.cmd_id, ok: false, error: "Files request failed" });
          });
          return;
        }
        void runner.request(forwardScreenCommand(message)).then((result) => {
          const { type, ...ack } = result;
          send(socket, { type: "ack", ...ack });
        });
      } else socket.close(1008, "Expected hello or cmd");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { runner.close(); feed.close(); searchDb.close(); wss.close(); throw error; }
  port = (server.address() as { port: number }).port;
  searchOptions.port = port;
  const timer = setInterval(() => pollObservation(refresh), PROJECTION_POLL_MS);
  return {
    url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token, runner,
    close: async () => {
      clearInterval(timer);
      runner.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      feed.close();
      searchDb.close();
    },
  };
}

export { WebSocket };
