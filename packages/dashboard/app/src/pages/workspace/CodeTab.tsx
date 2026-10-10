import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { FILE_POLL_MS, type CodeDocument } from '../../lib/code-document.ts';
import type { Language } from '../../lib/i18n.ts';
import { readStyleNonce } from '../../lib/style-nonce.ts';
import { MarkdownDocument } from '../../components/files/MarkdownDocument.tsx';
import { HtmlDocument } from '../../components/files/HtmlDocument.tsx';
import '../files/highlight.css';
export function codeLanguage(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase();
  switch (extension) {
    case 'ts': case 'tsx': case 'js': case 'jsx': return javascript({ typescript: extension.startsWith('ts'), jsx: extension.endsWith('x') });
    case 'json': return json(); case 'md': return markdown(); case 'css': return css(); case 'html': case 'htm': return html(); case 'py': return python(); case 'yaml': case 'yml': return yaml(); default: return [];
  }
}
export const codeTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg-1)', backgroundColor: 'var(--bg-0)', font: 'var(--type-mono)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)' },
  '.cm-gutters': { color: 'var(--fg-4)', backgroundColor: 'var(--bg-1)', borderRight: 'var(--border)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--bg-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg-1)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--bg-3)' },
});
const colors = syntaxHighlighting(HighlightStyle.define(defaultHighlightStyle.specs.map(spec => ({
  ...spec, color: spec.color === '#708' ? 'var(--tok-keyword)' : spec.color === '#a11' || spec.color === '#a50' ? 'var(--tok-string)' : spec.color === '#164' ? 'var(--tok-number)' : spec.color === '#940' ? 'var(--tok-comment)' : 'var(--fg-1)',
}))));
export function CodeTab({ document, path, language }: { document: CodeDocument; path: string; language: Language }) {
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>(null);
  const [compare, setCompare] = useState(false);
  const isMarkdown = /\.md$/i.test(path);
  const isHtml = /\.html?$/i.test(path);
  const [raw, setRaw] = useState(!isMarkdown && !isHtml);
  const ja = language === 'ja';
  useEffect(() => {
    void document.refresh();
    const timer = setInterval(() => void document.refresh(), FILE_POLL_MS);
    const refresh = () => void document.refresh();
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [document]);
  useEffect(() => {
    if (state.loading || !host.current) return;
    const nonce = readStyleNonce();
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: document.getSnapshot().content, extensions: [basicSetup, codeLanguage(path), codeTheme, colors,
      nonce ? EditorView.cspNonce.of(nonce) : [],
      EditorState.readOnly.of(!state.editable), EditorView.editable.of(state.editable), EditorView.contentAttributes.of({ 'aria-label': ja ? 'コード' : 'Code' }),
      EditorView.updateListener.of(update => { if (update.docChanged && update.state.doc.toString() !== document.getSnapshot().content) document.edit(update.state.doc.toString()); }),
    ] }) });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [document, path, state.loading, state.editable, ja, raw]);
  useEffect(() => { const view = editor.current; if (view && view.state.doc.toString() !== state.content) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: state.content } }); }, [state.content]);
  return <div className="code-tab">
    {(isMarkdown || isHtml) && <div className="viewer-mode" role="group" aria-label={ja ? 'ファイルの表示' : 'File view'}>
      <button className="viewer-mode-option" aria-pressed={!raw} onClick={() => setRaw(false)}>{isMarkdown ? ja ? 'プレビュー' : 'Preview' : ja ? '表示' : 'Display'}</button>
      <button className="viewer-mode-option" aria-pressed={raw} onClick={() => setRaw(true)}>{ja ? '原文' : 'Raw'}</button>
    </div>}
    {state.loading && <p>{ja ? '読み込み中' : 'Loading…'}</p>}
    {!state.loading && !state.editable && <p role="status" className="editor-notice">{state.state === 'binary' ? ja ? '文字でないファイルは編集できません。' : 'Binary files cannot be edited.' : state.state === 'too_large' ? ja ? '大きすぎるファイルは編集できません。' : 'This file is too large to edit.' : ja ? '秘密を伏せたファイルは編集できません。' : 'Files with redacted content cannot be edited.'}</p>}
    {state.external && !state.conflict && <p role="status" className="editor-notice">{ja ? 'ファイルが外で変更されました。' : 'This file changed on disk.'}</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.conflict && <section className="editor-conflict" role="alert"><p>{ja ? 'ディスクの内容が変わりました。保存方法を選んでください。' : 'The file changed on disk. Choose how to continue.'}</p><div className="button-row">
      <button className="btn btn-secondary" disabled={state.saving || state.conflict.editable !== true} onClick={() => void document.save(true)}>{ja ? '上書き' : 'Overwrite'}</button>
      <button className="btn btn-secondary" onClick={() => { document.discard(); setCompare(false); }}>{ja ? '捨てる' : 'Discard'}</button>
      <button className="btn btn-secondary" onClick={() => setCompare(value => !value)}>{ja ? '比べる' : 'Compare'}</button></div>
      {compare && <div className="editor-comparison"><section><h3>{ja ? 'ディスク' : 'Disk'}</h3><pre>{state.conflict.state === 'text' ? state.conflict.content : ja ? '文字ではありません' : 'No text content'}</pre></section><section><h3>{ja ? '自分の変更' : 'Your changes'}</h3><pre>{state.content}</pre></section></div>}</section>}
    {raw ? <div className="code-editor" ref={host}/> : !state.loading && state.state === 'text' && (isMarkdown
      ? <MarkdownDocument content={state.content} editable={state.editable} onChange={document.edit} language={language}/>
      : <HtmlDocument client={document.client} request={document.request} content={state.dirty ? state.content : undefined} language={language}/>)}
  </div>;
}
