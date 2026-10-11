import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createInteractionFixture, interactionKey } from './interaction-fixture.ts';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount() { render(<MemoryRouter initialEntries={['/p/p']}><App target={createInteractionFixture()}/></MemoryRouter>); }
it('cancels the tab drag before App handles Escape and preserves the pane tree', () => {
  mount();
  const pane = document.querySelector<HTMLElement>('[data-pane-id]')!;
  vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400));
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => pane.querySelector('.workbench-body') });
  const tab = document.getElementById('workspace-tab-b')!;
  const before = localStorage.getItem(interactionKey);
  tab.focus(); fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 50, clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 395, clientY: 200 });
  expect(document.querySelector('.workbench-drop-preview')).toBeTruthy();
  fireEvent.keyDown(tab, { key: 'Escape' });
  expect(document.querySelector('.workbench-drop-preview, .workbench-drag-ghost')).toBeNull();
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 395, clientY: 200 });
  expect(localStorage.getItem(interactionKey)).toBe(before);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('closes the tab context menu with Escape through App and restores tab focus', () => {
  mount(); const tab = document.getElementById('workspace-tab-b')!;
  const before = localStorage.getItem(interactionKey);
  fireEvent.contextMenu(tab, { clientX: 100, clientY: 40 });
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Split right' }), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(tab);
  expect(localStorage.getItem(interactionKey)).toBe(before);
});
it('activates the existing conversation from plus instead of adding a duplicate', () => {
  mount(); fireEvent.click(document.getElementById('workspace-tab-b')!);
  fireEvent.click(screen.getByRole('button', { name: 'Open tab' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Conversation' }));
  const tree = JSON.parse(localStorage.getItem(interactionKey)!);
  expect(tree.tabs).toHaveLength(3); expect(tree.active).toBe('a');
  expect(new Set(screen.getAllByRole('tab').filter(tab => tab.id.startsWith('workspace-tab')).map(tab => tab.getAttribute('aria-label'))).size).toBe(3);
});

it('distinguishes restored duplicate conversations with their date and occurrence, without internal ids', () => {
  const target = createInteractionFixture();
  const state = target.getSnapshot();
  target.setSnapshot({ ...state, projection: { ...state.projection, roots: [{ id: 'a', name: 'Repo-20261011-2', user_name: 'Same', project: 'p', state: 'idle', conversation_ids: ['a'] }] } });
  localStorage.setItem(interactionKey, JSON.stringify({ kind: 'pane', id: 'pane', tabs: ['initial-tab', 'internal-tab-two'].map(id => ({ kind: 'conversation', id, conversationId: 'a' })), active: 'initial-tab' }));
  render(<MemoryRouter initialEntries={['/p/p']}><App target={target}/></MemoryRouter>);
  expect(document.getElementById('workspace-tab-initial-tab')!.getAttribute('aria-label')).toBe('Same · 20261011-2 · 1');
  expect(document.getElementById('workspace-tab-internal-tab-two')!.getAttribute('aria-label')).toBe('Same · 20261011-2 · 2');
  expect([...document.querySelectorAll('.workbench-tab-suffix')].map(row => row.textContent)).toEqual([' · 20261011-2 · 1', ' · 20261011-2 · 2']);
});

it('uses conversation start times when duplicate names have no date suffix', () => {
  const target = createInteractionFixture(); const state = target.getSnapshot();
  const starts = ['2026-10-11T01:02:03Z', '2026-10-11T04:05:06Z', '2026-10-11T07:08:09Z'];
  target.setSnapshot({ ...state, projection: { ...state.projection, runs: ['a', 'b', 'c'].map((id, i) => ({ id: `run-${id}`, conversation_id: id, started_ts: starts[i], state: 'idle' })) } });
  render(<MemoryRouter initialEntries={['/p/p']}><App target={target}/></MemoryRouter>);
  ['a', 'b', 'c'].forEach((id, i) => expect(document.getElementById(`workspace-tab-${id}`)!.getAttribute('aria-label')).toBe(`Same · ${new Date(starts[i]).toLocaleString('en-GB')}`));
});
