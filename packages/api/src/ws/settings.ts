import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { openLedger } from "../../../core/src/ledger/ledger.ts";
import type { SettingsStatus } from "../../../core/src/settings/index.ts";
import { defaultConfig, validateSettings } from "../../../core/src/settings/index.ts";
import { parseSettingsToml } from "../settings/toml.ts";
import type { DelegateRequest } from "../../../core/src/delegate/types.ts";
import { SettingsService, settingsPaths, type KeychainPort, type PastDelegation } from "../settings/index.ts";
import { createKeychain } from "../settings/keychain.ts";
import { createRunnerSettingsTransport } from "../settings/runner.ts";
import { RUNNER_PROTOCOL_VERSION, type RunnerClient } from "../runner-client.ts";
import type { openObservationService } from "../service/index.ts";
const RUNNER_SETTINGS_POLL_MS = 500;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function readServePort(repository: string): number {
  try { return validateSettings("config", parseSettingsToml(readFileSync(settingsPaths(repository).config, "utf8"))).dashboard.port; }
  catch { return defaultConfig().dashboard.port; }
}

export function createServeSettings(observation: ReturnType<typeof openObservationService>, options: {
  repository: string; runner: RunnerClient; keychain?: KeychainPort; resync(): void;
}) {
  // serve の観測台帳は読み取り専用。設定の事実には専用の書き込み接続を使う。
  const ledger = openLedger(observation.dbPath);
  const db = new DatabaseSync(observation.dbPath, { readOnly: true });
  const transport = createRunnerSettingsTransport(options.runner, options.repository);
  async function request(command: string, payload?: { provider: string }) {
    const response = await options.runner.request({ type: "req", cmd_id: randomUUID(), command, payload });
    if (!response.ok) throw new Error("Runner unavailable");
    return response.result;
  }
  const settings = new SettingsService({
    paths: settingsPaths(options.repository), ledger, keychain: options.keychain ?? createKeychain(),
    ...transport,
    history() {
      const rows: PastDelegation[] = [];
      for (const row of db.prepare("SELECT subject, payload FROM facts WHERE kind = 'delegation.created' AND payload IS NOT NULL ORDER BY seq").iterate()) {
        const payload = readObject(JSON.parse(String(row.payload)));
        const request = readObject(payload.request);
        if (typeof request.role !== "string" || typeof request.task !== "string" || !Array.isArray(request.accept)) continue;
        const context = readObject(payload.context);
        const quota = readObject(context.quota);
        const performance = readObject(context.performance);
        rows.push({ id: String(payload.request_id ?? row.subject), request: request as unknown as DelegateRequest, context: {
          quota: candidate => quota[candidate.model] as ReturnType<PastDelegation["context"]["quota"]>,
          performance: (role, model) => performance[`${role}:${model}`] as ReturnType<PastDelegation["context"]["performance"]>,
          orchestratorModel: typeof context.orchestratorModel === "string" ? context.orchestratorModel : undefined,
          implementerFamily: context.implementerFamily === "anthropic" || context.implementerFamily === "openai" ? context.implementerFamily : undefined,
        } });
      }
      return rows;
    },
    async status() {
      const connected = options.runner.available;
      const response = connected ? readObject(await request("status")) : {};
      const hosts = readObject(response.hosts);
      function readHost(provider: string): SettingsStatus["hosts"]["claude"] {
        const host = readObject(hosts[provider]);
        const authentication = readObject(host.authentication);
        return { state: host.state === "ready" || host.state === "unavailable" ? host.state : "unknown",
          version: typeof host.version === "string" ? host.version : null,
          authentication: typeof authentication.type === "string" ? authentication.type : typeof authentication.subscriptionType === "string" ? authentication.subscriptionType : null,
          degraded: Array.isArray(host.degraded) ? host.degraded.filter((value): value is string => typeof value === "string") : [] };
      }
      return { hosts: { claude: readHost("claude"), codex: readHost("codex") },
        connection: { runner: connected, protocolVersion: RUNNER_PROTOCOL_VERSION, apiVersion: "2", updatePending: response.updatePending === true },
        observation: { formats: ["claude-jsonl", "codex-legacy", "codex-jsonl", "kit"], unsupportedCount: Number(db.prepare("SELECT count(*) AS count FROM facts WHERE kind = 'observation.unsupported'").get()!.count) },
        rebuild: { state: "idle", completed: 0, total: 0 },
        logs: { api: join(dirname(observation.dbPath), "api.log"), runner: join(dirname(observation.dbPath), "runner.log") } };
    },
    listModels: provider => request("list_models", { provider }),
    async rebuild(progress) {
      const total = Number(db.prepare("SELECT count(*) AS count FROM facts").get()!.count);
      progress(0, total);
      await new Promise<void>(resolve => setImmediate(resolve));
      observation.rebuild();
      progress(total, total);
    }, resync: options.resync,
  });
  let connected = options.runner.available;
  const timer = setInterval(() => {
    const next = options.runner.available;
    if (next && !connected) {
      // 起動直後の hello と再接続の後にも、監視中の設定を runner へ送る。
      void (async () => {
        for (const store of ["config", "policy", "project"] as const) {
          await settings.reload(store);
          await transport.apply(store, settings.read(store), false);
        }
      })().catch(() => undefined);
    }
    connected = next;
  }, RUNNER_SETTINGS_POLL_MS);
  timer.unref();
  return { settings, close() { clearInterval(timer); settings.close(); db.close(); ledger.close(); } };
}
