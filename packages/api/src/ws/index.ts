import { scanCodexSessions } from '../observe/codex/sessions.ts';
import { scanSessions, SESSION_SCAN_INTERVAL_MS, type SessionScan } from '../service/session-scan.ts';
import { SendWatch } from '../service/send-watch.ts';
import { addProject, listDirectories } from './projects.ts';
import { renameSession } from './session-rename.ts';
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { WebSocket, WebSocketServer } from "ws";
import { sendJson, WEBSOCKET_COMPRESSION } from './compression.ts';
import { PROJECTION_TABLES } from "../../../core/src/ledger/rebuild.ts";
import { forwardScreenCommand } from "./commands.ts";
import type { openObservationService } from "../service/index.ts";
import { pollObservation } from "../service/poll.ts";
import { PROJECTION_POLL_MS } from "../service/index.ts";
import { ProjectionFeed, type ProjectionPatch } from "../service/projection-feed.ts";
import { RunnerClient, runnerSocketPath } from "../runner-client.ts";
import { authorize, createToken, readRequestUrl } from "./security.ts";
import { createSearchHandler } from "../search/index.ts";
import { createFilesApi, handleFilesCommand, FilesWriteError, FilesPreviewError } from "../files/index.ts";
import { createTerminalSession } from "../terminal/index.ts";
import { createSessionHosts, TerminalInputError, type HostOptions, type SessionSendResult } from "../terminal/hosts.ts";
import { redact } from "../../../core/src/ledger/redact.ts";
import { FILE_COMMANDS, TERMINAL_COMMANDS, MAX_FRAME_BYTES } from "./contract.ts";
import type { RedactionRules } from "../../../core/src/ledger/redact.ts";
import type { SettingsService } from "../settings/index.ts";
import { createUsageService, type UsageOptions } from "../usage/index.ts";

export const DEFAULT_WS_PORT = 7421;
const MAX_OPEN_CONVERSATIONS = 10;
const PROJECTION_DELIVERY_MS = 25;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_COMMANDS = 256;
// 送出前の受付の保存は、観測の worker や runner の書き込み、checkpoint と重なると SQLITE_BUSY になる。
// 主スレッドを止めずに短い間隔で読み直し、この時間内に保存できなければ runner を呼ばずに拒否する。
const SEND_PERSIST_RETRY_MS = 2_000;
const SEND_PERSIST_RETRY_DELAY_MS = 20;
async function persistBeforeSend<T>(operation: () => T): Promise<T> {
  const deadline = performance.now() + SEND_PERSIST_RETRY_MS;
  for (;;) {
    try { return operation(); }
    catch (error) {
      const busy = error instanceof Error && "errcode" in error && (Number(error.errcode) & 0xff) === 5;
      if (!busy || performance.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, SEND_PERSIST_RETRY_DELAY_MS));
    }
  }
}
export interface WebSocketOptions {
  now?: () => number;
  usage?: UsageOptions;
  port?: number;
  runnerPath?: string;
  patchRetention?: number;
  readRedactionRules?: () => RedactionRules;
  settings?: SettingsService;
  sessionHosts?: HostOptions;
}

