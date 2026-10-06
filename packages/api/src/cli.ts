#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startHookServer } from "./hook/index.ts";
import { migrateLegacyDatabases } from "./migrate/index.ts";
import { OBSERVATION_POLL_MS, openObservationService, PROJECTION_POLL_MS } from "./service/index.ts";
import { pollObservation } from "./service/poll.ts";

const HELP = "Usage: agent-graph-api ingest --once | migrate --from <path> | rebuild | serve [--db <path>] [--port <port>]";

function listDatabases(path: string, excludedPaths: Set<string>): string[] {
  if (statSync(path).isFile()) return excludedPaths.has(realpathSync(path)) ? [] : [path];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith(".migration-backups") && entry.name !== "migration-backups"
      && entry.name !== "outbox") return listDatabases(child, excludedPaths);
    return entry.isFile() && /\.(db|sqlite|sqlite3)$/.test(entry.name) && !excludedPaths.has(realpathSync(child)) ? [child] : [];
  });
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...flags] = args;
  if (command === "--help" || command === "-h") { console.log(HELP); return; }
  if (!["ingest", "migrate", "rebuild", "serve"].includes(command)) throw new TypeError(HELP);
  let dbPath: string | undefined;
  let from: string | undefined;
  let port = 0;
  let once = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--once" && command === "ingest") { once = true; continue; }
    if (!["--db", "--db-path", "--state-dir", "--from", "--port"].includes(flag)) throw new TypeError(`Unknown option: ${flag}`);
    const value = flags[++index];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${flag}`);
    if (flag === "--db" || flag === "--db-path") dbPath = resolve(value);
    else if (flag === "--state-dir") dbPath = join(resolve(value), "agent-graph.db");
    else if (flag === "--from" && command === "migrate") from = resolve(value);
    else if (flag === "--port" && command === "serve") {
      port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError("Invalid port");
    } else throw new TypeError(`Option ${flag} is not available for ${command}`);
  }
  if (command === "ingest" && !once) throw new TypeError("ingest requires --once");
  if (command === "migrate" && !from) throw new TypeError("migrate requires --from <path>");
  const service = openObservationService({ dbPath });
  try {
    if (command === "ingest") console.log(JSON.stringify(service.ingestOnce()));
    else if (command === "rebuild") console.log(JSON.stringify(service.rebuild()));
    else if (command === "migrate") {
      const destination = realpathSync(service.dbPath);
      const paths = listDatabases(from!, new Set([destination, `${destination}-wal`, `${destination}-shm`]));
      if (paths.length === 0) throw new TypeError("No legacy databases found");
      const report = await migrateLegacyDatabases(paths, service.ledger, { backupDirectory: join(service.dbPath + ".migration-backups") });
      service.catchUp();
      console.log(JSON.stringify(report));
    } else {
      const report = pollObservation(() => service.ingestOnce());
      const hook = await startHookServer(service.ledger, port);
      const endpoint = join(service.outbox, ".endpoint");
      let observationTimer: ReturnType<typeof setInterval> | undefined;
      let projectionTimer: ReturnType<typeof setInterval> | undefined;
      let stop: () => void = () => {};
      try {
        mkdirSync(service.outbox, { recursive: true, mode: 0o700 });
        const temporary = join(service.outbox, `.endpoint-${process.pid}.tmp`);
        const destination = JSON.stringify({ url: hook.url, token: hook.token });
        writeFileSync(temporary, destination, { mode: 0o600 });
        renameSync(temporary, endpoint);
        console.log(JSON.stringify({ ...report, hook_url: hook.url, hook_endpoint_file: endpoint, db: service.dbPath }));
        await new Promise<void>((resolveStop, reject) => {
          stop = resolveStop;
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          const poll = (action: () => unknown) => {
            try { pollObservation(action); } catch (error) { reject(error); }
          };
          observationTimer = setInterval(() => poll(() => service.ingestOnce()), OBSERVATION_POLL_MS);
          projectionTimer = setInterval(() => poll(() => service.catchUp()), PROJECTION_POLL_MS);
        });
      } finally {
        clearInterval(observationTimer);
        clearInterval(projectionTimer);
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await hook.close();
        try {
          if (JSON.parse(readFileSync(endpoint, "utf8")).token === hook.token) unlinkSync(endpoint);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
    }
  } finally { service.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
