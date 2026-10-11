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
