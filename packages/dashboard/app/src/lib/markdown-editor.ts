import { StarterKit } from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';

export function createMarkdownExtensions() {
  return [StarterKit.configure({ link: { openOnClick: false }, code: { HTMLAttributes: { class: 'md-inline-code' } }, trailingNode: false }), Markdown, TableKit, TaskList, TaskItem.configure({ nested: true })];
}
