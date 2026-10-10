import { readFile, type FilesClient, type FilesRequest, type ReadResult } from '../pages/files/model.ts';
export const FILE_POLL_MS = 5000;
export interface DocumentState { content: string; saved: string; hash: string; editable: boolean; loading: boolean; dirty: boolean; external: boolean; conflict?: ReadResult; result?: ReadResult; error?: string; state?: ReadResult['state']; saving: boolean }
export function createCodeDocument(client: FilesClient, request: FilesRequest) {
  let state: DocumentState = { content: '', saved: '', hash: '', editable: false, loading: true, dirty: false, external: false, saving: false };
  const listeners = new Set<() => void>();
  let reading: Promise<ReadResult | undefined> | undefined;
  function update(patch: Partial<DocumentState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(); }
  function adopt(result: ReadResult) {
    const content = result.state === 'text' ? result.content : '';
    update({ content, saved: content, hash: result.hash ?? '', editable: result.editable === true && result.state === 'text', state: result.state, result, dirty: false, external: false, conflict: undefined, loading: false, error: undefined });
  }
  function refresh(): Promise<ReadResult | undefined> {
    if (reading) return reading;
    if (state.saving) return Promise.resolve(state.result);
    const baseHash = state.hash;
    reading = (async () => {
      try {
        const result = await readFile(client, request);
        if (state.saving || state.hash !== baseHash) return state.result;
        if (state.loading || !state.dirty) adopt(result);
        else if (result.hash !== state.hash) update({ external: true });
        return result;
      } catch (error) { update({ loading: false, error: String(error instanceof Error ? error.message : error) }); }
      finally { reading = undefined; }
    })();
    return reading;
  }
  async function save(overwrite = false) {
    if (state.saving || !state.editable || !state.dirty) return;
    update({ saving: true, error: undefined });
    const content = state.content;
    try {
      // 上書きも最後に比べたディスクの版を基準にし、再変更は再び確認する。
      const baseHash = overwrite && state.conflict ? state.conflict.hash : state.hash;
      const ack = await client.command('files.write', { ...request, content, baseHash });
      if (!ack.ok) {
        if (ack.error === 'conflict') update({ conflict: await readFile(client, request), external: true });
        else { if (ack.error === 'not_editable') update({ editable: false }); throw new Error(ack.error ?? 'Save failed'); }
      } else {
        const result = ack.result as { hash: string };
        update({ hash: result.hash, saved: content, dirty: state.content !== content, external: false, conflict: undefined });
      }
    } catch (error) { update({ error: String(error instanceof Error ? error.message : error) }); }
    finally { update({ saving: false }); }
  }
  return {
    client, request,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    edit(content: string) { update({ content, dirty: content !== state.saved }); }, refresh, save,
    discard() { if (state.conflict) adopt(state.conflict); else update({ content: state.saved, dirty: false }); },
  };
}
export type CodeDocument = ReturnType<typeof createCodeDocument>;
