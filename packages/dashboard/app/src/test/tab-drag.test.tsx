import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Workbench } from '../pages/workspace/Workbench.tsx';
import { listPanes, restoreWorkspace, workspaceKey, type PaneTree } from '../lib/panes.ts';
import type { ConversationClient } from '../pages/conversation/ConversationPage.tsx';

beforeEach(() => {
  localStorage.clear();
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const key = workspaceKey('p', 's');
function fixture(language: 'en' | 'ja' = 'en') {
  localStorage.setItem(key, JSON.stringify({ kind: 'pane', id: 'pane', tabs: ['a', 'b', 'c'].map(id => ({ kind: 'conversation', id, conversationId: id, name: id })), active: 'a' }));
  const props = { project: 'p', session: 's', conversationId: 'a', client: { command: vi.fn() } as unknown as ConversationClient, language, renderConversation: (id: string) => <div data-content={id}>{id} content</div> };
  return { view: render(<Workbench {...props}/>), reload: () => render(<Workbench {...props}/>) };
}
function panes() { return [...document.querySelectorAll<HTMLElement>('[data-pane-id]')]; }
function saved() { return JSON.parse(localStorage.getItem(key)!) as PaneTree; }
function names(pane = panes()[0]) { return within(pane).queryAllByRole('tab').map(tab => tab.textContent); }
function hit(element: Element) { Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => element) }); }
function start(name: string, x = 50, y = 20) { fireEvent.pointerDown(screen.getByRole('tab', { name }), { button: 0, pointerId: 1, clientX: x, clientY: y }); }
function move(x: number, y: number) { fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y }); }
function end(x: number, y: number) { fireEvent.pointerUp(window, { pointerId: 1, clientX: x, clientY: y }); }
function bound(pane: HTMLElement) { vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 400)); }

it.each(['edge', 'center', 'tablist'])('cancels a drag over the %s with Escape without applying the drop or click', target => {
  fixture();
  if (target === 'center') {
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'c' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  }
  const destination = panes().at(-1)!;
  bound(destination);
  hit(destination.querySelector(target === 'tablist' ? '.workbench-tabs' : '[data-content]')!);
  const before = saved();
  const x = target === 'edge' ? 395 : 200;
  const source = screen.getByRole('tab', { name: 'b' });
  start('b'); move(x, 200);
  expect(source.parentElement!.dataset.dragging).toBe('true');
  expect(document.querySelector(target === 'tablist' ? '.workbench-drop-end' : '.workbench-drop-preview')).toBeTruthy();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(window, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(document.querySelector('.workbench-drop-preview, .workbench-drop-end')).toBeNull();
  expect(source.parentElement!.dataset.dragging).toBe('false');
  move(x, 200); end(x, 200); fireEvent.click(source);
  expect(saved()).toEqual(before);
  const idleEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
  fireEvent(window, idleEscape);
  expect(idleEscape.defaultPrevented).toBe(false);
});
it('cleans up a drag on lost pointer capture without applying the drop', () => {
  fixture(); bound(panes()[0]); hit(panes()[0].querySelector('[data-content="a"]')!);
  const before = saved();
  start('b'); move(395, 200);
  expect(document.querySelector('.workbench-drop-preview')).toBeTruthy();
  fireEvent.lostPointerCapture(screen.getByRole('tab', { name: 'b' }), { pointerId: 1 });
  expect(document.querySelector('.workbench-drop-preview')).toBeNull();
  move(395, 200); end(395, 200);
  expect(saved()).toEqual(before);
});
it('focuses and navigates enabled tab menu items and returns focus on Escape', () => {
  fixture();
  const tab = screen.getByRole('tab', { name: 'b' });
  tab.focus(); fireEvent.contextMenu(tab);
  const first = screen.getByRole('menuitem', { name: 'Split right' });
  const last = screen.getByRole('menuitem', { name: 'Rename' });
  expect(document.activeElement).toBe(first);
  function press(key: string) { fireEvent.keyDown(document.activeElement!, { key }); }
  press('ArrowDown'); expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Split down' }));
  press('ArrowDown'); expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /^Close$/ }));
  press('ArrowUp'); expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Split down' }));
  press('End'); expect(document.activeElement).toBe(last);
  press('ArrowDown'); expect(document.activeElement).toBe(first);
  press('ArrowUp'); expect(document.activeElement).toBe(last);
  press('Home'); expect(document.activeElement).toBe(first);
  const before = saved();
  press('Escape');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(tab);
  expect(saved()).toEqual(before);
});
it.each(['header', 'tab'])('ignores HTML5 project drops on a pane %s without changing the tree or focused pane', target => {
  fixture();
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  const before = saved();
  const focused = panes().find(pane => pane.dataset.focused === 'true')!.dataset.paneId;
  const destination = panes().find(pane => pane.dataset.paneId !== focused)!;
  const element = destination.querySelector(target === 'header' ? '.workbench-tabs' : '[data-tab-id]')!;
  const dataTransfer = { getData: vi.fn((format: string) => format === 'text/plain' ? 'project-id' : '') };
  fireEvent.dragOver(element, { dataTransfer });
  fireEvent.drop(element, { dataTransfer });
  expect(saved()).toEqual(before);
  expect(panes().find(pane => pane.dataset.focused === 'true')!.dataset.paneId).toBe(focused);
  expect(dataTransfer.getData).not.toHaveBeenCalled();
});

