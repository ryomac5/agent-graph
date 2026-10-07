export type Attribution = 'confirmed' | 'inferred' | 'joint' | 'unknown';
export type DiffLayout = 'unified' | 'split';
export interface DiffLine { kind: 'context' | 'add' | 'remove' | 'meta'; text: string; oldLine?: number; newLine?: number; attribution?: Attribution }
export interface DiffFile { path: string; previousPath?: string; lines: DiffLine[]; additions: number; deletions: number; attribution?: Attribution }
export interface LineLocation { file: string; side: 'old' | 'new'; startLine: number; endLine: number }
export const LARGE_FILE_LINES = 300;

function readPath(value: string): string {
  let path = value.replace(/\t.*$/, '');
  if (path.startsWith('"')) {
    try { path = JSON.parse(path) as string; } catch { /* Git の非 JSON 形式は元の表記を保つ。 */ }
  }
  return path.replace(/^[ab]\//, '');
}
// ハンクの内部では +++ / --- に似た内容も通常の追加・削除として扱う。
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const paths = text.slice(11).match(/("(?:[^"\\]|\\.)*"|\S+)/g) ?? [];
      file = { path: readPath(paths[1] ?? paths[0] ?? 'Unknown file'), lines: [], additions: 0, deletions: 0 };
      files.push(file); inHunk = false;
      continue;
    }
    if (!file && text.startsWith('--- ')) {
      file = { path: readPath(text.slice(4)), lines: [], additions: 0, deletions: 0 };
      files.push(file);
    }
    if (!file) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      file.lines.push({ kind: 'meta', text }); continue;
    }
    if (!inHunk) {
      if (text.startsWith('--- ')) file.previousPath = readPath(text.slice(4));
      else if (text.startsWith('+++ ') && text.slice(4) !== '/dev/null') file.path = readPath(text.slice(4));
      else if (text) file.lines.push({ kind: 'meta', text });
      continue;
    }
    if (text.startsWith('+')) { file.lines.push({ kind: 'add', text: text.slice(1), newLine: newLine++ }); file.additions++; }
    else if (text.startsWith('-')) { file.lines.push({ kind: 'remove', text: text.slice(1), oldLine: oldLine++ }); file.deletions++; }
    else if (text.startsWith(' ')) file.lines.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
    else if (text) file.lines.push({ kind: 'meta', text });
  }
  return files;
}

export function pairLines(lines: DiffLine[]): [DiffLine | undefined, DiffLine | undefined][] {
  const pairs: [DiffLine | undefined, DiffLine | undefined][] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'remove' || line.kind === 'add') {
      const removed: DiffLine[] = []; const added: DiffLine[] = [];
      while (lines[index]?.kind === 'remove') removed.push(lines[index++]);
      while (lines[index]?.kind === 'add') added.push(lines[index++]);
      for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) pairs.push([removed[offset], added[offset]]);
    } else { pairs.push([line, line]); index++; }
  }
  return pairs;
}

// 保存済みパッチの行を比較する。大規模な入力では共通の両端を除いた置換を表示する。
const MAX_COMPARISON_CELLS = 1_000_000;
export function comparePatches(before: string, after: string): DiffFile[] {
  if (before === after) return [];
  const old = before.split('\n'); const next = after.split('\n');
  const lines: DiffLine[] = [];
  const add = (index: number) => lines.push({ kind: 'add', text: next[index], newLine: index + 1 });
  const remove = (index: number) => lines.push({ kind: 'remove', text: old[index], oldLine: index + 1 });
  const context = (i: number, j: number) => lines.push({ kind: 'context', text: old[i], oldLine: i + 1, newLine: j + 1 });
  if (old.length * next.length <= MAX_COMPARISON_CELLS) {
    const lengths = Array.from({ length: old.length + 1 }, () => new Uint32Array(next.length + 1));
    for (let i = old.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--)
      lengths[i][j] = old[i] === next[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    let i = 0; let j = 0;
    while (i < old.length || j < next.length) {
      if (i < old.length && j < next.length && old[i] === next[j]) { context(i++, j++); }
      else if (i < old.length && (j === next.length || lengths[i + 1][j] >= lengths[i][j + 1])) remove(i++);
      else add(j++);
    }
  } else {
    let prefix = 0; let suffix = 0;
    while (prefix < Math.min(old.length, next.length) && old[prefix] === next[prefix]) { context(prefix, prefix); prefix++; }
    while (suffix < Math.min(old.length, next.length) - prefix && old.at(-suffix - 1) === next.at(-suffix - 1)) suffix++;
    for (let i = prefix; i < old.length - suffix; i++) remove(i);
    for (let j = prefix; j < next.length - suffix; j++) add(j);
    for (let k = suffix; k > 0; k--) context(old.length - k, next.length - k);
  }
  return [{ path: 'Patch comparison', lines, additions: lines.filter(line => line.kind === 'add').length, deletions: lines.filter(line => line.kind === 'remove').length }];
}
