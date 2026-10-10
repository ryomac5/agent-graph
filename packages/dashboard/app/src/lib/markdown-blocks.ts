import type { Editor } from '@tiptap/react';
import type { Node } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

type Block = { start: number; end: number; nodes: Node[]; raw: string; gap: string };
type TrackedNode = { node: Node; position: number; block?: Block };

function collectNodes(doc: Node): TrackedNode[] {
  const nodes: TrackedNode[] = [];
  doc.forEach((node, position) => nodes.push({ node, position }));
  return nodes;
}

function isEmptyParagraph(node: Node): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

export class MarkdownBlocks {
  readonly blocks: Block[] = [];
  readonly readOnly: boolean;
  private tracked: TrackedNode[];
  private prefix = '';
  private trailing = '';
  private readonly newline: string;
  private readonly source: string;
  private readonly editor: Editor;

  constructor(source: string, editor: Editor) {
    this.source = source;
    this.editor = editor;
    this.newline = source.includes('\r\n') ? '\r\n' : '\n';
    this.tracked = collectNodes(editor.state.doc);
    const manager = editor.markdown!;
    // marked は改行を正規化するため、原文への文字位置の対応を別に持つ。
    const normalized = source.replace(/\r\n?/g, '\n');
    const offsets = [0];
    for (let index = 0; index < source.length; index++) {
      if (source[index] === '\r' && source[index + 1] === '\n') index++;
      offsets.push(index + 1);
    }
    const tokens = new manager.instance.Lexer(manager.instance.defaults).lex(normalized);
    let cursor = 0;
    let nodeIndex = 0;
    let unsafe = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source);
    manager.instance.walkTokens(tokens, token => {
      if (token.type === 'html' || token.type === 'image' || (token.type === 'paragraph' && /^\[\^.+\]:/m.test(token.raw))) unsafe = true;
    });
    for (const token of tokens) {
      const start = normalized.indexOf(token.raw, cursor);
      if (start < cursor) { unsafe = true; break; }
      cursor = start + token.raw.length;
      if (token.type === 'space') continue;
      const raw = token.raw.replace(/\n+$/, '');
      const parsed = editor.schema.nodeFromJSON(manager.parse(raw));
      const nodes = collectNodes(parsed).map(entry => entry.node).filter(node => !isEmptyParagraph(node));
      if (!nodes.length) { unsafe = true; break; }
      const block: Block = { start: offsets[start]!, end: offsets[start + raw.length]!, nodes: [], raw: '', gap: '' };
      block.raw = source.slice(block.start, block.end);
      for (const node of nodes) {
        while (nodeIndex < this.tracked.length && isEmptyParagraph(this.tracked[nodeIndex]!.node)) nodeIndex++;
        const entry = this.tracked[nodeIndex++];
        if (!entry || !entry.node.eq(node)) { unsafe = true; break; }
        entry.block = block;
        block.nodes.push(entry.node);
      }
      this.blocks.push(block);
    }
    if (this.tracked.slice(nodeIndex).some(entry => !isEmptyParagraph(entry.node))) unsafe = true;
    // 余分な空行も空の段落として追跡し、追加・削除を区切りへ反映する。
    for (let index = 0; index < this.tracked.length;) {
      if (this.tracked[index]!.block) { index++; continue; }
      const startIndex = index;
      while (index < this.tracked.length && !this.tracked[index]!.block) index++;
      const previous = this.tracked[startIndex - 1]?.block;
      const next = this.tracked[index]?.block;
      const gapStart = previous?.end ?? 0;
      const gapEnd = next?.start ?? source.length;
      const separators = [...source.slice(gapStart, gapEnd).matchAll(/(?:\r\n|\r|\n){2}/g)];
      const count = index - startIndex;
      for (let offset = 0; offset < count; offset++) {
        const entry = this.tracked[startIndex + offset]!;
        const separator = separators[separators.length - count + offset];
        const position = gapStart + (separator?.index ?? 0);
        const block: Block = { start: position, end: position, nodes: [entry.node], raw: '', gap: '' };
        entry.block = block;
      }
    }
    this.blocks.splice(0, this.blocks.length, ...[...new Set(this.tracked.map(entry => entry.block).filter((block): block is Block => !!block))]);
    this.prefix = source.slice(0, this.blocks[0]?.start ?? source.length);
    this.blocks.forEach((block, index) => {
      block.gap = source.slice(block.end, this.blocks[index + 1]?.start ?? source.length);
    });
    this.trailing = this.blocks.at(-1)?.gap ?? '';
    // 表示時に失われる構文だけを保護し、書式の差の大きさでは制限しない。
    this.readOnly = unsafe;
  }

  write(transaction: Transaction): string {
    if (this.readOnly) return this.source;
    const current = collectNodes(transaction.doc);
    const available = new Set(this.tracked);
    // 完全に同じ塊を先に対応させ、移動でも元の文字列を再利用する。
    for (const entry of current) {
      const previous = this.tracked.find(candidate => available.has(candidate) && candidate.node === entry.node)
        ?? this.tracked.find(candidate => available.has(candidate) && candidate.node.eq(entry.node));
      if (previous) { entry.block = previous.block; available.delete(previous); }
    }
    for (const previous of available) {
      const mapped = transaction.mapping.mapResult(previous.position, 1);
      if (mapped.deleted) continue;
      const entry = current.find(candidate => !candidate.block && candidate.position === mapped.pos);
      if (entry) entry.block = previous.block;
    }
    for (const entry of current) {
      entry.block ??= this.blocks.find(block => block.nodes.length === 1 && block.nodes[0]!.eq(entry.node));
    }
    const pieces: { raw: string; gap: string }[] = [];
    for (let index = 0; index < current.length;) {
      const entry = current[index]!;
      const block = entry.block;
      const group = [entry.node];
      index++;
      while (block && index < current.length && current[index]!.block === block) group.push(current[index++]!.node);
      const unchanged = block && group.length === block.nodes.length && group.every((node, offset) => node.eq(block.nodes[offset]!));
      const raw = unchanged ? block.raw : this.editor.markdown!.serialize({ type: 'doc', content: group.map(node => node.toJSON()) }).replace(/\n/g, this.newline);
      const nextBlock = current[index]?.block;
      const originalNext = block && this.blocks[this.blocks.indexOf(block) + 1];
      pieces.push({ raw, gap: block && nextBlock && nextBlock === originalNext ? block.gap : this.newline.repeat(2) });
    }
    this.tracked = current;
    if (!pieces.length) return '';
    return this.prefix + pieces.map((piece, index) => piece.raw + (index === pieces.length - 1 ? this.trailing : piece.gap || this.newline.repeat(2))).join('');
  }
}
