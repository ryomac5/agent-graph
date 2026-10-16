import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const id = '["claude","hidden"]';

it.each([`/c/${encodeURIComponent(id)}`, `/p/p?root=${encodeURIComponent(id)}`, `/p/p?conversation=${encodeURIComponent(id)}`])(
  'opens hidden conversation at %s without adding it to the sidebar or selecting another root', async url => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const target = createStore();
    target.setSnapshot({ seq: 2, generation: 1, projection: {
      projects: [{ id: 'p', display_name: 'Project', root_path: '/repo', state: 'registered' }],
      roots: [{ id: 'visible', name: 'Visible conversation', project: 'p', state: 'idle', conversation_ids: ['visible'] }],
      conversations: [{ id: 'visible', name: 'Visible conversation', project: 'p', provider: 'claude' }],
    } });
    const page = { generation: 1, projection: {
      conversations: [{ id, name: 'Hidden conversation', project: 'p', provider: 'claude', origin: 'observed', type: 'interactive', hidden: 1 }],
      messages: [{ id: 'message', role: 'user', body: 'Hidden transcript remains readable', source_ts: '2026-10-14T00:00:00Z' }],
      message_memberships: [{ id: 'member', conversation_id: id, message_id: 'message', active: 1 }],
    }, next: null };
    const fetchConversation = vi.fn(async () => page);
    const command = vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true, result: {} }));
    render(<MemoryRouter initialEntries={[url]}><App target={target} client={{ command, fetchConversation }}/></MemoryRouter>);
    expect(await screen.findByText('Hidden transcript remains readable')).toBeTruthy();
    const sidebar = await screen.findByRole('navigation', { name: 'Projects' });
    expect(within(sidebar).queryByRole('link', { name: 'Hidden conversation' })).toBeNull();
    expect(sidebar.querySelector('a.root-row[aria-current="page"]')).toBeNull();
    expect(screen.queryByText('Conversation not found')).toBeNull();
    expect(target.getSnapshot().projection.roots.map(row => row.id)).toEqual(['visible']);
    expect(fetchConversation).toHaveBeenCalled();
  },
);
