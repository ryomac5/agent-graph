import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";

export type JsonRpcId = string | number | null;
export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class JsonRpcLines {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";

  private readonly output: Writable;
  private readonly onMessage: (message: JsonRpcMessage) => void;

  constructor(output: Writable, onMessage: (message: JsonRpcMessage) => void) {
    this.output = output;
    this.onMessage = onMessage;
  }

  receive(chunk: Buffer | string): void {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let end = this.pending.indexOf("\n");
    while (end >= 0) {
      const line = this.pending.slice(0, end).trim();
      this.pending = this.pending.slice(end + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line) as JsonRpcMessage);
        } catch (error) {
          if (error instanceof SyntaxError) this.error(null, -32700, "Parse error");
          else throw error;
        }
      }
      end = this.pending.indexOf("\n");
    }
  }

  send(message: JsonRpcMessage): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  request(id: Exclude<JsonRpcId, null>, method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", id, method, params });
  }

  response(id: JsonRpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  notification(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  error(id: JsonRpcId, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}
