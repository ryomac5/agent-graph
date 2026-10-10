import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Language } from '../../lib/i18n.ts';
import { createMarkdownExtensions } from '../../lib/markdown-editor.ts';
import { MarkdownBlocks } from '../../lib/markdown-blocks.ts';
import { Markdown } from '../conversation/Markdown.tsx';
import './document.css';

export function MarkdownDocument({ content, editable = false, onChange, language = 'en' }: {
  content: string; editable?: boolean; onChange?: (content: string) => void; language?: Language;
}) {
  const ja = language === 'ja';
  const applied = useRef(content);
  const blocks = useRef<MarkdownBlocks | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const [protectedFormat, setProtectedFormat] = useState(false);
  const editor = useEditor({
    extensions: createMarkdownExtensions(), content, contentType: 'markdown', editable: false, injectCSS: false,
    editorProps: { attributes: { class: 'document-prose', role: editable ? 'textbox' : 'document', 'aria-label': ja ? 'Markdown の本文' : 'Markdown document', 'aria-multiline': 'true' } },
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.docChanged || !editor.isEditable) return;
      const markdown = blocks.current!.write(transaction);
      applied.current = markdown;
      change.current?.(markdown);
    },
  });
  useEffect(() => {
    if (!editor) return;
    if (applied.current !== content) {
      editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false });
      applied.current = content;
      blocks.current = new MarkdownBlocks(content, editor);
    }
    if (!blocks.current) blocks.current = new MarkdownBlocks(content, editor);
    const protectedFormat = blocks.current.readOnly;
    setProtectedFormat(protectedFormat);
    editor.setEditable(editable && !protectedFormat);
    editor.view.dom.setAttribute('role', editable ? 'textbox' : 'document');
    editor.view.dom.setAttribute('aria-label', ja ? 'Markdown の本文' : 'Markdown document');
  }, [content, editor, editable, ja]);
  const text = (en: string, jaText: string) => ja ? jaText : en;
  return <div className="markdown-surface">
    {editable && protectedFormat && <p role="status" className="editor-notice">{text('Editing this preview would change the formatting. Please edit the source instead.', 'このファイルはプレビューで書くと書式が変わるため、原文で編集してください')}</p>}
    {editable && !protectedFormat && editor && <div className="document-toolbar" role="toolbar" aria-label={text('Formatting', '書式')}>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleBold().run()}>{text('Bold', '太字')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleItalic().run()}>{text('Italic', '斜体')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleStrike().run()}>{text('Strike', '取り消し線')}</button>
      <select aria-label={text('Text style', '文字の種類')} defaultValue="paragraph" onChange={event => {
        const value = event.target.value;
        if (value === 'paragraph') editor.chain().focus().setParagraph().run();
        else editor.chain().focus().toggleHeading({ level: Number(value) as 1 | 2 | 3 }).run();
      }}><option value="paragraph">{text('Paragraph', '段落')}</option>{[1, 2, 3].map(level => <option key={level} value={level}>{text('Heading', '見出し')} {level}</option>)}</select>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleBulletList().run()}>{text('List', '箇条書き')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleOrderedList().run()}>{text('Numbered list', '番号付き箇条書き')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleTaskList().run()}>{text('Tasks', '作業の箇条書き')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleBlockquote().run()}>{text('Quote', '引用')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleCode().run()}>{text('Inline code', 'コード')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{text('Code block', 'コードの塊')}</button>
      <button className="btn btn-ghost" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>{text('Table', '表')}</button>
      <button className="btn btn-ghost" onClick={() => { const href = window.prompt(text('Link URL', 'リンクの URL'), String(editor.getAttributes('link').href ?? '')); if (href !== null) { if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run(); else editor.chain().focus().unsetLink().run(); } }}>{text('Link', 'リンク')}</button>
    </div>}
    {protectedFormat ? <div className="document-prose"><Markdown text={content} breaks={false}/></div> : <EditorContent editor={editor}/>}
  </div>;
}
