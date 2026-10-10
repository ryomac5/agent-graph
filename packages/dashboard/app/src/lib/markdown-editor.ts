import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';

export function createMarkdownExtensions() {
  return [StarterKit.configure({ link: { openOnClick: false }, code: { HTMLAttributes: { class: 'md-inline-code' } }, trailingNode: false }), Markdown, TableKit, TaskList, TaskItem.configure({ nested: true })];
}
const FORMAT_CHANGE_LINES = 20;
const FORMAT_CHANGE_RATIO = 0.25;
export function shouldReadMarkdownOnly(source: string, serialized: string): boolean {
  // 非対応の画像・生 HTML・脚注・メタ情報を編集によって失わない。
  if (/!\[[^\]]*\]\(|^\s*<\/?[a-zA-Z!]|^\[\^.+\]:|^---\r?\n/.test(source) || /^\s*<\/?[a-zA-Z!]|^\[\^.+\]:/m.test(source)) return true;
  const original = source.split('\n').map(line => line.trim());
  const remaining = new Map<string, number>();
  for (const line of original) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of serialized.split('\n').map(line => line.trim())) {
    const count = remaining.get(line) ?? 0;
    if (count) remaining.set(line, count - 1); else additions++;
  }
  const changes = additions + [...remaining.values()].reduce((total, count) => total + count, 0);
  return changes > FORMAT_CHANGE_LINES && changes / original.length > FORMAT_CHANGE_RATIO;
}
