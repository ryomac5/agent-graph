import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createStore } from '../lib/store.ts';
import { orderSeries, selectRoots } from '../lib/roots.ts';
import { visibleText } from '../lib/message-body.ts';
import { Message } from '../components/conversation/Message.tsx';
import { WorkspacePage } from '../pages/workspace/WorkspacePage.tsx';

// 本番の画面で見つかった崩れの試験。
beforeEach(() => { localStorage.clear(); vi.stubGlobal('innerWidth', 1440); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const client = { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'c', ok: true, result: [] })) };
function store() {
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: {
    projects: [{ id: 'repo', display_name: 'Repo', root_path: '/repo', state: 'registered' }],
    roots: [
      { id: 'old', name: 'agent-graph-001', project: 'repo', state: 'running', last_activity_ts: '2026-10-08T01:00:00Z', conversation_ids: ['old', 'new', 'mid'], running_children: 0, total_children: 0 },
      { id: 'review', name: 'review', project: null, state: 'running', last_activity_ts: '2026-10-08T01:00:00Z', conversation_ids: ['review'], running_children: 0, total_children: 0 },
    ],
    conversations: [
      { id: 'old', provider: 'claude', type: 'interactive', origin: 'observed', last_message_ts: '2026-09-25T00:00:00Z' },
      { id: 'new', provider: 'claude', type: 'interactive', origin: 'observed', last_message_ts: '2026-09-26T00:00:00Z' },
      { id: 'mid', provider: 'claude', type: 'interactive', origin: 'observed', last_message_ts: '2026-09-27T00:00:00Z' },
      { id: 'review', provider: 'claude', type: 'interactive', origin: 'observed' },
    ],
    runs: [
      { id: 'old:1', conversation_id: 'old', generation: 1, state: 'idle', last_evidence_ts: '2026-09-25T00:00:00Z' },
      { id: 'new:1', conversation_id: 'new', generation: 1, state: 'running', last_evidence_ts: '2026-10-08T01:00:00Z' },
      { id: 'mid:1', conversation_id: 'mid', generation: 1, state: 'idle', last_evidence_ts: '2026-09-27T00:00:00Z' },
    ],
    relations: [{ id: 'review-of', type: 'review_of', active: 1, from_id: 'review', to_id: 'old', confidence: 'confirmed' }],
    messages: [
      { id: 'm-old', role: 'user', body: 'September request', source_ts: '2026-09-25T00:00:00Z' },
      { id: 'm-new', role: 'assistant', body: 'Latest answer', source_ts: '2026-10-08T01:00:00Z' },
      { id: 'm-mid', role: 'assistant', body: 'Middle answer', source_ts: '2026-09-27T00:00:00Z' },
    ],
    message_memberships: [['m-old', 'old'], ['m-new', 'new'], ['m-mid', 'mid']].map(([message, conversation]) => ({ id: message, message_id: message, conversation_id: conversation, active: 1 })),
  } });
  return target;
}

it('orders a series by its last activity and shows the latest message last with the series state', () => {
  const target = store();
  expect(orderSeries(target.getSnapshot(), ['old', 'new', 'mid'])).toEqual(['old', 'mid', 'new']);
  render(<MemoryRouter><WorkspacePage project="repo" target={target} client={client}/></MemoryRouter>);
  const texts = [...document.querySelectorAll('.conv-timeline article')].map(article => article.textContent ?? '');
  expect(texts.at(-1)).toContain('Latest answer');
  expect(texts[0]).toContain('September request');
  const header = document.querySelector<HTMLElement>('.conv-header')!;
  expect(within(header).getByRole('link', { name: 'Running · Details' })).toBeTruthy();
});
it('keeps reviewer conversations out of the root list', () => {
  expect(selectRoots(store().getSnapshot()).map(root => root.id)).toEqual(['old']);
});
it('opens the request flow at 1280 pixels or more unless the user collapsed it', () => {
  render(<MemoryRouter><WorkspacePage project="repo" target={store()} client={client}/></MemoryRouter>);
  const toggle = screen.getByRole('button', { name: 'Hide requests' });
  fireEvent.click(toggle);
  expect(localStorage.getItem('agent-graph-requests-open')).toBe('0');
  cleanup();
  render(<MemoryRouter><WorkspacePage project="repo" target={store()} client={client}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Show requests' }));
  expect(localStorage.getItem('agent-graph-requests-open')).toBeNull();
});
it('does not draw a bubble for user rows that only carry injected text or tool results', () => {
  expect(visibleText('<system-reminder>Plan mode</system-reminder>\n')).toBe('');
  expect(visibleText('<command-name>/model</command-name>')).toBe('/model');
  const sender = { key: 'user', name: 'User', side: 'end' as const };
  const injected = render(<Message row={{ id: 'a', role: 'user', body: '<system-reminder>hook text</system-reminder>' }} sender={sender}/>);
  expect(injected.container.querySelector('article')).toBeNull();
  const result = render(<Message row={{ id: 'b', role: 'user', body: [{ type: 'tool_result', tool_use_id: 'elsewhere', content: 'ok' }] }} sender={sender}/>);
  expect(result.container.querySelector('article')).toBeNull();
  const written = render(<Message row={{ id: 'c', role: 'user', body: 'Please fix it' }} sender={sender}/>);
  expect(written.container.querySelector('.message-bubble')?.textContent).toContain('Please fix it');
});
