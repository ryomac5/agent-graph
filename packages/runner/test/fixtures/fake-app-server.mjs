import { createInterface } from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const log = process.env.FAKE_APP_SERVER_LOG;
const threads = new Map();
const approvals = new Map();
let nextThread = 0;
let nextTurn = 0;
let nextApproval = 0;
let initialized = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const notify = (method, params) => send({ method, params });
const status = (threadId, type, activeFlags = []) => notify("thread/status/changed", { threadId, status: { type, activeFlags } });
function complete(threadId, turnId, text) {
  notify("item/agentMessage/delta", { threadId, turnId, itemId: `${turnId}-final`, delta: text });
  notify("item/completed", { threadId, turnId, item: { id: `${turnId}-comment`, type: "agentMessage", text: "Working", phase: "commentary" } });
  notify("item/completed", { threadId, turnId, item: { id: `${turnId}-final`, type: "agentMessage", text, phase: "final_answer" } });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
  status(threadId, "idle");
}
if (process.env.FAKE_APP_SERVER_DESCENDANT) {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
  appendFileSync(log, JSON.stringify({ descendantPid: child.pid }) + "\n");
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(message) + "\n");
  if (!message.method) {
    const approval = approvals.get(message.id);
    if (!approval) return;
    approvals.delete(message.id);
    notify("serverRequest/resolved", { threadId: approval.threadId, requestId: message.id });
    complete(approval.threadId, approval.turnId, message.error ? "ERROR-REPLIED"
      : message.result.decision === "accept" || message.result.decision?.acceptWithExecpolicyAmendment ? "APPROVED" : "DENIED");
    return;
  }
  const p = message.params ?? {};
  const result = (value) => send({ id: message.id, result: value });
  if (message.method === "initialize") { result({ userAgent: "fake" }); return; }
  if (message.method === "initialized") { initialized = true; return; }
  if (!initialized) { send({ id: message.id, error: { code: -32000, message: "Not initialized" } }); return; }
  switch (message.method) {
    case "thread/start":
    case "thread/resume":
    case "thread/fork": {
      let id = p.threadId;
      if (message.method !== "thread/resume") {
        do { id = `thread-${++nextThread}`; } while (threads.has(id));
      }
      threads.set(id, { id, ephemeral: p.ephemeral, model: p.model, status: { type: "idle" } });
      // 開始応答より先の通知も再現する。
      status(id, "idle");
      result({ thread: { ...threads.get(id), ...(message.method === "thread/fork" ? { forkedFromId: p.threadId } : {}) } });
      break;
    }
    case "turn/start": {
      const turnId = `turn-${process.pid}-${++nextTurn}`;
      const threadId = p.threadId;
      threads.get(threadId).turnId = turnId;
      const text = p.input[0].text;
      if (text !== "early-completion") result({ turn: { id: turnId, status: "inProgress" } });
      notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      status(threadId, "active");
      if (text === "early-completion") {
        complete(threadId, turnId, text);
        result({ turn: { id: turnId, status: "inProgress" } });
        return;
      }
      setTimeout(() => {
        if (text === "crash") {
          process.exit(1);
        } else if (text === "late-approval") {
          const id = nextApproval++;
          approvals.set(id, { threadId, turnId });
          send({ id, method: "item/commandExecution/requestApproval",
            params: { threadId: threads.keys().next().value, turnId: "closed-turn", availableDecisions: ["accept"] } });
        } else if (text === "failed-turn") {
          notify("turn/completed", { threadId, turn: { id: turnId, status: "failed", error: { message: "Turn failed" } } });
          status(threadId, "idle");
        } else if (text === "approval" || text === "file-approval" || text === "amendment-approval") {
          const id = nextApproval++;
          approvals.set(id, { threadId, turnId });
          status(threadId, "active", ["waitingOnApproval"]);
          send({ id, method: text === "file-approval" ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval",
            params: { threadId, turnId, itemId: `exec-${id}`, command: "sleep 2",
              availableDecisions: ["accept", ...(text === "amendment-approval"
                ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["sleep", "2"] } }] : []), "cancel"] } });
        } else if (text === "states") {
          status(threadId, "active", ["waitingOnUserInput"]);
          status(threadId, "notLoaded");
          status(threadId, "systemError");
        } else if (text === "S19") {
          const sample = readFileSync(new URL("../samples/S19/events.jsonl", import.meta.url), "utf8");
          for (const line of sample.trim().split("\n")) {
            const event = JSON.parse(line.replaceAll("PARENT_TURN", turnId).replaceAll("PARENT", threadId));
            send(event);
          }
          complete(threadId, turnId, "PARENT-OK");
        } else if (text !== "hold") complete(threadId, turnId, text);
      }, 15);
      break;
    }
    case "turn/interrupt":
      result({});
      notify("turn/completed", { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted" } });
      status(p.threadId, "idle");
      break;
    case "model/list": result({ data: [{ model: "fake", displayName: "Fake", defaultReasoningEffort: "low" }], nextCursor: null }); break;
    default: send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
  }
}).on("close", () => process.exit(0));
