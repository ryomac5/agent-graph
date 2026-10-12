import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { MarkdownDocument } from '../components/files/MarkdownDocument.tsx';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { workspaceKey } from '../lib/panes.ts';

vi.mock('../pages/settings/SettingsLayout.tsx', async () => { throw new Error('Chunk 404'); });
vi.mock('../pages/settings/SettingsPage.tsx', async () => { throw new Error('Chunk 404'); });
vi.mock('../pages/workspace/CodeTab.tsx', async () => { throw new Error('Chunk 404'); });
vi.mock('../components/files/MarkdownEditor.tsx', async () => { throw new Error('Chunk 404'); });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps dashboard navigation and the settings header after a rejected settings import', async () => {
  render(<MemoryRouter initialEntries={['/settings']}><App/></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'A new version is available.Reload');
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
});

it('keeps the other workspace pane after a rejected code import', async () => {
  localStorage.setItem(workspaceKey('p', 's'), JSON.stringify({
    kind: 'split', id: 'split', direction: 'horizontal', ratio: 0.5,
    first: { kind: 'pane', id: 'conversation', active: 'c', tabs: [{ kind: 'conversation', id: 'c', conversationId: 'c' }] },
    second: { kind: 'pane', id: 'code', active: 'file', tabs: [{ kind: 'code', id: 'file', path: 'file.ts' }] },
  }));
  const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'test', ok: true })) };
  render(<Workbench project="p" session="s" conversationId="c" client={client} language="en" renderConversation={() => <textarea aria-label="Message"/>}/>);
  expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('A new version is available.');
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'file.ts' })).toBeTruthy();
});

it('keeps surrounding content after a rejected Markdown import', async () => {
  render(<div><header>File preview</header><MarkdownDocument content="# Body"/><aside>File tree</aside></div>);
  expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('A new version is available.');
  expect(screen.getByText('File preview')).toBeTruthy();
  expect(screen.getByText('File tree')).toBeTruthy();
});
