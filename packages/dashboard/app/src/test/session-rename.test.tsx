import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { RootList } from '../components/RootViews.tsx';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { createStore } from '../lib/store.ts';
import { selectRoots, type Root } from '../lib/roots.ts';
afterEach(cleanup);
const root: Root = { id: 'r', name: 'repo-20261001', project: 'p', state: 'idle', conversation_ids: ['r'], last_activity_ts: null, running_children: 0, total_children: 0 };
function makeClient() { return { command: vi.fn(async () => ({ type: 'ack' as const, cmd_id: 'cmd', ok: true })) }; }
it('edits the list with double click, confirms with Enter and cancels with Escape', async () => {
  const client = makeClient(); render(<MemoryRouter><RootList roots={[root]} client={client}/></MemoryRouter>);
  fireEvent.doubleClick(screen.getByRole('link', { name: root.name }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Rename' }), { target: { value: 'New name' } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('session.rename', { rootId: 'r', name: 'New name' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  fireEvent.doubleClick(screen.getByRole('link')); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); expect(screen.queryByRole('textbox')).toBeNull(); expect(client.command).toHaveBeenCalledTimes(1);
});
it('opens rename from the context menu and sends an empty name to restore the automatic name', async () => {
  const client = makeClient(); render(<MemoryRouter><RootList roots={[root]} client={client} language="ja"/></MemoryRouter>);
  fireEvent.contextMenu(screen.getByRole('link')); fireEvent.click(screen.getByRole('menuitem', { name: '名前を変える' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('session.rename', { rootId: 'r', name: '' }));
});
it('edits the conversation heading by clicking the name', async () => {
  const client = makeClient(); const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { roots: [{ ...root }], conversations: [{ id: 'r', provider: 'claude', origin: 'observed', type: 'interactive' }] } });
  render(<MemoryRouter><ConversationPage conversationId="r" target={target} client={client}/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Rename' })); fireEvent.change(screen.getByRole('textbox', { name: 'Rename' }), { target: { value: 'Heading name' } }); fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename' }), { key: 'Enter' });
  await waitFor(() => expect(client.command).toHaveBeenCalledWith('session.rename', { rootId: 'r', name: 'Heading name' }));
});
it('keeps automatic date numbering while showing user names with the automatic name in title', () => {
  const target = createStore(); target.setSnapshot({ seq: 1, generation: 0, projection: { roots: [{ ...root, name: 'Custom', auto_name: 'repo-001', user_name: 'Custom' }, { ...root, id: 's', name: 'repo-002', conversation_ids: ['s'] }], conversations: [{ id: 'r', created_ts: '2026-10-01T00:00:00Z' }, { id: 's', created_ts: '2026-10-01T01:00:00Z' }] } });
  const roots = selectRoots(target.getSnapshot()); const custom = roots.find(row => row.id === 'r')!;
  expect(custom.name).toBe('Custom'); expect(custom.auto_name).toBe('repo-20261001'); expect(roots.find(row => row.id === 's')?.name).toBe('repo-20261001-2'); expect(custom.kit_name).toBe('repo-001');
  render(<MemoryRouter><RootList roots={roots} client={makeClient()}/></MemoryRouter>); expect(screen.getByRole('link', { name: 'Custom' }).title).toContain('repo-20261001');
});
