import { createRequestId } from "../../../core/src/intake/index.ts";
import type { RunnerRequest } from "../runner-client.ts";
import type { ScreenCommand } from "./contract.ts";

export function forwardScreenCommand(message: ScreenCommand): RunnerRequest {
  const payload = message.command === "intake.submit"
    ? { ...(message.payload as object), source: "ui", requestId: createRequestId({ source: "ui", cmdId: message.cmd_id }) }
    : message.payload;
  return { type: "req", cmd_id: message.cmd_id, command: message.command, payload };
}
