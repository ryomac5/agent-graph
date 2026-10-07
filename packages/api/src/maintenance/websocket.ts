import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { BUSY_TIMEOUT_MS } from '../../../core/src/ledger/ledger.ts';
import { startWebSocketServer, type WebSocketOptions } from '../ws/index.ts';
import type { openObservationService } from '../service/index.ts';
import { MaintenanceService, bindMaintenanceRequests } from './index.ts';

export async function startMaintenanceWebSocketServer(
  observation: ReturnType<typeof openObservationService>, options: WebSocketOptions & { blobsPath?: string } = {},
) {
  const db = new DatabaseSync(observation.dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA secure_delete = ON`);
  try {
    // readerOnly のキャッシュにも、整理後の世代を即座に伝える。
    const readState = db.prepare('SELECT last_seq, generation FROM projection_state WHERE id = 1');
    const server = await startWebSocketServer({ ...observation, catchUp: () => {
      const state = observation.catchUp();
      const stored = readState.get()!;
      return { ...state, last_seq: Number(stored.last_seq), generation: Number(stored.generation) };
    } }, options);
    const maintenance = new MaintenanceService({ db, blobsPath: options.blobsPath ?? join(dirname(observation.dbPath), 'blobs') });
    const detach = bindMaintenanceRequests(server.runner, maintenance);
    return { ...server, maintenance, close: async () => {
      detach();
      try { await server.close(); } finally { db.close(); }
    } };
  } catch (error) { db.close(); throw error; }
}
