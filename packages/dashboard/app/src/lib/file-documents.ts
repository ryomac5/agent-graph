import { createCodeDocument, type CodeDocument } from './code-document.ts';
import type { FilesClient, FilesRequest } from '../pages/files/model.ts';

// 接続ごとに分離し、タブを閉じても未保存の本文は保持する。
const clients = new WeakMap<FilesClient, Map<string, CodeDocument>>();
export function getFileDocument(client: FilesClient, request: FilesRequest): CodeDocument {
  let documents = clients.get(client);
  if (!documents) { documents = new Map(); clients.set(client, documents); }
  const key = JSON.stringify([request.projectId, request.worktree ?? '', request.path ?? '']);
  let document = documents.get(key);
  if (!document) { document = createCodeDocument(client, request); documents.set(key, document); }
  return document;
}
