import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import { createMarkdownExtensions } from '../lib/markdown-editor.ts';
import { MarkdownBlocks } from '../lib/markdown-blocks.ts';
import { MarkdownDocument } from '../components/files/MarkdownDocument.tsx';
import { createCodeDocument } from '../lib/code-document.ts';

function open(source: string) {
  const editor = new Editor({ extensions: createMarkdownExtensions(), content: source, contentType: 'markdown', injectCSS: false });
  const blocks = new MarkdownBlocks(source, editor);
  let written = source;
  editor.on('update', ({ transaction }) => { written = blocks.write(transaction); });
  return { editor, blocks, read: () => written };
}

it('changes only a paragraph when a word is appended, including repeated edits and undo', () => {
  const source = '# Title #\n\nFirst line\nsecond line\n\n* keep\n* format\n\n~~~js\nconst x = 1\n~~~\n';
  const f = open(source);
  expect(f.blocks.readOnly).toBe(false);
  const block = f.blocks.blocks[1]!;
  let position = 0;
  f.editor.state.doc.forEach((node, offset) => { if (node === block.nodes[0]) position = offset + node.nodeSize - 1; });
  f.editor.commands.insertContentAt(position, ' word');
  expect(f.read()).toBe(source.replace('second line', 'second line word'));
  f.editor.commands.insertContentAt(position + 5, ' again');
  expect(f.read()).toBe(source.replace('second line', 'second line word again'));
  f.editor.commands.undo();
  expect(f.read()).toBe(source);
  f.editor.destroy();
});

it('changes only table lines when a cell is edited', () => {
  const source = '# Title #\n\n| Name | Value |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |\n\n* keep\n* format\n';
  const f = open(source);
  let position = 0;
  f.editor.state.doc.descendants((node, offset) => { if (node.isText && node.text === '1') position = offset; });
  f.editor.commands.insertContentAt({ from: position, to: position + 1 }, '3');
  const table = f.read().slice(source.indexOf('|'), f.read().indexOf('\n\n*'));
  expect(table).toContain('3');
  expect(f.read()).toBe('# Title #\n\n' + table + '\n\n* keep\n* format\n');
  f.editor.destroy();
});

it('adds, deletes and reorders blocks while keeping unchanged source text', () => {
  const f = open('# Title #\n\n* keep\n* format\n\nLast paragraph\n');
  const headingSize = f.editor.state.doc.firstChild!.nodeSize;
  f.editor.commands.insertContentAt(headingSize, { type: 'paragraph', content: [{ type: 'text', text: 'Added' }] });
  expect(f.read()).toBe('# Title #\n\nAdded\n\n* keep\n* format\n\nLast paragraph\n');
  f.editor.commands.deleteRange({ from: headingSize, to: headingSize + f.editor.state.doc.child(1).nodeSize });
  expect(f.read()).toBe('# Title #\n\n* keep\n* format\n\nLast paragraph\n');
  const nodes = f.editor.state.doc.content;
  const transaction = f.editor.state.tr.replaceWith(0, nodes.size, [nodes.child(2), nodes.child(0), nodes.child(1)]);
  f.editor.view.dispatch(transaction);
  expect(f.read()).toBe('Last paragraph\n\n# Title #\n\n* keep\n* format\n');
  const headingPosition = f.editor.state.doc.child(0).nodeSize;
  f.editor.commands.deleteRange({ from: headingPosition, to: headingPosition + f.editor.state.doc.child(1).nodeSize });
  expect(f.read()).toBe('Last paragraph\n\n* keep\n* format\n');
  f.editor.destroy();
});

it.each(['\n', '\r\n'])('preserves blank paragraphs and %j newlines across edits', newline => {
  const source = ['# Title #', '', '', '', 'Paragraph', '', '~~~html', '<div>example</div>', '~~~', ''].join(newline);
  const f = open(source);
  expect(f.blocks.readOnly).toBe(false);
  let position = 0;
  f.editor.state.doc.forEach((node, offset) => { if (node.textContent === 'Paragraph') position = offset + node.nodeSize - 1; });
  f.editor.commands.insertContentAt(position, ' word');
  expect(f.read()).toBe(source.replace('Paragraph', 'Paragraph word'));
  const blankPosition = f.editor.state.doc.firstChild!.nodeSize;
  const blankSize = f.editor.state.doc.child(1).nodeSize;
  f.editor.commands.deleteRange({ from: blankPosition, to: blankPosition + blankSize });
  expect(f.read()).toBe(source.replace(newline.repeat(4), newline.repeat(2)).replace('Paragraph', 'Paragraph word'));
  f.editor.destroy();
});

