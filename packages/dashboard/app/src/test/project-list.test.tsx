import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
import { loadProjectList, PROJECT_LIST_KEY } from '../lib/project-list.ts';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function fixture() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { projects: ['Charlie', 'Alpha', 'Bravo'].map(name => ({ id: name.toLowerCase(), display_name: name, state: 'registered' })) } });
  return target;
}
function mount(target = fixture()) { return { target, ...render(<MemoryRouter><App target={target}/></MemoryRouter>) }; }
function list() { return screen.getByRole('navigation', { name: /^(Projects|プロジェクト)$/ }); }
function order() { return within(list()).queryAllByRole('link').map(link => link.textContent); }
function row(name: string) { return within(list()).getByRole('link', { name }).closest('.sidebar-project-row') as HTMLElement; }
function actions(name: string) { fireEvent.click(within(list()).getByRole('button', { name: `Project actions: ${name}` })); }

it('reorders with Alt arrows and preserves focus, with boundaries unchanged', () => {
  mount();
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  row('Bravo').focus();
  fireEvent.keyDown(row('Bravo'), { key: 'ArrowUp', altKey: true });
  expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  expect(document.activeElement).toBe(row('Bravo'));
  fireEvent.keyDown(row('Bravo'), { key: 'ArrowUp', altKey: true });
  expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  fireEvent.keyDown(row('Bravo'), { key: 'ArrowDown', altKey: true });
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  expect(loadProjectList().order).toEqual(['alpha', 'bravo', 'charlie']);
});

it('drags rows in both directions, marks the insertion edge and clears cancelled drags', () => {
  mount();
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
  const alpha = row('Alpha'); const charlie = row('Charlie');
  vi.spyOn(charlie, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40 } as DOMRect);
  fireEvent.dragStart(alpha, { dataTransfer });
  fireEvent.dragOver(charlie, { dataTransfer, clientY: 135 });
  // jsdom の DragEvent は座標を持たないので MouseEvent で同じ DOM イベントを送る。
  fireEvent(charlie, Object.assign(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 135 }), { dataTransfer }));
  expect(charlie.parentElement?.classList.contains('project-drop-after')).toBe(true);
  fireEvent.drop(charlie, { dataTransfer });
  expect(order()).toEqual(['Bravo', 'Charlie', 'Alpha']);
  expect(list().querySelector('.project-drop-after')).toBeNull();
  const bravo = row('Bravo');
  vi.spyOn(bravo, 'getBoundingClientRect').mockReturnValue({ top: 100, height: 40 } as DOMRect);
  fireEvent.dragStart(alpha, { dataTransfer });
  fireEvent(bravo, Object.assign(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 105 }), { dataTransfer }));
  expect(bravo.parentElement?.classList.contains('project-drop-before')).toBe(true);
  fireEvent.drop(bravo, { dataTransfer });
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  fireEvent.dragStart(alpha, { dataTransfer });
  fireEvent.dragOver(bravo, { dataTransfer });
  fireEvent.dragEnd(alpha, { dataTransfer });
  expect(list().querySelector('.project-drop-before, .project-drop-after, .project-dragging')).toBeNull();
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

it('opens both menus, moves, hides and restores projects without changing the projection', () => {
  const { target } = mount();
  const original = target.getSnapshot().projection.projects;
  fireEvent.contextMenu(row('Bravo'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
  expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  actions('Bravo');
  expect(screen.getByRole('menuitem', { name: 'Move up' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  actions('Bravo'); fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from list' }));
  actions('Alpha'); fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from list' }));
  expect(order()).toEqual(['Charlie']);
  expect(screen.getByText('Hidden 2')).toBeTruthy();
  fireEvent.click(screen.getByText('Hidden 2'));
  const hidden = list().querySelector('details')!;
  expect(hidden.open).toBe(true);
  fireEvent.click(within(hidden).getByRole('button', { name: 'Show in list: Bravo' }));
  expect(order()).toEqual(['Bravo', 'Charlie']);
  expect(screen.getByText('Hidden 1')).toBeTruthy();
  expect(target.getSnapshot().projection.projects).toBe(original);
});

it('retains order and hidden projects on remount, appends new projects and survives incomplete snapshots', () => {
  const { target, unmount } = mount();
  actions('Charlie'); fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
  actions('Alpha'); fireEvent.click(screen.getByRole('menuitem', { name: 'Hide from list' }));
  const saved = localStorage.getItem(PROJECT_LIST_KEY);
  unmount(); mount(target);
  expect(order()).toEqual(['Charlie', 'Bravo']);
  expect(screen.getByText('Hidden 1')).toBeTruthy();
  expect(localStorage.getItem(PROJECT_LIST_KEY)).toBe(saved);
  const snapshot = target.getSnapshot();
  act(() => target.setSnapshot({ ...snapshot, projection: { projects: [{ id: 'aardvark', display_name: 'Aardvark', state: 'registered' }, ...snapshot.projection.projects!] } }));
  expect(order()).toEqual(['Charlie', 'Bravo', 'Aardvark']);
  act(() => target.setSnapshot({ ...snapshot, projection: {} }));
  act(() => target.setSnapshot(snapshot));
  expect(order()).toEqual(['Charlie', 'Bravo']);
  fireEvent.click(screen.getByText('Hidden 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Show in list: Alpha' }));
  expect(order()).toEqual(['Alpha', 'Charlie', 'Bravo']);
});

it('handles invalid saved data and translates actions and the hidden group', () => {
  localStorage.setItem(PROJECT_LIST_KEY, 'invalid');
  expect(loadProjectList()).toEqual({ order: [], hidden: [] });
  localStorage.setItem('agent-graph-language', 'ja');
  mount();
  fireEvent.contextMenu(row('Alpha'));
  expect(screen.getByRole('menuitem', { name: '下へ移動' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: '一覧から外す' }));
  expect(screen.getByText('非表示 1')).toBeTruthy();
  fireEvent.click(screen.getByText('非表示 1'));
  fireEvent.click(screen.getByRole('button', { name: '一覧に戻す: Alpha' }));
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

it('keeps menu keyboard navigation local and closes it with focus restored', () => {
  mount(); actions('Bravo');
  const up = screen.getByRole('menuitem', { name: 'Move up' });
  expect(document.activeElement).toBe(up);
  fireEvent.keyDown(up, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Move down' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(row('Bravo'));
});
