import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const RPC_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 1000;
const TERMINATE_GRACE_MS = 100;

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}
export interface ServerOptions {
  executable?: string;
  executableArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  rpcTimeoutMs?: number;
}

export class AppServer {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 0;
  private ended = false;
  private closed: Promise<void>;
  private stopping?: Promise<void>;
  private timeout: number;

  constructor(options: ServerOptions, receive: (message: RpcMessage) => void, exit: (code: number, cause?: string) => void) {
    this.timeout = options.rpcTimeoutMs ?? RPC_TIMEOUT_MS;
    this.child = spawn(options.executable ?? "codex", [...options.executableArgs ?? [], "app-server", "--listen", "stdio://"], {
      cwd: options.cwd, env: { ...process.env, ...options.env, AGENT_GRAPH_MANAGED: "1" },
      stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => {
      this.fail(new Error(`app-server closed: ${code}/${signal}`));
      exit(code ?? 1, signal ?? undefined);
      resolve();
    }));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const message: RpcMessage = JSON.parse(line);
        if (!message || typeof message !== "object") throw new Error("Invalid app-server frame");
        if (message.method) receive(message);
        else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        void this.stop();
      }
    });
  }
  private fail(error: Error): void {
    this.ended = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  write(message: RpcMessage): void {
    if (this.ended || this.stopping) throw new Error("app-server is closed");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.ended || this.stopping) return Promise.reject(new Error("app-server is closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  stop(): Promise<void> { return this.stopping ??= this.stopProcess(); }
  private async stopProcess(): Promise<void> {
    this.child.stdin.end();
    await waitOrClose(this.closed, SHUTDOWN_GRACE_MS);
    // 専用のプロセス群を止め、サーバー終了後の道具の子孫も残さない。
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (this.child.pid) {
        try {
          if (process.platform === "win32") this.child.kill(signal);
          else process.kill(-this.child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      if (signal === "SIGTERM") await waitOrClose(new Promise<void>(() => {}), TERMINATE_GRACE_MS);
    }
    await this.closed;
  }
}

async function waitOrClose(closed: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
  clearTimeout(timer);
}
