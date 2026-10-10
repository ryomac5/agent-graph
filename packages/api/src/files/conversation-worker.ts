import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { createLocalCommitConversationIndex } from './conversations.ts';

// 本文の走査は要求を処理するスレッドから分離し、接続も読み取り専用にする。
const db = new DatabaseSync(workerData, { readOnly: true });
const index = createLocalCommitConversationIndex(db, (evidence, state) => parentPort!.postMessage({ evidence, state }), true);
parentPort!.on('message', () => { index.close(); db.close(); parentPort!.close(); });