it('splits and joins paragraphs without changing other blocks', () => {
  const f = open('# Title #\n\nOne two\n\n* keep\n* format\n');
  const position = f.editor.state.doc.firstChild!.nodeSize + 5;
  f.editor.commands.setTextSelection(position);
  f.editor.commands.splitBlock();
  expect(f.read()).toBe('# Title #\n\nOne \n\ntwo\n\n* keep\n* format\n');
  f.editor.commands.joinBackward();
  expect(f.read()).toBe('# Title #\n\nOne two\n\n* keep\n* format\n');
  f.editor.destroy();
});

it('permits leading horizontal rules and protects front matter and unsupported syntax', () => {
  for (const source of ['---\n\nParagraph\n', '~~~md\n![example](image.png)\n[^note]: example\n~~~\n']) {
    const f = open(source);
    expect(f.blocks.readOnly).toBe(false);
    f.editor.destroy();
  }
  for (const source of ['---\ntitle: Example\n---\n\nParagraph', 'Text ![image](image.png)', 'Inline <b>HTML</b>']) {
    const f = open(source);
    expect(f.blocks.readOnly).toBe(true);
    f.editor.destroy();
  }
});

it('audits one-word paragraph edits in every repository Markdown file and untouched saves', async () => {
  const root = '../..';
  const paths = ['README.md', ...readdirSync(`${root}/docs/agents`).filter(name => name.endsWith('.md')).sort().map(name => `docs/agents/${name}`)];
  const temporary = mkdtempSync(join(tmpdir(), 'markdown-roundtrip-'));
  try {
    for (const path of paths) {
      const source = readFileSync(`${root}/${path}`, 'utf8');
      const f = open(source);
      expect(f.blocks.readOnly, path).toBe(false);
      const block = f.blocks.blocks.find(block => block.nodes.length === 1 && block.nodes[0]!.type.name === 'paragraph')!;
      expect(block, path).toBeTruthy();
      let position = 0;
      f.editor.state.doc.forEach((node, offset) => { if (node === block.nodes[0]) position = offset + node.nodeSize - 1; });
      f.editor.commands.insertContentAt(position, ' audit');
      const edited = f.read();
      expect(edited.slice(0, block.start), path).toBe(source.slice(0, block.start));
      expect(edited.slice(block.end + edited.length - source.length), path).toBe(source.slice(block.end));
      writeFileSync(join(temporary, 'source'), source); writeFileSync(join(temporary, 'edited'), edited);
      const diff = spawnSync('git', ['diff', '--no-index', '--numstat', '--', join(temporary, 'source'), join(temporary, 'edited')], { encoding: 'utf8' });
      expect([0, 1]).toContain(diff.status);
      const [added = '0', removed = '0'] = diff.stdout.trim().split('\t');
      expect([Number(added), Number(removed)], path).toEqual([1, 1]);
      console.info(`${path}: +${added} -${removed}; editable preview`);
      f.editor.destroy();
      let saved = source;
      const client = { command: async (command: string, payload?: unknown) => {
        if (command === 'files.write') saved = (payload as { content: string }).content;
        return { type: 'ack' as const, cmd_id: 'audit', ok: true, result: { state: 'text', content: source, hash: 'source', editable: true } };
      } };
      const document = createCodeDocument(client, { projectId: 'audit', path });
      await document.refresh();
      const view = render(<MarkdownDocument content={source} editable onChange={document.edit}/>);
      await document.save();
      expect(document.getSnapshot()).toMatchObject({ dirty: false, content: source });
      expect(saved).toBe(source);
      view.unmount(); cleanup();
    }
  } finally { rmSync(temporary, { recursive: true }); }
}, 30000);