it('reorders tabs to either side using pointer movement and shows insertion position', () => {
  fixture();
  const header = panes()[0].querySelector('.workbench-tabs')!;
  const tabElements = [...header.querySelectorAll<HTMLElement>('[data-tab-id]')];
  tabElements.forEach((tab, i) => vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(new DOMRect(i * 100, 0, 100, 40)));
  hit(header); start('c', 250); move(10, 20);
  expect(tabElements[0].dataset.dropBefore).toBe('true');
  end(10, 20); expect(names()).toEqual(['c', 'a', 'b']);
  start('c'); move(350, 20); end(350, 20); expect(names()).toEqual(['a', 'b', 'c']);
});
it.each([
  ['left', 5, 200, 'horizontal', ['b', 'a']], ['right', 395, 200, 'horizontal', ['a', 'b']],
  ['top', 200, 50, 'vertical', ['b', 'a']], ['bottom', 200, 395, 'vertical', ['a', 'b']],
] as const)('splits toward %s with a preview and restores the tree and resize ratio', (edge, x, y, direction, order) => {
  const f = fixture(); bound(panes()[0]); hit(panes()[0].querySelector('[data-content="a"]')!);
  start('b'); move(x, y);
  expect(document.querySelector(`.workbench-drop-preview.${edge}`)).toBeTruthy();
  expect(panes()).toHaveLength(1);
  end(x, y);
  expect(document.querySelector('.workbench-drop-preview')).toBeNull();
  expect(panes()).toHaveLength(2);
  const tree = saved(); expect(tree.kind).toBe('split');
  if (tree.kind !== 'split') throw Error('Expected split');
  expect(tree.direction).toBe(direction); expect(listPanes(tree).map(pane => pane.tabs[0].id)).toEqual(order);
  expect(listPanes(tree).flatMap(pane => pane.tabs).map(tab => tab.id).sort()).toEqual(['a', 'b', 'c']);
  const divider = screen.getByRole('separator', { name: 'Pane size' });
  vi.spyOn(divider.parentElement!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 406, 406));
  fireEvent.pointerDown(divider, { button: 0, pointerId: 2, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 300, clientY: 300 });
  fireEvent.pointerUp(window, { pointerId: 2 });
  expect(saved().kind === 'split' && (saved() as typeof tree).ratio).toBe(0.75);
  const before = localStorage.getItem(key); f.view.unmount(); f.reload();
  expect(panes()).toHaveLength(2); expect(localStorage.getItem(key)).toBe(before);
  expect(restoreWorkspace(before, 'a')).toEqual(saved());
});
it.each(['center', 'tablist'])('moves into another pane through its %s and collapses the empty source', target => {
  fixture(); fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  const sourceId = panes()[1].dataset.paneId;
  bound(panes()[0]);
  hit(target === 'center' ? panes()[0].querySelector('[data-content="a"]')! : panes()[0].querySelector('.workbench-tabs')!);
  start('b'); move(200, 200); end(200, 200);
  expect(panes()).toHaveLength(1); expect(panes()[0].dataset.paneId).not.toBe(sourceId);
  expect(names()).toEqual(['a', 'c', 'b']); expect(saved().kind).toBe('pane');
});
it('treats movement below 3px as a click, ignores other pointers and cancels without changes', () => {
  fixture(); const before = localStorage.getItem(key);
  start('b'); move(52, 20); end(52, 20);
  fireEvent.click(screen.getByRole('tab', { name: 'b' })); expect(screen.getByRole('tab', { name: 'b' }).getAttribute('aria-selected')).toBe('true');
  bound(panes()[0]); hit(panes()[0].querySelector('[data-content="b"]')!);
  const afterClick = localStorage.getItem(key);
  start('a'); fireEvent.pointerMove(window, { pointerId: 99, clientX: 395, clientY: 200 });
  expect(document.querySelector('.workbench-drop-preview')).toBeNull();
  move(395, 200); expect(document.querySelector('.workbench-drop-preview.right')).toBeTruthy();
  fireEvent.pointerCancel(window, { pointerId: 1 }); end(395, 200);
  expect(localStorage.getItem(key)).toBe(afterClick); expect(afterClick).not.toBe(before);
});
it('closes tabs with the middle button and collapses the last-tab pane', () => {
  fixture(); fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Split down' }));
  const tab = screen.getByRole('tab', { name: 'b' });
  fireEvent.pointerDown(tab, { button: 1, pointerId: 1 }); fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
  expect(panes()).toHaveLength(1); expect(names()).toEqual(['a', 'c']);
});
it('offers tab actions, moves to the other pane and closes others within the pane', () => {
  fixture(); fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' }));
  expect(screen.getByRole('menuitem', { name: 'Move to other pane' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Move to other pane' }));
  expect(panes()).toHaveLength(1);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Close others' }));
  expect(names()).toEqual(['b']);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }));
  expect(panes()).toHaveLength(0);
});
it('translates the new menu actions into Japanese', () => {
  fixture('ja'); fireEvent.contextMenu(screen.getByRole('tab', { name: 'a' }));
  for (const name of ['右に分割', '下に分割', '別のペインへ移動', '閉じる', 'ほかのタブを閉じる']) expect(screen.getByRole('menuitem', { name })).toBeTruthy();
});
it('starts dragging at exactly 3px for touch and suppresses the following click', () => {
  fixture(); hit(panes()[0].querySelector('.workbench-tabs')!);
  const source = screen.getByRole('tab', { name: 'b' });
  fireEvent.pointerDown(source, { button: 0, pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 20 });
  move(53, 20); expect(source.parentElement!.dataset.dragging).toBe('true');
  end(53, 20);
  fireEvent.click(screen.getByRole('tab', { name: 'a' }));
  expect(screen.getByRole('tab', { name: 'b' }).getAttribute('aria-selected')).toBe('true');
});
it('does not move a tab dropped outside the workbench and cleans up on blur', () => {
  fixture(); bound(panes()[0]); hit(panes()[0].querySelector('[data-content="a"]')!);
  const before = localStorage.getItem(key);
  start('b'); move(395, 200); expect(document.querySelector('.workbench-drop-preview')).toBeTruthy();
  hit(document.body); move(500, 500); end(500, 500);
  expect(localStorage.getItem(key)).toBe(before); expect(document.querySelector('.workbench-drop-preview')).toBeNull();
  hit(panes()[0].querySelector('[data-content="a"]')!); start('b'); move(395, 200); fireEvent.blur(window);
  expect(document.querySelector('.workbench-drop-preview')).toBeNull(); expect(localStorage.getItem(key)).toBe(before);
});
it('keeps nested splits valid when splitting the last tab from another pane', () => {
  fixture(); fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  const source = panes()[1].dataset.paneId;
  bound(panes()[0]); hit(panes()[0].querySelector('[data-content="a"]')!);
  start('b'); move(200, 395); end(200, 395);
  expect(panes()).toHaveLength(2); expect(panes().some(pane => pane.dataset.paneId === source)).toBe(false);
  expect(saved()).toMatchObject({ kind: 'split', direction: 'vertical' });
  expect(restoreWorkspace(localStorage.getItem(key), 'a')).toEqual(saved());
});
it('rejects splitting the sole tab at its own edge and shows an invalid ghost', () => {
  fixture(); fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  const pane = panes()[1]; bound(pane); hit(pane.querySelector('[data-content]')!);
  const before = saved(); start('b'); move(395, 200);
  expect(document.querySelector('.workbench-drop-preview')).toBeNull();
  const ghost = document.querySelector<HTMLElement>('.workbench-drag-ghost')!;
  expect(ghost.textContent).toBe('b'); expect(ghost.style.left).toBe('407px'); expect(ghost.dataset.valid).toBe('false');
  expect(document.documentElement.dataset.pointerDrag).toBe('not-allowed');
  end(395, 200); expect(saved()).toEqual(before); expect(document.documentElement.dataset.pointerDrag).toBeUndefined();
});
it('autoscrolls at the edge and inserts after the visible tab with a visible line', () => {
  fixture(); const pane = panes()[0], list = pane.querySelector<HTMLElement>('.workbench-tablist')!;
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 180, 40));
  const elements = [...list.querySelectorAll<HTMLElement>('[data-tab-id]')];
  elements.forEach((tab, i) => vi.spyOn(tab, 'getBoundingClientRect').mockImplementation(() => new DOMRect(i * 100 - list.scrollLeft, 0, 100, 40)));
  let tick!: FrameRequestCallback;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { tick = callback; return 1; });
  hit(list); start('a', 20); move(175, 20);
  expect(document.querySelector<HTMLElement>('.workbench-drop-end')!.style.left).toBe('178px');
  expect(elements[2].dataset.dropBefore).toBe('true');
  act(() => tick(0)); expect(list.scrollLeft).toBe(12);
  end(175, 20); expect(names()).toEqual(['b', 'a', 'c']);
});
it('scrolls selected tabs into view after moving and splitting', () => {
  const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  fixture(); scroll.mockClear();
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Split right' }));
  expect(scroll.mock.instances).toContain(screen.getByRole('tab', { name: 'b' }));
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});
it('clamps the context menu to the viewport and ignores right clicks during a drag', () => {
  fixture();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 160, 200));
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' }), { clientX: 1000, clientY: 750 });
  const menu = screen.getByRole('menu');
  expect(menu.style.left).toBe(`${Math.min(1000, window.innerWidth - 160)}px`);
  expect(menu.style.top).toBe(`${window.innerHeight - 200}px`);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  hit(panes()[0].querySelector('.workbench-tablist')!); start('b'); move(100, 20);
  fireEvent.contextMenu(screen.getByRole('tab', { name: 'b' })); expect(screen.queryByRole('menu')).toBeNull();
  end(100, 20);
});

