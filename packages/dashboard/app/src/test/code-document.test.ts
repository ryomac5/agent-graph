import { expect, it, vi } from 'vitest';
import { createCodeDocument } from '../lib/code-document.ts';
import type { Ack } from '../lib/client.ts';
function fixture(editable = true) {
  let content = 'original', hash = 'h1', conflict = false;
  const client = { command: vi.fn(async (name: string, payload?: unknown): Promise<Ack> => {
    if (name === 'files.write') { const p = payload as { content: string; baseHash: string }; if (conflict || p.baseHash !== hash) return { type: 'ack', cmd_id: 'id', ok: false, error: 'conflict' }; content = p.content; hash = 'saved'; }
    return { type: 'ack', cmd_id: 'id', ok: true, result: { worktree: '/repo', path: 'a.ts', state: 'text', content, hash, editable } };
  }) };
  const document = createCodeDocument(client, { projectId: 'p', path: 'a.ts', worktree: '/repo' });
  return { document, client, change: (next: string) => { content = next; hash = next; }, conflict: (value: boolean) => { conflict = value; } };
}
it('saves edits with their base hash and clears the dirty mark', async () => {
  const { document, client } = fixture(); await document.refresh(); document.edit('edited'); await document.save();
  expect(client.command).toHaveBeenLastCalledWith('files.write', { projectId: 'p', worktree: '/repo', path: 'a.ts', content: 'edited', baseHash: 'h1' });
  expect(document.getSnapshot()).toMatchObject({ dirty: false, hash: 'saved', saved: 'edited' });
});
it('loads a conflict, preserves edits, overwrites against the compared version, and can discard', async () => {
  const f = fixture(); await f.document.refresh(); f.document.edit('mine'); f.change('disk'); await f.document.save();
  expect(f.document.getSnapshot()).toMatchObject({ content: 'mine', dirty: true, conflict: { content: 'disk' } });
  await f.document.save(true); expect(f.client.command).toHaveBeenLastCalledWith('files.write', expect.objectContaining({ baseHash: 'disk', content: 'mine' }));
  f.document.edit('again'); f.change('new disk'); await f.document.save(); f.document.discard();
  expect(f.document.getSnapshot()).toMatchObject({ content: 'new disk', dirty: false, conflict: undefined });
});
it('silently reloads clean files but marks external changes on edited files', async () => {
  const f = fixture(); await f.document.refresh(); f.change('external'); await f.document.refresh();
  expect(f.document.getSnapshot().content).toBe('external'); f.document.edit('mine'); f.change('later'); await f.document.refresh();
  expect(f.document.getSnapshot()).toMatchObject({ content: 'mine', external: true });
});
it('does not write read-only files and keeps edits typed while saving', async () => {
  const readonly = fixture(false); await readonly.document.refresh(); readonly.document.edit('ignored'); await readonly.document.save();
  expect(readonly.client.command.mock.calls.map(call => call[0])).toEqual(['files.read']);
  const f = fixture(); await f.document.refresh(); f.document.edit('first'); const pending = f.document.save(); f.document.edit('second'); await pending;
  expect(f.document.getSnapshot()).toMatchObject({ saved: 'first', content: 'second', dirty: true });
});
