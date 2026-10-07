import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import type { TestContext } from "node:test";
import { defaultPolicy } from "../../../../core/src/assign/policy.ts";
import type { IntakeRequest } from "../../../../core/src/intake/index.ts";
import { openLedger } from "../../../../core/src/ledger/index.ts";
import { Intake } from "../../../src/intake/index.ts";
import { FakeHost } from "../../../src/host/contract.ts";
import { McpProtocol } from "../../../src/mcp/index.ts";
import { RunnerRuntime } from "../../../src/runtime.ts";
import { RunnerProtocol } from "../../../src/socket.ts";

export function pair(): [Socket, Socket] {
  let left: Duplex;
  let right: Duplex;
  function endpoint(peer: () => Duplex): Duplex {
    return new Duplex({ read() {}, write(chunk, _encoding, callback) {
      queueMicrotask(() => { if (!peer().destroyed) peer().push(Buffer.from(chunk)); callback(); });
    }, destroy(error, callback) {
      queueMicrotask(() => peer().destroy()); callback(error);
    } });
  }
  left = endpoint(() => right); right = endpoint(() => left);
  return [left as Socket, right as Socket];
}
export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for S13");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
export function messages(stream: Duplex | PassThrough) {
  const received: any[] = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      received.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
    }
  });
  return received;
}
export function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "s13-"));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(cwd, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
  const ledger = openLedger(join(directory, "ledger.db"), { storageScope: "full_diff" });
  const host = new FakeHost("codex");
  let protocol: McpProtocol;
  const api = new RunnerProtocol((request) => intake.command(request));
  const publish = (event: Parameters<McpProtocol["publish"]>[0]) => { protocol?.publish(event); if (event) api.publish(event); };
  const runtime = new RunnerRuntime(ledger, [host], (event) => publish(event), "shared");
  const intake = new Intake(ledger, runtime, { cwd, publish,
    decision: { policy: defaultPolicy(), quota: () => undefined, performance: () => undefined } });
  protocol = new McpProtocol(intake, api);
  const request: IntakeRequest = { requestId: "sample", source: "mcp", role: "implement", title: "S13", task: "Run once", accept: ["exit 7"], cwd };
  t.after(async () => { protocol.disconnect(); api.disconnect(); await intake.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  function connect() { const [client, server] = pair(); protocol.attach(server); return { client, server }; }
  return { intake, ledger, host, protocol, request, connect, directory };
}
