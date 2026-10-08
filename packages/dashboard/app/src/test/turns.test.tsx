import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { createStore, type ScreenState } from '../lib/store.ts';
import { selectRoots } from '../lib/roots.ts';
import { DEFAULT_KEYS, keyLabel } from '../lib/keys.ts';
import { readHistory, recordTransitions, rememberConversation, selectTurns, publishTurns, RECENT_KEY, READ_KEY } from '../lib/turns.ts';
import { TurnSignals, TabBadge } from '../components/TurnSignals.tsx';
import { RootList } from '../components/RootViews.tsx';
import { CommandPalette } from '../components/command/Commands.tsx';
import { orderCommands } from '../components/command/navigation.ts';

const FIRST = '2026-10-08T01:00:00Z';
const LAST = '2026-10-08T02:00:00Z';
const EMPTY = { read: {}, ready: {}, recent: [] };
beforeEach(() => {
  localStorage.clear(); document.title = 'agent-graph';
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,badge');
});
afterEach(() => { cleanup(); publishTurns(); vi.restoreAllMocks(); document.querySelectorAll('link[rel="icon"]').forEach(row => row.remove()); });
function fixture() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'p', display_name: 'Project', state: 'registered' }],
    roots: [{ id: 'root', name: 'Build', project: 'p', state: 'running', last_activity_ts: FIRST, conversation_ids: ['root'], running_children: 0, total_children: 0 }],
    conversations: [{ id: 'root', name: 'Build' }, { id: 'input', name: 'Question' }],
    runs: [{ id: 'run', conversation_id: 'input', generation: 1, state: 'waiting_input', last_evidence_ts: LAST }],
    approvals: [{ id: 'a', conversation_id: 'root', state: 'requested', requested_ts: FIRST }, { id: 'done', state: 'allowed' }],
  } });
  return target;
}
function idle(state: ScreenState): ScreenState {
  return { ...state, projection: { ...state.projection, roots: state.projection.roots.map(root => ({ ...root, state: 'idle', last_activity_ts: LAST })) } };
}
function Location() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output data-testid="route">{location.pathname}{location.search}</output><button onClick={() => navigate('/c/root')}>Read root</button></>;
}
it('selects pending approvals, latest input waits and only transitioned unread idle roots, oldest first', () => {
  const state = fixture().getSnapshot(); const next = idle(state);
  expect(selectTurns(next, EMPTY).map(turn => turn.kind)).toEqual(['approval', 'input']);
  const history = recordTransitions(selectRoots(state), selectRoots(next), EMPTY);
  expect(selectTurns(next, history).map(turn => turn.kind)).toEqual(['approval', 'idle', 'input']);
  expect(selectTurns(next, { ...history, read: { root: LAST } }).map(turn => turn.kind)).toEqual(['approval', 'input']);
  const newer = { ...next, projection: { ...next.projection, runs: [...next.projection.runs, { id: 'new', conversation_id: 'input', generation: 2, state: 'idle' }] } };
  expect(selectTurns(newer, history).some(turn => turn.kind === 'input')).toBe(false);
  expect(recordTransitions(selectRoots(state), selectRoots({ ...next, projection: { ...next.projection, roots: next.projection.roots.map(root => ({ ...root, state: 'unknown' })) } }), EMPTY).ready).toEqual({});
});
it('updates tab count and root dot, reads an opened root and remembers the read time after remount', () => {
  const target = fixture();
  const view = render(<MemoryRouter><TurnSignals target={target} bindings={DEFAULT_KEYS}/><RootList roots={selectRoots(idle(target.getSnapshot()))}/><Location/></MemoryRouter>);
  expect(document.title).toBe('(2) agent-graph');
  act(() => target.setSnapshot(idle(target.getSnapshot())));
  expect(document.title).toBe('(3) agent-graph');
  expect(screen.getByRole('img', { name: 'Your turn' })).toBeTruthy();
  fireEvent.click(screen.getByText('Read root'));
  expect(document.title).toBe('(2) agent-graph');
  expect(JSON.parse(localStorage.getItem(READ_KEY)!)).toEqual({ root: LAST });
  view.unmount();
  render(<MemoryRouter><TurnSignals target={target} bindings={DEFAULT_KEYS}/></MemoryRouter>);
  expect(document.title).toBe('(2) agent-graph');
  const snapshot = target.getSnapshot();
  act(() => target.setSnapshot({ ...snapshot, projection: { ...snapshot.projection, approvals: [], runs: [] } }));
  expect(document.title).toBe('agent-graph');
});
it('draws a canvas badge over the original icon and restores it at zero', () => {
  const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = '/original.svg'; icon.type = 'image/svg+xml'; document.head.append(icon);
  const { rerender } = render(<TabBadge count={3}/>);
  expect(icon.getAttribute('href')).toBe('data:image/png;base64,badge');
  expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalledWith('2d');
  rerender(<TabBadge count={0}/>);
  expect(icon.getAttribute('href')).toBe('/original.svg'); expect(icon.type).toBe('image/svg+xml'); expect(document.title).toBe('agent-graph');
});
it('navigates to the oldest turn with g n, cycles onward and ignores typing and open dialogs', () => {
  render(<MemoryRouter><TurnSignals target={fixture()} bindings={DEFAULT_KEYS}/><Location/><input aria-label="Draft"/></MemoryRouter>);
  fireEvent.keyDown(document, { key: 'g' }); fireEvent.keyDown(document, { key: 'n' });
  expect(screen.getByTestId('route').textContent).toBe('/inbox?approval=a');
  fireEvent.keyDown(document, { key: 'g' }); fireEvent.keyDown(document, { key: 'n' });
  expect(screen.getByTestId('route').textContent).toBe('/c/input');
  fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'g' }); fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'n' });
  expect(screen.getByTestId('route').textContent).toBe('/c/input');
});
it('keeps ten unique recent conversations in opening order and tolerates invalid storage', () => {
  let history = EMPTY as ReturnType<typeof readHistory>;
  for (let index = 0; index < 12; index++) history = rememberConversation(history, String(index));
  history = rememberConversation(history, '3');
  expect(history.recent).toEqual(['3', '11', '10', '9', '8', '7', '6', '5', '4', '2']);
  localStorage.setItem(RECENT_KEY, JSON.stringify(history.recent)); expect(readHistory().recent).toEqual(history.recent);
  localStorage.setItem(RECENT_KEY, '{'); expect(readHistory().recent).toEqual([]);
});
it('opens recent conversation positions with Alt numbers and includes bilingual key labels', () => {
  localStorage.setItem(RECENT_KEY, JSON.stringify(['root', 'input']));
  render(<MemoryRouter><TurnSignals target={fixture()} bindings={DEFAULT_KEYS}/><Location/></MemoryRouter>);
  fireEvent.keyDown(document, { key: '2', altKey: true });
  expect(screen.getByTestId('route').textContent).toBe('/c/input');
  expect(readHistory().recent).toEqual(['input', 'root']);
  fireEvent.keyDown(document, { key: '2', metaKey: true });
  expect(screen.getByTestId('route').textContent).toBe('/c/input');
  for (const language of ['en', 'ja'] as const) { expect(keyLabel('recent9', language)).toBeTruthy(); expect(keyLabel('nextTurn', language)).toBeTruthy(); }
});
it('orders palette turns before recents before other commands and removes review and duplicate names', () => {
  const state = fixture().getSnapshot();
  state.projection.conversations.push({ id: 'review', name: 'Review of Do not edit files.' }, { id: 'duplicate', name: 'Build' }, { id: 'recent', name: 'Recently read' });
  state.projection.relations = [{ id: 'review-link', type: 'review_of', from_id: 'review', to_id: 'root', active: 1 }];
  const navigate = vi.fn();
  const commands = [{ id: 'home', name: 'Go home', run: vi.fn() }, { id: 'conversation-root', name: 'Open active conversation: Build', run: vi.fn() }];
  const snapshot = { state, navigate, history: { ...EMPTY, recent: ['review', 'recent'] }, turns: selectTurns(state, EMPTY) };
  const ordered = orderCommands(commands, snapshot, 'en');
  expect(ordered.map(command => command.name)).toEqual(['Open approval: a', 'Open conversation: Question', 'Open conversation: Recently read', 'Go home', 'Open active conversation: Build']);
  render(<CommandPalette commands={orderCommands(commands, snapshot, 'ja')} language="ja" onClose={vi.fn()}/>);
  expect(screen.getByRole('button', { name: '承認を開く: a' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '会話を開く: Recently read' }));
  expect(navigate).toHaveBeenCalledWith('/c/recent');
});
it('renders an encoded root URL and preserves normal selection and modified clicks', () => {
  const root = { ...selectRoots(fixture().getSnapshot())[0], id: 'root /?', project: 'project /?' };
  const select = vi.fn();
  render(<MemoryRouter><RootList roots={[root]} selected={root.id} onSelect={select} language="ja"/></MemoryRouter>);
  const link = screen.getByRole('link', { name: /Build/ });
  expect(link.getAttribute('href')).toBe('/p/project%20%2F%3F?root=root%20%2F%3F'); expect(link.getAttribute('aria-current')).toBe('page');
  fireEvent.click(link); expect(select).toHaveBeenCalledExactlyOnceWith(root);
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) expect(fireEvent.click(link, modifiers)).toBe(true);
  expect(select).toHaveBeenCalledOnce();
});

it('keeps a completion unread in a background tab until the conversation becomes visible', () => {
  const target = fixture();
  render(<MemoryRouter initialEntries={['/c/root']}><TurnSignals target={target} bindings={DEFAULT_KEYS}/></MemoryRouter>);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => target.setSnapshot(idle(target.getSnapshot())));
  expect(document.title).toBe('(3) agent-graph');
  expect(readHistory().read.root).toBeUndefined();
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(document.title).toBe('(2) agent-graph');
  expect(readHistory().read.root).toBe(LAST);
});
