import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { classifyHistoryKind, extractHistoryKinds, identifyHistoryKind, isHistoryFlag } from '../../packages/api/src/observe/history-kinds.ts';

function createRedactedSample(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { record: '[invalid object]' };
  const sample = {};
  for (const [name, value] of Object.entries(row)) {
    if (['type', 'subtype', 'operation', 'method', 'record_type'].includes(name)) sample[name] = typeof value === 'string' ? value : '[redacted]';
    else if (isHistoryFlag(name, value)) sample[name] = typeof value === 'boolean' ? value : '[redacted]';
    else if (['attachment', 'payload'].includes(name) && value && typeof value === 'object') {
      sample[name] = { ...(typeof value.type === 'string' ? { type: value.type } : {}),
        ...(typeof value.commandMode === 'string' ? { commandMode: value.commandMode } : {}),
        ...(typeof value.origin?.kind === 'string' ? { origin: { kind: value.origin.kind, fields: '[redacted]' } } : {}),
        ...(typeof value.item?.type === 'string' ? { item: { type: value.item.type, fields: '[redacted]' } } : {}),
        ...(Array.isArray(value.content) ? { content: value.content.slice(0, 4).map(block => ({
          ...(typeof block?.type === 'string' ? { type: block.type } : {}), fields: '[redacted]',
        })) } : {}), fields: '[redacted]' };
    } else if (name === 'message' && value && typeof value === 'object') {
      sample.message = { content: Array.isArray(value.content) ? value.content.slice(0, 4).map(block => ({
        ...(typeof block?.type === 'string' ? { type: block.type } : {}), fields: '[redacted]',
      })) : '[redacted]' };
    } else if (name === 'params' && value && typeof value === 'object') {
      sample.params = { ...(typeof value.item?.type === 'string' ? { item: { type: value.item.type, fields: '[redacted]' } } : {}), fields: '[redacted]' };
    } else sample[name] = '[redacted]';
  }
  return sample;
}

export async function inventoryHistory(roots = [
  ['claude', join(homedir(), '.claude/projects')],
  ['codex', join(homedir(), '.codex/sessions')],
]) {
  const counts = new Map();
  let files = 0;
  async function visit(provider, directory) {
    if (!existsSync(directory)) throw new Error('History root is unavailable');
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(provider, path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const file = `${provider}:file-${++files}`;
        let line = 0;
        for await (const text of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
          line++;
          if (!text.trim()) continue;
          let row;
          try { row = JSON.parse(text); } catch { row = null; }
          for (const kind of extractHistoryKinds(provider, row)) {
            const key = identifyHistoryKind(kind);
            const previous = counts.get(key);
            if (previous) previous.count++;
            else counts.set(key, { kind, count: 1, first: { file, line },
              ...(!classifyHistoryKind(kind) ? { sample: createRedactedSample(row) } : {}) });
          }
        }
      }
    }
  }
  for (const [provider, root] of roots) await visit(provider, root);
  return { files, entries: [...counts.values()].sort((a, b) => identifyHistoryKind(a.kind).localeCompare(identifyHistoryKind(b.kind))) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await inventoryHistory();
    let unknown = 0;
    for (const entry of result.entries) {
      const classification = classifyHistoryKind(entry.kind);
      // ファイルは実パスでなく、この走査内の参照番号で示す。見本は種別の構造だけに限る。
      console.log(JSON.stringify({ ...entry, classification: classification?.action ?? 'unclassified' }));
      if (!classification) unknown++;
    }
    console.log(JSON.stringify({ files: result.files, kinds: result.entries.length, unclassified: unknown }));
    process.exitCode = unknown ? 1 : 0;
  } catch {
    console.error('History inventory could not finish; no history contents are printed.');
    process.exitCode = 1;
  }
}
