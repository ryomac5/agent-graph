import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, utimes, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { createAttachmentStore, MAX_IMAGE_BYTES, RETENTION_MS, DAY_MS, escapeAttachmentPath, uploadRemoteAttachment } from '../src/terminal/attachments.ts';
import { createTargetService } from '../src/remote/index.ts';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const payload = { name: '../image.png', mime: 'image/png', dataBase64: png.toString('base64') };

test('put validates MIME, signatures, base64 and size and stores an opaque path under the cache', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-attachment-'));
  const store = createAttachmentStore({ directory, now: () => Date.parse('2026-10-11T12:00:00Z') });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  for (const p of [{ ...payload, mime: 'image/jpeg' }, { ...payload, mime: 'image/svg+xml' }, { ...payload, dataBase64: 'abcd!' }, { ...payload, dataBase64: Buffer.from('not an image').toString('base64') }]) await assert.rejects(store.put(p), /Invalid attachment/);
  await assert.rejects(store.put({ ...payload, dataBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }), /too large/);
  const result = await store.put(payload);
  assert.match(result.attachmentId, /^2026-10-11\/[0-9a-f-]+\.png$/);
  assert.equal(result.path, join(directory, result.attachmentId));
  assert.deepEqual(await readFile(result.path), png);
  assert.deepEqual(await store.resolve([result.attachmentId]), [result.path]);
  for (const ids of [['../evil.png'], Array(9).fill(result.attachmentId), [123], 'path']) await assert.rejects(store.resolve(ids), /Invalid attachments/);
  const reopened = createAttachmentStore({ directory }); t.after(() => reopened.close());
  assert.deepEqual(await reopened.resolve([result.attachmentId]), [result.path]);
  for (const [mime, data, extension] of [['image/jpeg', Buffer.from([255,216,255]), 'jpg'], ['image/gif', Buffer.from('GIF89a'), 'gif'], ['image/webp', Buffer.from('RIFF1234WEBP'), 'webp']] as const) {
    const stored = await store.put({ name: 'image', mime, dataBase64: data.toString('base64') });
    assert.ok(stored.path.endsWith(`.${extension}`));
  }
  const max = Buffer.alloc(MAX_IMAGE_BYTES); png.copy(max);
  await store.put({ ...payload, dataBase64: max.toString('base64') });
});

test('startup and daily cleanup delete only stored images older than 30 days', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-attachment-clean-'));
  const now = Date.now();
  const folder = join(directory, '2026-01-01'); await mkdir(folder);
  const old = join(folder, '12345678-1234-1234-1234-123456789abc.png');
  await writeFile(old, png); await utimes(old, (now - RETENTION_MS - DAY_MS) / 1000, (now - RETENTION_MS - DAY_MS) / 1000);
  const unknown = join(folder, 'keep.txt'); await writeFile(unknown, 'keep');
  let time = now;
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = createAttachmentStore({ directory, now: () => time });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const recent = await store.put(payload);
  await assert.rejects(readFile(old), { code: 'ENOENT' });
  assert.equal(await readFile(unknown, 'utf8'), 'keep');
  time += RETENTION_MS + DAY_MS;
  t.mock.timers.tick(DAY_MS);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await readFile(recent.path); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT'); return; }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Daily cleanup did not remove the expired attachment');
});

test('paste paths escape spaces, quotes and shell symbols without outer quotes', () => {
  assert.equal(escapeAttachmentPath('/a b/"x\'$();&[].png'), '/a\\ b/\\"x\\\'\\$\\(\\)\\;\\&\\[\\].png');
});

test('SSH streams image bytes to a quoted remote path and checks transfer failures', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-attachment-ssh-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'image.png'); await writeFile(path, png);
  const calls: { file: string; args: string[] }[] = [];
  let code = 0;
  let bytes = Buffer.alloc(0);
  const spawnStream = ((file: string, args: string[]) => {
    calls.push({ file, args }); const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
    child.stdin = new PassThrough(); child.stdin.on('data', data => { bytes = Buffer.concat([bytes, data]); });
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', code))); return child;
  }) as unknown as typeof spawn;
  const targets = createTargetService(async () => '/repo', { execute: async () => '/home/a b', spawnStream });
  const connection = { id: 's', name: 'Server', destination: 'dev@host', projects: [] };
  assert.equal(await uploadRemoteAttachment(targets, connection, path), '/home/a b/.cache/agent-graph/attachments/image.png');
  assert.equal(calls[0].file, 'ssh'); assert.ok(calls[0].args.includes('dev@host'));
  assert.equal(calls[0].args.at(-1), "umask 077; mkdir -p '/home/a b/.cache/agent-graph/attachments' && cat > '/home/a b/.cache/agent-graph/attachments/image.png'");
  assert.deepEqual(bytes, png);
  code = 1; await assert.rejects(uploadRemoteAttachment(targets, connection, path), /transfer failed/);
});

test('default attachment location follows XDG_CACHE_HOME', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-attachment-xdg-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = directory;
  const store = createAttachmentStore();
  try {
    const result = await store.put(payload);
    assert.equal(result.path, join(directory, 'agent-graph', 'attachments', result.attachmentId));
  } finally {
    store.close();
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  }
});
