import { randomUUID } from "node:crypto";
import type { SettingsOptions } from "./index.ts";
import type { SettingsRequestPort } from "./websocket.ts";

// 内部のクラスは読み込まず、既存の unix ソケットの req/res だけで結ぶ。
export function createRunnerSettingsTransport(port: SettingsRequestPort, repositoryId: string): Pick<SettingsOptions, "apply" | "preflight"> {
  function createOperation(command: string): SettingsOptions["apply"] {
    return async (store, value, confirmation) => {
      const response = await port.request({ type: "req", cmd_id: `settings:${randomUUID()}`, command,
        payload: JSON.parse(JSON.stringify({ store, value, confirmation, repositoryId })) });
      const acknowledgement = command === "runner.settings.preflight" ? "valid" : "applied";
      const result = response.ok ? response.result : undefined;
      if (!result || typeof result !== "object" || Array.isArray(result) || result[acknowledgement] !== true) {
        throw new Error("Runner settings unavailable or rejected; active conversations may require confirmation");
      }
    };
  }
  return { preflight: createOperation("runner.settings.preflight"), apply: createOperation("runner.settings.apply") };
}
