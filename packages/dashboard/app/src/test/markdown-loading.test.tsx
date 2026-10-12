import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownDocument } from '../components/files/MarkdownEditor.tsx';

vi.mock('@tiptap/react', () => ({ useEditor: () => null, EditorContent: () => null }));
afterEach(cleanup);

it('shows the Markdown body while the editor waits for mounting', () => {
  render(<MarkdownDocument content={'# Document title\n\nDocument body'} editable/>);
  expect(screen.getByRole('heading', { name: 'Document title' })).toBeTruthy();
  expect(screen.getByText('Document body')).toBeTruthy();
});
