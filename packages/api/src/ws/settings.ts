import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { openLedger } from "../../../core/src/ledger/ledger.ts";
import type { SettingsStatus } from "../../../core/src/settings/index.ts";
import { defaultConfig, validateSettings } from "../../../core/src/settings/index.ts";
import { parseSettingsToml } from "../settings/toml.ts";
import type { DelegateRequest } from "../../../core/src/delegate/types.ts";
import { ROLES } from "../../../core/src/assign/policy.ts";
import { POLICY_HISTORY_LIMIT } from "../settings/policy-preview.ts";
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
      // SQLite が読める時差にそろえ、取り込み順によらず最近の依頼を選ぶ。
      for (const row of db.prepare(`SELECT subject, payload, source_ts FROM facts
        WHERE kind = 'delegation.created' AND payload IS NOT NULL
        ORDER BY julianday(CASE WHEN source_ts GLOB '*[+-][0-9][0-9][0-9][0-9]'
          THEN substr(source_ts, 1, length(source_ts) - 2) || ':' || substr(source_ts, -2)
          ELSE source_ts END) DESC, seq DESC`).iterate()) {
        const payload = readObject(JSON.parse(String(row.payload)));
        // 移行済みの元依頼は constraints.request にあり、除外条件もそこから復元する。
        const legacyRequest = readObject(readObject(payload.constraints).request);
        const request = { ...payload, ...legacyRequest, ...readObject(payload.request) };
        if (!ROLES.includes(request.role as DelegateRequest["role"]) || typeof request.task !== "string") continue;
        request.title = typeof request.title === "string" ? request.title : "";
        request.accept = Array.isArray(request.accept) ? request.accept : [];
        const kit = readObject(payload.kit);
        // kit は説明がないと node_id を題名に使う。人向けの確認にはその代替値を出さない。
        const description = [request.description, payload.description, request.title, payload.title, request.task, payload.task]
          .find(value => typeof value === "string" && value.trim() && value !== kit.node_id && value !== payload.request_id && value !== row.subject);
        const context = readObject(payload.context);
        const quota = readObject(context.quota);
        const performance = readObject(context.performance);
        rows.push({ id: String(payload.request_id ?? row.subject), description: typeof description === "string" ? description : "",
          timestamp: String(row.source_ts), request: request as unknown as DelegateRequest, context: {
          quota: candidate => quota[candidate.model] as ReturnType<PastDelegation["context"]["quota"]>,
          performance: (role, model) => performance[`${role}:${model}`] as ReturnType<PastDelegation["context"]["performance"]>,
          orchestratorModel: typeof context.orchestratorModel === "string" ? context.orchestratorModel : undefined,
          implementerFamily: context.implementerFamily === "anthropic" || context.implementerFamily === "openai" ? context.implementerFamily : undefined,
        } });
        if (rows.length === POLICY_HISTORY_LIMIT) break;
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
  let generation = options.runner.connectionGeneration;
  let syncing = false;
  const timer = setInterval(() => {
    const next = options.runner.available;
    const currentGeneration = options.runner.connectionGeneration;
    if (next && !syncing && (!connected || generation !== currentGeneration || Object.values(settings.readErrors()).includes("Settings application failed"))) {
      // 起動直後の hello と再接続の後にも、監視中の設定を runner へ送る。
      syncing = true;
      void (async () => {
        await settings.synchronizeRunner();
      })().then(() => { generation = currentGeneration; }).catch(() => undefined).finally(() => { syncing = false; });
    }
    connected = next;
  }, RUNNER_SETTINGS_POLL_MS);
  timer.unref();
  return { settings, close() { clearInterval(timer); settings.close(); db.close(); ledger.close(); } };
}
