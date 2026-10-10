import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export const MAX_PREVIEW_TICKETS = 200;
export interface FilesPreviewRequest { projectId: string; worktree?: string; path: string; content?: string }
export class FilesPreviewError extends Error {
  constructor(code: 'invalid_path' | 'not_previewable') { super(code); }
}
interface PreviewTicket { root: string; path: string; content?: string; expiresAt: number }

export function createPreviewApi(
  selectRoot: (request: FilesPreviewRequest) => Promise<string>,
  normalizePath: (path: string) => string,
  readFile: (root: string, path: string) => Promise<Buffer>,
) {
  const tickets = new Map<string, PreviewTicket>();
  // 発行・読み取りのたびに期限切れを除き、未使用の間も件数上限で保持量を抑える。
  function sweep(): void {
    const now = Date.now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
  }
  return {
    async preview(request: FilesPreviewRequest) {
      let root: string; let path: string; let bytes: Buffer;
      try {
        root = await selectRoot(request);
        path = normalizePath(request.path);
        bytes = await readFile(root, path);
      } catch { throw new FilesPreviewError('invalid_path'); }
      if (!['.html', '.htm'].includes(extname(path).toLowerCase())) throw new FilesPreviewError('not_previewable');
      const content = request.content === undefined ? bytes : Buffer.from(request.content);
      try { new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { throw new FilesPreviewError('not_previewable'); }
      if (content.includes(0)) throw new FilesPreviewError('not_previewable');
      sweep();
      while (tickets.size >= MAX_PREVIEW_TICKETS) tickets.delete(tickets.keys().next().value!);
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + PREVIEW_TTL_MS;
      tickets.set(ticket, { root, path, content: request.content, expiresAt });
      return { url: `/preview/${ticket}/${path.split('/').map(encodeURIComponent).join('/')}`, expiresAt };
    },
    async readPreview(ticket: string, path: string): Promise<Buffer | undefined> {
      sweep();
      const entry = tickets.get(ticket);
      if (!entry) return undefined;
      try {
        const normalized = normalizePath(path);
        const bytes = await readFile(entry.root, normalized);
        if (entry.expiresAt <= Date.now()) { tickets.delete(ticket); return undefined; }
        return normalized === entry.path && entry.content !== undefined ? Buffer.from(entry.content) : bytes;
      } catch { return undefined; }
    },
    clearPreviews() { tickets.clear(); },
  };
}
