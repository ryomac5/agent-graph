import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Editor } from '@tiptap/react';
import { EditorView } from '@codemirror/view';
import { CodeTab } from '../pages/workspace/CodeTab.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { FileViewerPanel, useFileExplorer } from '../pages/files/FilesPage.tsx';
import { getFileDocument } from '../lib/file-documents.ts';
import { createStore } from '../lib/store.ts';
import { createMarkdownExtensions } from '../lib/markdown-editor.ts';
import { MarkdownDocument } from '../components/files/MarkdownDocument.tsx';
import { HtmlDocument, PREVIEW_DEBOUNCE_MS } from '../components/files/HtmlDocument.tsx';
import type { Ack } from '../lib/client.ts';
import { workspaceKey } from '../lib/panes.ts';

beforeEach(() => {
  localStorage.clear();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function fixture(path = 'notes.md', content = '# Original\n\n- item\n') {
  const client = { command: vi.fn(async (name: string, payload?: unknown): Promise<Ack> => {
    const request = payload as { content?: string };
    if (name === 'files.write') content = request.content!;
    const result = name === 'files.read' ? { state: 'text', content, hash: 'disk', editable: true, size: content.length, worktree: '/repo', path }
      : name === 'files.list' ? { entries: [{ name: path, path, kind: 'file', git: [], changed: false }] }
      : name === 'files.worktrees' ? { worktree: '/repo', worktrees: [{ path: '/repo', detached: false }] }
      : name === 'files.preview' ? { url: `/preview/ticket/${path}`, expiresAt: Date.now() + 600000 } : { hash: 'saved' };
    return { type: 'ack', cmd_id: name, ok: true, result };
  }) };
  const request = { projectId: 'p', path };
  const document = getFileDocument(client, request);
  const target = createStore();
  function Viewer() {
    const explorer = useFileExplorer({ project: 'p', client, target, embedded: true });
    return <FileViewerPanel explorer={explorer}/>;
  }
  function Work() { return <Workbench project="p" session="s" conversationId="c" client={client} language="en" renderConversation={() => null}/>; }
  function mount() {
    localStorage.setItem(workspaceKey('p', 's'), JSON.stringify({ kind: 'pane', id: 'pane', active: 'code', tabs: [{ id: 'code', kind: 'code', path }] }));
    return render(<MemoryRouter initialEntries={[`/p/p?path=${path}`]}><Work/><Viewer/></MemoryRouter>);
  }
  return { client, request, document, Viewer, mount };
}
function findEditor(element: HTMLElement): Editor { return (element as HTMLElement & { editor: Editor }).editor; }
it('preserves every source character when preview is opened, selected and saved with Cmd+S', async () => {
  const source = '# Heading  \r\n\r\n*   spaced bullet\r\n\r\n';
  const f = fixture('notes.md', source); f.mount();
  const body = await screen.findByRole('textbox', { name: 'Markdown document' });
  expect(f.document.getSnapshot()).toMatchObject({ content: source, dirty: false });
  act(() => findEditor(body).commands.setTextSelection(1));
  await act(async () => { fireEvent.keyDown(body, { key: 's', metaKey: true }); });
  expect(f.document.getSnapshot().content).toBe(source);
  expect(f.client.command.mock.calls.filter(([name]) => name === 'files.write')).toHaveLength(0);
});
it('syncs preview edits with source, the right panel, split panes and files.write', async () => {
  const f = fixture(); f.mount();
  const body = await screen.findByRole('textbox', { name: 'Markdown document' });
  act(() => findEditor(body).commands.insertContentAt(1, 'Edited '));
  const viewer = screen.getByRole('region', { name: 'File viewer' });
  await vi.waitFor(() => expect(within(viewer).getByRole('heading', { name: 'Edited Original' })).toBeTruthy());
  expect(within(viewer).getByText('Unsaved').closest('.viewer-mode')).toBeTruthy();
  fireEvent.click(within(viewer).getByRole('button', { name: 'Raw' }));
  expect(viewer.textContent).toContain('# Edited Original');
  const work = document.querySelector('.workbench')!;
  fireEvent.click(within(work as HTMLElement).getByRole('button', { name: 'Raw' }));
  const code = screen.getByRole('textbox', { name: 'Code' });
  expect(code.textContent).toContain('# Edited Original');
  fireEvent.keyDown(code, { key: 'd', metaKey: true });
  expect(within(work as HTMLElement).getAllByRole('heading', { name: 'Edited Original' })).toHaveLength(2);
  for (const button of within(work as HTMLElement).getAllByRole('button', { name: 'Raw' })) fireEvent.click(button);
  const codes = screen.getAllByRole('textbox', { name: 'Code' });
  act(() => { const view = EditorView.findFromDOM(codes[1])!; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '# From source\n' } }); });
  expect(codes[0].textContent).toContain('# From source');
  expect(viewer.textContent).toContain('# From source');
  fireEvent.click(within(viewer).getByRole('button', { name: 'Preview' }));
  expect(within(viewer).getByRole('heading', { name: 'From source' })).toBeTruthy();
  await act(async () => { fireEvent.keyDown(codes[1], { key: 's', metaKey: true }); });
  expect(f.client.command).toHaveBeenCalledWith('files.write', expect.objectContaining({ content: '# From source\n' }));
  expect(within(viewer).queryByText('Unsaved')).toBeNull();
});
it('keeps drafts across workspaces and isolates project, worktree and path', async () => {
  const f = fixture(); await f.document.refresh(); f.document.edit('draft');
  expect(getFileDocument(f.client, f.request)).toBe(f.document);
  for (const request of [{ ...f.request, projectId: 'other' }, { ...f.request, path: 'other.md' }, { ...f.request, worktree: '/branch' }]) expect(getFileDocument(f.client, request)).not.toBe(f.document);
  f.mount();
  await vi.waitFor(() => expect(screen.getByRole('region', { name: 'File viewer' }).textContent).toContain('draft'));
  expect(f.document.getSnapshot().content).toBe('draft');
});
it('handles all requested Markdown blocks and marks, including official task lists and tables', () => {
  const source = '# Heading\n\nParagraph with **bold**, *italic*, ~~strike~~, `code`, and [link](https://example.com).\n\n- Bullet\n\n1. Number\n\n> Quote\n\n```ts\nconst x = 1\n```\n\n| Head | Value |\n| --- | --- |\n| Cell | Data |\n\n- [ ] Todo\n- [x] Done\n';
  const editor = new Editor({ extensions: createMarkdownExtensions(), content: source, contentType: 'markdown', injectCSS: false });
  const html = editor.getHTML();
  for (const tag of ['h1', 'p', 'ul', 'ol', 'blockquote', 'pre', 'table', 'a', 'strong', 'em', 's', 'code']) expect(html).toContain(`<${tag}`);
  expect(html).toContain('data-type="taskList"');
  expect(editor.getMarkdown()).toContain('- [x] Done');
  editor.destroy();
});
it('未保存の印を出しても、切り替えの行の下の中身の位置が変わらない', async () => {
  const f = fixture('note.md', '# Disk'); await f.document.refresh();
  render(<MemoryRouter initialEntries={['/p/p?path=note.md']}><f.Viewer/></MemoryRouter>);
  const mode = await screen.findByRole('group', { name: 'Markdown view' });
  const before = mode.nextElementSibling;
  act(() => f.document.edit('# Draft'));
  // 印は切り替えの行の中に入り、行の後ろの要素の並びは変わらない。
  expect(within(mode).getByText('Unsaved')).toBeTruthy();
  expect(mode.previousElementSibling?.classList.contains('document-draft') ?? false).toBe(false);
  expect(mode.nextElementSibling?.className).toBe(before?.className);
});
it('protects unsupported content while permitting source edits', async () => {
  const content = 'Paragraph\n\n![image](image.png)';
  const change = vi.fn();
  render(<MarkdownDocument content={content} editable onChange={change} language="ja"/>);
  expect(await screen.findByText('このファイルはプレビューで書くと書式が変わるため、原文で編集してください')).toBeTruthy();
  expect(document.querySelector('[contenteditable="true"]')).toBeNull(); expect(change).not.toHaveBeenCalled();
});
it.each(['page.html', 'page.htm'])('defaults %s to a sandboxed browser view and shares draft HTML with the right panel', async path => {
  const f = fixture(path, '<h1>Disk</h1>'); await f.document.refresh();
  render(<MemoryRouter initialEntries={[`/p/p?path=${path}`]}><CodeTab path={path} document={f.document} language="en"/><f.Viewer/></MemoryRouter>);
  await vi.waitFor(() => expect(document.querySelectorAll('iframe')).toHaveLength(2));
  expect(f.client.command).toHaveBeenCalledWith('files.preview', { projectId: 'p', path });
  for (const iframe of document.querySelectorAll('iframe')) expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-forms');
  act(() => f.document.edit('<h1>Draft</h1>'));
  await vi.waitFor(() => expect(f.client.command).toHaveBeenCalledWith('files.preview', { projectId: 'p', path, content: '<h1>Draft</h1>' }));
  expect(screen.getByText('Unsaved').closest('.viewer-mode')).toBeTruthy();
});
it('debounces HTML edits for 500ms, reloads, opens a new tab and ignores stale responses', async () => {
  vi.useFakeTimers();
  let finish!: (value: Ack) => void;
  const client = { command: vi.fn().mockImplementationOnce(() => new Promise<Ack>(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, result: { url: '/preview/new/page.html', expiresAt: 600000 } }) };
  const request = { projectId: 'p', worktree: '/branch', path: 'page.html' };
  const view = render(<HtmlDocument client={client} request={request} content="first"/>);
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS - 1); });
  expect(client.command).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  view.rerender(<HtmlDocument client={client} request={request} content="second"/>);
  view.rerender(<HtmlDocument client={client} request={request} content="latest"/>);
  await act(async () => { finish({ type: 'ack', cmd_id: 'old', ok: true, result: { url: '/preview/old/page.html', expiresAt: 600000 } }); await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS); });
  expect(client.command).toHaveBeenLastCalledWith('files.preview', { ...request, content: 'latest' });
  expect(document.querySelector('iframe')!.getAttribute('src')).toBe('/preview/new/page.html');
  const link = screen.getByRole('link', { name: 'Open in new tab' });
  expect(link.getAttribute('target')).toBe('_blank'); expect(link.getAttribute('rel')).toContain('noopener');
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS); });
  expect(client.command).toHaveBeenCalledTimes(3);
});
it('shows localized HTML failures and never embeds an unexpected URL', async () => {
  const client = { command: vi.fn(async (): Promise<Ack> => ({ type: 'ack', cmd_id: 'p', ok: true, result: { url: 'https://example.com', expiresAt: 600000 } })) };
  render(<HtmlDocument client={client} request={{ projectId: 'p', path: 'page.html' }} language="ja"/>);
  expect((await screen.findByRole('alert')).textContent).toContain('表示できません');
  expect(document.querySelector('iframe')).toBeNull();
});