export async function startWebSocketServer(service: ReturnType<typeof openObservationService>, options: WebSocketOptions = {}) {
  let feed!: ProjectionFeed;
  const now = options.now ?? Date.now;
  let sendWatch!: SendWatch;
  let stopped = false;
  function readWatches<T>(read: () => T, fallback: T): T {
    try { return read(); }
    catch (error) { console.error('Send watch failed:', error); return fallback; }
  }
  function publishWatches() {
    const rows = sendWatch.list();
    for (const socket of clients.keys()) send(socket, { type: "send_watches", rows });
  }
  const token = createToken();
  const clients = new Map<WebSocket, { tables?: Set<string>; conversations: Set<string> }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: WEBSOCKET_COMPRESSION });
  function send(socket: WebSocket, message: unknown, serialized?: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { socket.terminate(); return; }
    socket.send(serialized ?? JSON.stringify(message));
  }
  function sendPatch(socket: WebSocket, patch: ProjectionPatch): void {
    const subscription = clients.get(socket)!;
    if (!subscription.tables && !subscription.conversations.size) {
      send(socket, patch, feed.serializePatch(patch));
      return;
    }
    const scoped = feed.scopePatch(patch, subscription.conversations);
    const message = subscription.tables ? { ...scoped, changes: Object.fromEntries(Object.entries(scoped.changes)
      .filter(([table]) => subscription.tables!.has(table))) } : scoped;
    const text = JSON.stringify(message);
    feed.recordPatchBytes(patch, text);
    send(socket, message, text);
  }
  function readScans(): Promise<SessionScan[]> {
    return Promise.all([scanSessions(service.sessionDirectory, undefined, now), scanCodexSessions(service.codexHome, undefined, now)]);
  }
  function refresh(): void {
    if (!feed) return;
    const update = feed.refresh(now());
    if (update) {
      // 接続がない間も、再接続用の履歴の保持量を制限する。
      if (update !== "resync" && !clients.size) feed.serializePatch(update);
      for (const socket of clients.keys()) {
        if (update === "resync") {
          clients.delete(socket);
          send(socket, { type: "resync", reason: "Projection rebuilt" });
        } else sendPatch(socket, update);
      }
    }
    // 台帳の差分を配り終えてから、補助の見張りを更新する。
    try { if (sendWatch?.check(now())) publishWatches(); }
    catch (error) { console.error('Send watch check failed:', error); }
  }
  const runner = new RunnerClient(options.runnerPath ?? runnerSocketPath(), (event) => {
    if ("seq" in event) pollObservation(refresh);
    else for (const [socket, subscription] of clients) {
      const conversation = feed.runConversation(event.delta.runId);
      if (conversation && [...subscription.conversations].some(id => feed.conversationId(id) === conversation)) send(socket, { type: "delta", ...event.delta });
    }
  });
  let port = options.port ?? DEFAULT_WS_PORT;
  const searchDb = new DatabaseSync(service.dbPath, { readOnly: true });
  searchDb.exec("PRAGMA busy_timeout = 5000");
  const searchOptions = { port, token };
  const search = createSearchHandler(searchDb, searchOptions);
  const files = createFilesApi(searchDb, options.readRedactionRules);
  const usage = createUsageService({
    readRepositoryPaths: () => searchDb.prepare(`SELECT root_path AS path FROM api_projects WHERE root_path IS NOT NULL
      UNION SELECT cwd AS path FROM conversations WHERE cwd IS NOT NULL
      UNION SELECT cwd AS path FROM runs WHERE cwd IS NOT NULL`).all().map(row => String(row.path)),
    ...options.usage,
  });
  const sessionHosts = createSessionHosts(files.selectRoot, options.sessionHosts);
  const sessionCommands = new Map<string, Promise<unknown>>();
  const completedSessionCommands: string[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!authorize(request, port, token)) { response.writeHead(403).end(); return; }
    const path = readRequestUrl(request)?.pathname;
    if (request.method === 'GET' && path === '/api/send-watches') {
      refresh();
      const conversation = readRequestUrl(request)!.searchParams.get('conversation');
      if (!conversation) { response.writeHead(400).end(); return; }
      sendJson(request, response, readWatches(() => sendWatch.history(conversation), []));
      return;
    }
    if (path === "/api/search") { refresh(); search(request, response); return; }
    if (request.method === "GET" && (path === "/conversation" || path === "/projection")) {
      refresh();
      const params = readRequestUrl(request)!.searchParams;
      const id = params.get("id");
      const table = params.get("table");
      if (path === "/conversation" && !id || path === "/projection" && (!table || table !== "roots" && !(PROJECTION_TABLES as readonly string[]).includes(table) || ["messages", "message_memberships"].includes(table))) {
        response.writeHead(400).end(); return;
      }
      sendJson(request, response, path === "/conversation" ? feed.conversation(id!, params.get("after") ?? "", {
        latest: params.get("latest") === "1", before: params.get("before") ?? undefined,
        message: params.get("message") ?? undefined, edits: params.get("edits") === "1",
      }) : feed.list(table!, params.get("after") ?? ""));
      return;
    }
    if (request.method !== "GET" || path !== "/snapshot") { response.writeHead(404).end(); return; }
    refresh();
    const snapshot = feed.snapshot();
    sendJson(request, response, { ...snapshot, projection: { ...snapshot.projection, send_watches: readWatches(() => sendWatch.list(), []) } });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!authorize(request, port, token) || readRequestUrl(request)?.pathname !== "/ws") {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });
  wss.on("connection", (socket) => {
    const notify = (message: import('../terminal/index.ts').TerminalNotification) => send(socket, message);
    const terminals = createTerminalSession(files.selectRoot, notify);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => { terminals.close(); sessionHosts.detach(notify); clients.delete(socket); });
    socket.on("message", async (data, binary) => {
      if (binary) { socket.close(1003, "JSON required"); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1008, "Invalid JSON"); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { socket.close(1008, "Invalid message"); return; }
      if (message.type === "hello") {
        const tables = message.scope?.tables;
        const conversations = message.scope?.conversations;
        if (!Number.isSafeInteger(message.seq) || message.seq < 0
          || message.generation !== undefined && (!Number.isSafeInteger(message.generation) || message.generation < 0)
          || tables !== undefined && (!Array.isArray(tables) || tables.some((table: unknown) =>
            typeof table !== "string" || table !== "projects" && table !== "roots" && table !== "state_decisions" && !(PROJECTION_TABLES as readonly string[]).includes(table)))
          || conversations !== undefined && (!Array.isArray(conversations) || conversations.length > MAX_OPEN_CONVERSATIONS || conversations.some((id: unknown) => typeof id !== "string" || !id))) {
          socket.close(1008, "Invalid hello"); return;
        }
        refresh();
        const patches = feed.replay(message.seq, message.generation);
        if (!patches) {
          clients.delete(socket);
          send(socket, { type: "resync", reason: "Patch retention exhausted or projection rebuilt" });
          return;
        }
        clients.set(socket, { tables: tables === undefined ? undefined : new Set<string>([...tables, ...(tables.includes('runs') ? ['state_decisions'] : [])]), conversations: new Set<string>(conversations ?? []) });
        for (const patch of patches) sendPatch(socket, patch);
        sendPatch(socket, feed.currentPatch());
        readWatches(() => send(socket, { type: "send_watches", rows: sendWatch.list() }), undefined);
      } else if (message.type === "cmd" && clients.has(socket) && typeof message.cmd_id === "string"
        && message.cmd_id.length > 0 && typeof message.command === "string" && message.command.length > 0) {
        try {
        if (message.command === 'project.add' || message.command === 'fs.directories') {
          try {
            const result = message.command === 'project.add' ? await addProject(service.appendUi, message) : listDirectories(message.payload);
            refresh();
            send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: true, result });
          } catch (error) { send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: false, error: error instanceof Error ? error.message : 'Request failed' }); }
          return;
        }
        if (message.command === 'session.rename') {
          try {
            refresh();
            const result = await renameSession({ append: service.appendUi }, id => feed.hasRoot(id), message);
            refresh();
            send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: true, result });
          } catch (error) {
            send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: false, error: error instanceof Error ? error.message : 'Rename failed' });
          }
          return;
        }
        if (message.command === 'usage.read') {
          void usage.read(message.payload).then(result => send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: true, result }),
            () => send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: false, error: 'Invalid usage request' }));
          return;
        }
        if ((message.command.startsWith("settings.") || ["models.resolve", "models.table"].includes(message.command)) && options.settings) {
          void options.settings.handle(message).then(ack => send(socket, ack));
          return;
        }
        if ((TERMINAL_COMMANDS as readonly string[]).includes(message.command)) {
          const hosted = message.command === 'attachment.put' || ['ssh.read', 'ssh.write', 'ssh.test', 'worktree.create', 'git.branches'].includes(message.command) || message.command.startsWith('session.') || message.command === 'terminal.attach' || sessionHosts.hasTerminal(message.payload?.terminalId);
          const retained = ['attachment.put', 'session.launch', 'session.send', 'session.interrupt', 'worktree.create', 'ssh.write'].includes(message.command);
          let result = retained && message.command !== 'session.send' ? sessionCommands.get(message.cmd_id) : undefined;
          if (!result) {
            const watched = message.command === 'session.send' && typeof message.payload?.conversationId === 'string' && typeof message.payload?.text === 'string';
            if (watched) pollObservation(refresh);
            const terminal = watched ? await sessionHosts.target(message.payload.conversationId) : undefined;
            const captured = watched ? await persistBeforeSend(() => sendWatch.capture(message.payload.conversationId, now(), terminal)) : undefined;
            if (captured && !await persistBeforeSend(() => sendWatch.begin(message.cmd_id, message.payload.conversationId, message.payload.text, captured, message.payload.attachments))) {
              sendWatch.check(now());
              const delivery = sendWatch.decision(message.cmd_id);
              const prior = sessionCommands.get(message.cmd_id);
              if (prior && delivery?.reason !== 'cmd_id_conflict') {
                void prior.then(result => send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: true, result }), () => send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: false, error: 'Terminal request failed' }));
                return;
              }
              send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: delivery?.reason !== 'cmd_id_conflict', ...(delivery?.reason === 'cmd_id_conflict' ? { error: 'cmd_id_conflict' } : { result: { delivery } }) });
              publishWatches(); return;
            }
            let emitting = false;
            result = hosted ? sessionHosts.handle(message.command, message.payload, notify, captured ? {
              emitting: target => {
                if (target !== terminal) throw new Error('no_host');
                sendWatch.phase(message.cmd_id, 'emitting', now()); emitting = true;
              }, emitted: () => sendWatch.phase(message.cmd_id, 'emitted', now()),
            } : undefined) : terminals.handle(message.command, message.payload);
            if (captured) result = result.then(value => {
              if ((value as SessionSendResult).delivery === 'terminal') sendWatch.handled(message.cmd_id, now());
              readWatches(() => { sendWatch.check(now()); publishWatches(); }, undefined); return value;
            }, error => {
              sendWatch.phase(message.cmd_id, emitting ? 'aborted' : 'rejected', now()); sendWatch.check(now()); publishWatches(); throw error;
            });
            if (hosted) result = result.then(value => {
              const response = value as SessionSendResult;
              if (response.command) return { ...response, command: { ...response.command,
                output: redact(response.command.output, options.readRedactionRules?.() ?? service.ledger.getRedactionRules()).text } };
              return value;
            });
            if (retained) {
              sessionCommands.set(message.cmd_id, result);
              const finish = () => {
                completedSessionCommands.push(message.cmd_id);
                if (completedSessionCommands.length > MAX_SESSION_COMMANDS) sessionCommands.delete(completedSessionCommands.shift()!);
              };
              void result.then(finish, finish);
            }
          }
          void result.then(result => {
            send(socket, { type: "ack", cmd_id: message.cmd_id, ok: true, result });
          }, error => {
            send(socket, { type: "ack", cmd_id: message.cmd_id, ok: false,
              ...(error instanceof TerminalInputError ? { result: { terminalId: error.terminalId } } : {}),
              error: error instanceof TerminalInputError || error instanceof Error && ["Terminal limit reached", "Unknown terminal", "Invalid terminal size", "Invalid session launch", "Session already hosted", "no_host", "Invalid attachment", "Invalid attachments", "Attachment too large", "Attachment transfer failed"].includes(error.message)
                ? error.message : "Terminal request failed" });
          });
          return;
        }
        if ((FILE_COMMANDS as readonly string[]).includes(message.command)) {
          refresh();
          void handleFilesCommand(files, message.command, message.payload).then((result) => {
            send(socket, { type: "ack", cmd_id: message.cmd_id, ok: true, result });
          }, (error) => {
            // Git の stderr やファイルの内容を失敗の応答へ複製しない。
            send(socket, { type: "ack", cmd_id: message.cmd_id, ok: false,
              error: message.command === 'files.preview' ? (error instanceof FilesPreviewError ? error.message : 'not_previewable')
                : message.command === "files.write" ? (error instanceof FilesWriteError ? error.message : "not_editable") : "Files request failed" });
          });
          return;
        }
        const input = message.payload?.input;
        if (['send', 'start', 'adopt', 'fork'].includes(message.command) && input?.attachments?.length) {
          send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: false, error: 'managed_attachments_unsupported' });
          return;
        }
        const watchedInput = ['send', 'start', 'adopt', 'fork'].includes(message.command) && typeof input?.text === 'string';
        if (watchedInput) pollObservation(refresh);
        const destination = message.payload?.conversationId ?? (message.payload?.runId ? feed.runConversation(message.payload.runId) : undefined);
        const captured = watchedInput && destination ? await persistBeforeSend(() => sendWatch.capture(destination, now(), 'runner', message.payload?.runId)) : undefined;
        if (captured && !await persistBeforeSend(() => sendWatch.begin(message.cmd_id, destination, input.text, captured))) {
          sendWatch.check(now());
          const delivery = sendWatch.decision(message.cmd_id);
          send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: delivery?.reason !== 'cmd_id_conflict', ...(delivery?.reason === 'cmd_id_conflict' ? { error: 'cmd_id_conflict' } : { result: { delivery } }) });
          publishWatches(); return;
        }
        if (captured) sendWatch.phase(message.cmd_id, 'emitting', now());
        void runner.request(forwardScreenCommand(message)).then((result) => {
          const { type, ...ack } = result;
          if (captured) readWatches(() => { sendWatch.phase(message.cmd_id, result.ok ? 'emitted' : 'aborted', now()); sendWatch.check(now()); publishWatches(); }, undefined);
          send(socket, { type: "ack", ...ack });
        }, () => {
          if (captured) readWatches(() => { sendWatch.phase(message.cmd_id, "aborted", now()); sendWatch.check(now()); publishWatches(); }, undefined);
          send(socket, { type: "ack", cmd_id: message.cmd_id, ok: false, error: "Runner unavailable" });
        });
        } catch {
          send(socket, { type: 'ack', cmd_id: message.cmd_id, ok: false, error: 'Unable to persist send operation' });
        }
      } else socket.close(1008, "Expected hello or cmd");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    // 起動時の走査は最初の評価の前に入れる。走査なしで全実行を評価し、直後に全件を評価し直して配らない。
    const initialScans = await readScans().catch(error => {
      console.error('Session scan persistence failed:', error instanceof Error ? error.message : 'Unknown failure');
      return [];
    });
    feed = new ProjectionFeed(service.dbPath, service.catchUp, options.patchRetention, initialScans);
    sendWatch = new SendWatch(service.dbPath, options.readRedactionRules);
    for (const result of initialScans) sendWatch.recordScan(result);
  } catch (error) { sessionHosts.close(); runner.close(); sendWatch?.close(); feed?.close(); files.close(); searchDb.close(); wss.close(); server.close(); throw error; }
  port = (server.address() as { port: number }).port;
  searchOptions.port = port;
  let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribeProjection = service.onProjection(() => {
    if (deliveryTimer) return;
    deliveryTimer = setTimeout(() => { deliveryTimer = undefined; pollObservation(refresh); }, PROJECTION_DELIVERY_MS);
  });
  let scanning = false;
  async function scan() {
    if (scanning || stopped) return;
    scanning = true;
    try { const results = await readScans(); if (!stopped) { for (const result of results) { feed.recordScan(result); sendWatch.recordScan(result); } pollObservation(refresh); } }
    catch (error) { console.error('Session scan persistence failed:', error instanceof Error ? error.message : 'Unknown failure'); }
    finally { scanning = false; }
  }
  pollObservation(refresh);
  const scanTimer = setInterval(() => { void scan(); }, SESSION_SCAN_INTERVAL_MS);
  const timer = setInterval(() => pollObservation(refresh), PROJECTION_POLL_MS);
  return {
    url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token, runner, feed, previews: files,
    resync() {
      for (const socket of clients.keys()) send(socket, { type: "resync", reason: "Projection rebuilt" });
      clients.clear();
    },
    close: async () => {
      stopped = true;
      clearInterval(timer);
      unsubscribeProjection();
      clearTimeout(deliveryTimer);
      sessionHosts.close();
      files.clearPreviews();
      files.close();
      runner.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      clearInterval(scanTimer);
      sendWatch.close();
      feed.close();
      searchDb.close();
    },
  };
}

export { WebSocket };
