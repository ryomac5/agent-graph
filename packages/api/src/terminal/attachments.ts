import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink, rmdir, lstat, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { cacheRoot, quoteShell, SSH_OPTIONS, type SshConnection, type TargetService } from '../remote/index.ts';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 30 * DAY_MS;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID = /^\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
export interface AttachmentOptions { directory?: string; now?: () => number }
export function escapeAttachmentPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9_./:-]/g, character => `\\${character}`);
}
function detectMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
}
async function listDirectory(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export function createAttachmentStore(options: AttachmentOptions = {}) {
  const directory = options.directory ?? join(cacheRoot(), 'attachments');
  const now = options.now ?? Date.now;
  async function cleanup() {
    const cutoff = now() - RETENTION_MS;
    for (const day of await listDirectory(directory)) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      const folder = join(directory, day.name);
      const expiredDay = Date.parse(day.name) + DAY_MS <= cutoff;
      for (const file of await listDirectory(folder)) {
        if (!file.isFile() || !ID.test(`${day.name}/${file.name}`)) continue;
        const path = join(folder, file.name);
        if (expiredDay || (await lstat(path)).mtimeMs < cutoff) await unlink(path);
      }
      if (!(await listDirectory(folder)).length) await rmdir(folder);
    }
  }
  const ready = cleanup();
  // 起動時の失敗は put / resolve へ返し、周期の失敗は次の日に再試行する。
  void ready.catch(() => {});
  const timer = setInterval(() => { void cleanup().catch(() => {}); }, DAY_MS);
  timer.unref();
  return {
    cleanup,
    async put(payload: unknown) {
      const p = payload as Record<string, unknown> | null;
      if (!p || Array.isArray(p) || typeof p.name !== 'string' || !p.name || p.name.length > 255
        || typeof p.mime !== 'string' || !EXTENSIONS[p.mime] || typeof p.dataBase64 !== 'string') throw new Error('Invalid attachment');
      if (p.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Attachment too large');
      if (!p.dataBase64 || p.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(p.dataBase64)) throw new Error('Invalid attachment');
      const data = Buffer.from(p.dataBase64, 'base64');
      if (data.length > MAX_IMAGE_BYTES) throw new Error('Attachment too large');
      if (data.toString('base64') !== p.dataBase64 || detectMime(data) !== p.mime) throw new Error('Invalid attachment');
      await ready;
      const attachmentId = `${new Date(now()).toISOString().slice(0, 10)}/${randomUUID()}.${EXTENSIONS[p.mime]}`;
      const path = join(directory, attachmentId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      return { attachmentId, path };
    },
    async resolve(value: unknown): Promise<string[]> {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS || value.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('Invalid attachments');
      await ready;
      return Promise.all(value.map(async id => {
        const path = join(directory, id);
        if (!(await lstat(path)).isFile()) throw new Error('Invalid attachment');
        return path;
      }));
    },
    close() { clearInterval(timer); },
  };
}
export async function uploadRemoteAttachment(targets: TargetService, connection: SshConnection, path: string): Promise<string> {
  const home = (await targets.ssh(connection, 'printf "%s" "$HOME"')).trim();
  if (!home.startsWith('/') || /[\0\r\n]/.test(home)) throw new Error('Invalid remote home');
  const remote = `${home}/.cache/agent-graph/attachments/${basename(path)}`;
  const data = await readFile(path);
  await new Promise<void>((resolve, reject) => {
    const child = targets.spawnStream('ssh', [...SSH_OPTIONS, connection.destination, '--',
      `umask 077; mkdir -p ${quoteShell(dirname(remote))} && cat > ${quoteShell(remote)}`], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.stdin!.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Attachment transfer failed')));
    child.stdin!.end(data);
  });
  return remote;
}
