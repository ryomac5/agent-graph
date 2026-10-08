import { compareEntries, decodeStoredValue, readObject, readText } from '../components/conversation/model.ts';
import type { DiffLine } from '../components/diff/model.ts';
import type { Row } from './store.ts';

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  changes: { tool: string; time: string; lines: DiffLine[] }[];
}

function splitContent(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
function readReplacement(input: Row): DiffLine[] {
  return [
    ...splitContent(readText(input.old_string)).map(text => ({ kind: 'remove' as const, text })),
    ...splitContent(readText(input.new_string)).map(text => ({ kind: 'add' as const, text })),
  ];
}
function findPatch(value: unknown): string {
  if (typeof value === 'string') return value.includes('*** Begin Patch') ? value : '';
  if (value && typeof value === 'object') {
    for (const part of Object.values(value)) {
      const patch = findPatch(part);
      if (patch) return patch;
    }
  }
  return '';
}
function parsePatch(patch: string): { path: string; lines: DiffLine[] }[] {
  const files: { path: string; lines: DiffLine[] }[] = [];
  let file: typeof files[number] | undefined;
  for (const text of patch.slice(patch.indexOf('*** Begin Patch')).split('\n')) {
    if (text === '*** End Patch') break;
    const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(text);
    if (header) {
      file = { path: header[1], lines: [] };
      files.push(file);
    } else if (file) {
      if (text.startsWith('+')) file.lines.push({ kind: 'add', text: text.slice(1) });
      else if (text.startsWith('-')) file.lines.push({ kind: 'remove', text: text.slice(1) });
      else if (text.startsWith(' ')) file.lines.push({ kind: 'context', text: text.slice(1) });
      else if (text.startsWith('@@') || text.startsWith('*** ')) file.lines.push({ kind: 'meta', text });
    }
  }
  return files;
}
function makeRelative(path: string, roots: string[]): string {
  for (const root of roots) {
    const prefix = root.replace(/\/+$/, '') + '/';
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  // 別の作業ツリーで変えたファイルは、プロジェクトの名前で始まるディレクトリより後ろを出す。「agent-graph-design」なども同じプロジェクトとみなす。
  const names = roots.map(root => root.replace(/\/+$/, '').split('/').at(-1)).filter(Boolean);
  const parts = path.split('/');
  for (let index = parts.length - 2; index >= 0; index--) {
    if (names.some(name => parts[index] === name || parts[index].startsWith(`${name}-`))) return parts.slice(index + 1).join('/');
  }
  return path.replace(/^\.\//, '');
}
/** ファイルを変える道具の呼び出しを含む発言か。窓から外れる発言を残すかの判断に使う。 */
export function changesFiles(row: Row): boolean {
  return collectConversationChanges([row]).length > 0;
}
/** 道具の入力に記録された変更を集める。履歴にない元の内容や置換回数は推定しない。 */
export function collectConversationChanges(messages: Row[], { cwd = '', projectRoot = '' }: { cwd?: string; projectRoot?: string } = {}): FileChange[] {
  const files = new Map<string, FileChange>();
  const entries = messages.map(row => ({ kind: 'message' as const, row, key: `message:${readText(row.id)}`,
    time: readText(row.source_ts ?? row.created_ts) })).sort(compareEntries);
  for (const { row, time } of entries) {
    const body = decodeStoredValue(row.body);
    if (!Array.isArray(body)) continue;
    for (const value of body) {
      const block = readObject(value);
      if (block.type !== 'tool_use') continue;
      const tool = readText(block.name);
      const toolName = tool.split('.').at(-1) ?? tool;
      if (['exec_command', 'shell', 'shell_command', 'Bash', 'NotebookEdit'].includes(toolName)) continue;
      const input = readObject(block.input);
      let changes: { path: string; lines: DiffLine[] }[];
      if (tool === 'Edit') changes = [{ path: readText(input.file_path), lines: readReplacement(input) }];
      else if (tool === 'Write') changes = [{ path: readText(input.file_path), lines: splitContent(readText(input.content)).map(text => ({ kind: 'add', text })) }];
      else if (tool === 'MultiEdit') changes = [{ path: readText(input.file_path), lines: Array.isArray(input.edits) ? input.edits.flatMap(edit => readReplacement(readObject(edit))) : [] }];
      else changes = parsePatch(findPatch(decodeStoredValue(block.input)));
      for (const change of changes) {
        if (!change.path) continue;
        const path = makeRelative(change.path, [cwd, projectRoot].filter(Boolean));
        const file = files.get(path) ?? { path, additions: 0, deletions: 0, changes: [] };
        file.additions += change.lines.filter(line => line.kind === 'add').length;
        file.deletions += change.lines.filter(line => line.kind === 'remove').length;
        file.changes.push({ tool, time, lines: change.lines });
        files.set(path, file);
      }
    }
  }
  // プロジェクトの中のファイルを先に、外の一時的なファイルを後に並べる。
  return [...files.values()].toSorted((a, b) => Number(a.path.startsWith('/')) - Number(b.path.startsWith('/')));
}
