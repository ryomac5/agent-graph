import { startWebSocketServer, type WebSocketOptions } from "../ws/index.ts";
import type { RunnerRequest, RunnerResponse } from "../runner-client.ts";
import type { openObservationService } from "../service/index.ts";
import type { SettingsService } from "./index.ts";

export interface SettingsRequestPort { request(request: RunnerRequest): Promise<RunnerResponse> }
// 既存の WebSocket の認証・購読・再送の口を保ち、Settings だけを api で処理する。
export function bindSettingsRequests(port: SettingsRequestPort, settings: SettingsService): () => void {
  const original = port.request;
  port.request = async (request) => {
    if (!request.command.startsWith("settings.")) return original.call(port, request);
    const { type: _type, ...response } = await settings.handle({ ...request, type: "cmd" });
    return { type: "res", ...response };
  };
  return () => { port.request = original; };
}
export async function startSettingsWebSocketServer(
  observation: ReturnType<typeof openObservationService>, settings: SettingsService, options: WebSocketOptions = {},
) {
  await settings.start();
  try {
    const server = await startWebSocketServer(observation, { ...options, port: options.port ?? settings.read("config").dashboard.port });
    const detach = bindSettingsRequests(server.runner, settings);
    return { ...server, close: async () => { detach(); settings.close(); await server.close(); } };
  } catch (error) { settings.close(); throw error; }
}
