import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertIsolation, writeJson } from './isolation.mjs';

const root = await assertIsolation();
const state = join(root, 'state/agent-graph');
if (process.cwd() !== state) throw new Error('Services must start in the isolated state directory');
const dbPath = join(state, 'agent-graph.db');
// macOS の Unix socket の長さ制限を避ける。両プロセスの cwd は同じ隔離先。
const socket = 'runner.sock';
const role = process.argv[2];
// E2E_CODE_ROOT があれば、試す版の作業ツリーの packages を読み込む。
const codeRoot = process.env.E2E_CODE_ROOT || resolve(import.meta.dirname, '../..');
const load = path => import(pathToFileURL(join(codeRoot, path)).href);
const cleanup = [];
let resolveStop;
const stopped = new Promise(resolve => { resolveStop = resolve; });
process.once('SIGTERM', resolveStop); process.once('SIGINT', resolveStop);

try {
  if (role === 'runner') {
    const { openLedger } = await load('packages/core/src/ledger/index.ts');
    const { serveRunner } = await load('packages/runner/src/runtime.ts');
    const ledger = openLedger(dbPath); cleanup.push(() => ledger.close());
    const runner = await serveRunner(ledger, socket);
    cleanup.push(() => runner.close());
    await writeJson(join(root, 'runner-ready.json'), { pid: process.pid, socket: join(state, socket), dbPath });
    await stopped;
  } else if (role === 'api') {
    const { openObservationService } = await load('packages/api/src/service/index.ts');
    const { startObservationWorker } = await load('packages/api/src/service/worker-client.ts');
    const { startWebSocketServer } = await load('packages/api/src/ws/index.ts');
    const { startStaticServer } = await load('packages/api/src/static/index.ts');
    const { createServeSettings } = await load('packages/api/src/ws/settings.ts');
    const { bindSettingsRequests } = await load('packages/api/src/settings/websocket.ts');
    const service = openObservationService({ dbPath, live: true, readerOnly: true });
    cleanup.push(() => service.close());
    if (process.env.E2E_PROD_GATE === '1') {
      const started = performance.now();
      const setObservation = service.setObservation;
      let completed = false;
      service.setObservation = progress => {
        setObservation(progress);
        if (!completed && (progress.state === 'failed' || progress.state === 'idle' && progress.report)) {
          completed = true;
          void writeJson(join(root, 'startup-scan.json'), { state: progress.state, elapsedMs: performance.now() - started })
            .catch(error => { console.error(error); process.exitCode = 1; resolveStop(); });
        }
      };
    }
    const observation = await startObservationWorker(service, { observe: true });
    cleanup.push(() => observation.close());
    let configured;
    const ws = await startWebSocketServer(service, { port: 0, runnerPath: socket,
      readRedactionRules: () => configured?.settings.read('config').storage.redaction ?? service.ledger.getRedactionRules() });
    cleanup.push(() => ws.close());
    configured = createServeSettings(service, { repository: process.env.E2E_PROJECT, runner: ws.runner, resync: ws.resync });
    cleanup.push(() => configured.close());
    const detach = bindSettingsRequests(ws.runner, configured.settings); cleanup.push(detach);
    await configured.settings.start();
    const dashboard = await startStaticServer({ port: Number(process.env.E2E_DASHBOARD_PORT || 0), dist: join(root, 'dist'), upstream: ws });
    cleanup.push(() => dashboard.close());
    const urls = [dashboard.url, ws.url, observation.hook.url];
    if (urls.some(value => new URL(value).hostname !== '127.0.0.1' || ['7420', '7422'].includes(new URL(value).port))) throw new Error('Unsafe listen address');
    // 本番にも隔離先にも .endpoint を作らず、偽 CLI 専用の送り先を渡す。
    await writeJson(process.env.E2E_HOOK_DESTINATION, observation.hook);
    await writeJson(join(root, 'api-ready.json'), { pid: process.pid, url: dashboard.url, api: ws.url, hook: observation.hook.url });
    observation.start();
    await Promise.race([stopped, observation.failure]);
  } else throw new Error(`Unknown role: ${role}`);
} catch (error) {
  console.error(error.stack ?? error); process.exitCode = 1;
} finally {
  const errors = [];
  for (const close of cleanup.reverse()) { try { await close(); } catch (error) { errors.push(error.message); } }
  if (errors.length) { console.error('Cleanup:', errors); process.exitCode = 1; }
}
