import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import { createMarkdownExtensions, shouldReadMarkdownOnly } from '../lib/markdown-editor.ts';
import { MarkdownDocument } from '../components/files/MarkdownDocument.tsx';
import { createCodeDocument } from '../lib/code-document.ts';

it('audits repository Markdown serialization and preserves untouched saves byte for byte', async () => {
  const root = '../..';
  const paths = ['README.md', ...readdirSync(`${root}/docs/agents`).filter(name => name.endsWith('.md')).sort().map(name => `docs/agents/${name}`)];
  const temporary = mkdtempSync(join(tmpdir(), 'markdown-roundtrip-'));
  try {
    for (const path of paths) {
      const source = readFileSync(`${root}/${path}`, 'utf8');
      const editor = new Editor({ extensions: createMarkdownExtensions(), content: source, contentType: 'markdown', injectCSS: false });
      const serialized = editor.getMarkdown();
      writeFileSync(join(temporary, 'source'), source); writeFileSync(join(temporary, 'serialized'), serialized);
      const diff = spawnSync('git', ['diff', '--no-index', '--numstat', '--', join(temporary, 'source'), join(temporary, 'serialized')], { encoding: 'utf8' });
      expect([0, 1]).toContain(diff.status);
      const [added = '0', removed = '0'] = diff.stdout.trim().split('\t');
      console.info(`${path}: +${added} -${removed}; ${shouldReadMarkdownOnly(source, serialized) ? 'read-only preview' : 'editable preview'}`);
      editor.destroy();
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
