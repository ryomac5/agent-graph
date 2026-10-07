import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { fenceLanguage, Markdown, safeUrl } from '../components/conversation/Markdown.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function show(text: string, breaks?: boolean) {
  render(<MemoryRouter><Markdown text={text} breaks={breaks}/></MemoryRouter>);
  return document.querySelector<HTMLElement>('.markdown-body')!;
}

it('renders headings below the page heading level with Notion-like steps', () => {
  const body = show('# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six');
  expect(within(body).getAllByRole('heading').map(heading => [heading.tagName, heading.className, heading.textContent])).toEqual([
    ['H3', 'md-h md-h1', 'One'], ['H4', 'md-h md-h2', 'Two'], ['H5', 'md-h md-h3', 'Three'],
    ['H6', 'md-h md-h4', 'Four'], ['H6', 'md-h md-h5', 'Five'], ['H6', 'md-h md-h6', 'Six']]);
});

it('renders bullet, numbered, nested and task lists', () => {
  const body = show('- apple\n- banana\n  1. first\n  2. second\n     - deep\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo');
  const lists = body.querySelectorAll(':scope > ul, :scope > ol');
  expect([...lists].map(list => list.tagName)).toEqual(['UL', 'OL', 'UL']);
  const nested = lists[0]!.querySelector('li ol')!;
  expect([...nested.querySelectorAll(':scope > li')].map(item => item.firstChild?.textContent)).toEqual(['first', 'second']);
  expect(nested.querySelector(':scope ul li')!.textContent).toBe('deep');
  expect(lists[1]!.getAttribute('start')).toBe('3');
  const tasks = lists[2] as HTMLElement;
  expect(tasks.className).toBe('contains-task-list');
  const boxes = within(tasks).getAllByRole('checkbox') as HTMLInputElement[];
  expect(boxes.map(box => [box.checked, box.disabled, box.className])).toEqual([[true, true, 'md-task-box'], [false, true, 'md-task-box']]);
  expect([...tasks.querySelectorAll('li')].map(item => item.className)).toEqual(['task-list-item', 'task-list-item']);
});

it('renders tables, quotes, rules, emphasis and inline code', () => {
  const body = show('| Name | Count |\n| :--- | ---: |\n| a | 1 |\n| b | 2 |\n\n> quoted **text**\n\n---\n\nUse `npm test` and *care*.');
  const table = within(body).getByRole('table');
  expect(table.parentElement!.className).toBe('md-table-wrap');
  expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Name', 'Count']);
  expect(within(table).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['a', '1', 'b', '2']);
  expect((within(table).getAllByRole('cell')[1] as HTMLElement).style.textAlign).toBe('right');
  expect(body.querySelector('blockquote strong')!.textContent).toBe('text');
  expect(body.querySelector('hr')).toBeTruthy();
  expect(body.querySelector('em')!.textContent).toBe('care');
  const code = body.querySelector('code')!;
  expect([code.className, code.textContent]).toEqual(['md-inline-code', 'npm test']);
});

it('keeps only http, https and in-app links, adds rel noreferrer and shows image alt text', () => {
  const body = show('[site](https://example.com/a) [plain](http://example.com) [app](/c/one) [bad](javascript:alert(1)) [mail](mailto:a@b.c) [rel](docs/x.md) [proto](//evil.example)\n\n![Build graph](https://example.com/graph.png) ![Local](data:image/png;base64,AAAA)');
  const links = within(body).getAllByRole('link');
  expect(links.map(link => [link.textContent, link.getAttribute('href'), link.getAttribute('rel')])).toEqual([
    ['site', 'https://example.com/a', 'noreferrer'], ['plain', 'http://example.com', 'noreferrer'], ['app', '/c/one', 'noreferrer'],
    ['Build graph', 'https://example.com/graph.png', 'noreferrer']]);
  expect(links[0]!.getAttribute('target')).toBe('_blank');
  for (const text of ['bad', 'mail', 'rel', 'proto']) expect(within(body).getByText(text).className).toBe('md-link-inert');
  expect(body.querySelector('img')).toBeNull();
  expect(within(body).getByRole('img', { name: 'Local' }).textContent).toBe('Local');
  expect(safeUrl('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  expect(safeUrl('/\\evil')).toBeUndefined();
});

it('drops raw HTML through rehype-sanitize', () => {
  const body = show('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\nInline <b>bold</b> and <a href="https://x.example">anchor</a>\n\n<div style="color:red">styled</div>');
  expect(body.querySelector('script, img, b, div, [style], [onerror]')).toBeNull();
  expect(body.querySelector('a')).toBeNull();
  expect(body.textContent).not.toContain('alert(1)');
});

it('highlights fenced code with the Files colours, names the language and copies the code', async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  const body = show('```typescript\nconst value = 1; // note\n```\n\n```\nplain text\n```');
  const blocks = body.querySelectorAll('.md-code');
  expect([...blocks].map(block => block.querySelector('.md-code-language')!.textContent)).toEqual(['TypeScript', 'Plain text']);
  expect(blocks[0]!.querySelector('code')!.textContent).toBe('const value = 1; // note');
  expect(blocks[0]!.querySelector('.tok-keyword')!.textContent).toBe('const');
  expect(blocks[0]!.querySelector('.tok-comment')!.textContent).toBe('// note');
  expect(blocks[1]!.querySelector('.tok')).toBeNull();
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(within(blocks[0] as HTMLElement).getByRole('button', { name: 'Copy code' })); });
  expect(writeText).toHaveBeenCalledWith('const value = 1; // note');
  expect(within(blocks[0] as HTMLElement).getByRole('button', { name: 'Copied' })).toBeTruthy();
  act(() => { vi.advanceTimersByTime(2000); });
  expect(within(blocks[0] as HTMLElement).getByRole('button', { name: 'Copy code' })).toBeTruthy();
  expect([fenceLanguage('bash'), fenceLanguage('py'), fenceLanguage('JSON'), fenceLanguage('unknown')]).toEqual(['sh', 'py', 'json', undefined]);
});

it('reports a failed copy when the clipboard is unavailable', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
  show('```sh\necho hi\n```');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy code' })); });
  expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy();
});

it('turns single newlines into line breaks in conversations but not in documents', () => {
  expect(show('first\nsecond').querySelectorAll('p br')).toHaveLength(1);
  cleanup();
  expect(show('first\nsecond', false).querySelectorAll('p br')).toHaveLength(0);
  cleanup();
  expect(show('```\na\nb\n```').querySelector('pre br')).toBeNull();
  cleanup();
  // 段落や項目の間の改行は区切りのままにし、余計な改行を足さない。
  expect(show('# Title\n\n- a\n- b\n\n| x |\n| - |\n| 1 |\n\n> quote').querySelectorAll('br')).toHaveLength(0);
});