it('defers tab pointer capture until movement reaches 3px', () => {
  fixture(); const source = screen.getByRole('tab', { name: 'b' });
  const capture = vi.fn(); Object.defineProperty(source, 'setPointerCapture', { configurable: true, value: capture });
  start('b'); expect(capture).not.toHaveBeenCalled();
  move(52, 20); expect(capture).not.toHaveBeenCalled();
  end(52, 20); fireEvent.click(source); expect(source.getAttribute('aria-selected')).toBe('true');
  hit(panes()[0].querySelector('.workbench-tabs')!);
  start('b'); move(53, 20); expect(capture).toHaveBeenCalledExactlyOnceWith(1);
});
it.each(['pointer', 'timeout'])('clears cancelled tab click suppression via %s', reset => {
  vi.useFakeTimers();
  try {
    fixture(); hit(panes()[0].querySelector('.workbench-tabs')!);
    start('b'); move(100, 20); fireEvent.keyDown(window, { key: 'Escape' });
    if (reset === 'pointer') start('c'); else act(() => vi.advanceTimersByTime(250));
    fireEvent.click(screen.getByRole('tab', { name: 'c' }));
    expect(screen.getByRole('tab', { name: 'c' }).getAttribute('aria-selected')).toBe('true');
  } finally { vi.useRealTimers(); }
});
it('converts vertical wheel motion only on overflowing tablists and preserves horizontal gestures', () => {
  fixture(); const list = screen.getByRole('tablist');
  Object.defineProperties(list, { scrollWidth: { configurable: true, value: 600 }, clientWidth: { configurable: true, value: 200 } });
  const wheel = (deltaY: number, deltaX = 0, deltaMode = 0, ctrlKey = false) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, deltaX, deltaMode, ctrlKey });
    fireEvent(screen.getByRole('tab', { name: 'a' }), event); return event;
  };
  expect(wheel(40).defaultPrevented).toBe(true); expect(list.scrollLeft).toBe(40);
  expect(wheel(-10).defaultPrevented).toBe(true); expect(list.scrollLeft).toBe(30);
  expect(wheel(1, 0, 1).defaultPrevented).toBe(true); expect(list.scrollLeft).toBe(46);
  expect(wheel(1, 0, 2).defaultPrevented).toBe(true); expect(list.scrollLeft).toBe(246);
  expect(wheel(20, 10).defaultPrevented).toBe(false); expect(list.scrollLeft).toBe(246);
  expect(wheel(20, 0, 0, true).defaultPrevented).toBe(false);
  Object.defineProperty(list, 'scrollWidth', { value: 200 });
  expect(wheel(20).defaultPrevented).toBe(false);
  const bodyWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 20 });
  fireEvent(panes()[0].querySelector('.workbench-body')!, bodyWheel); expect(bodyWheel.defaultPrevented).toBe(false);
});
