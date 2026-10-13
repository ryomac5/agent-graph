import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ConversationPage } from '../pages/conversation/ConversationPage.tsx';
import { createStore } from '../lib/store.ts';
import { startSession } from '../lib/session-start.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const id = '["claude","new"]';
const host = { conversationId: id, terminalId: 'terminal', provider: 'claude', cwd: '/repo', projectId: 'p' };
it('carries the selected launch model with the discovered host', async () => {
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: name, ok: true,
    result: name === 'session.launch' ? { terminalId: 'terminal' } : { hosts: [host] } }));
  expect(await startSession({ command }, { projectId: 'p', provider: 'claude', model: 'haiku' }, {
    onLaunched() {}, active: () => true,
  })).toEqual({ ...host, launchModel: 'haiku' });
});
it('uses the launch model on the first render, through host refresh, until an observed model arrives', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ projection: {}, generation: 1 }) })));
  const target = createStore();
  target.setSnapshot({ seq: 1, generation: 1, projection: { projects: [{ id: 'p', root_path: '/repo' }] } });
  target.setConnection('connected');
  const command = vi.fn(async (name: string) => ({ type: 'ack' as const, cmd_id: name, ok: true,
    result: name === 'session.hosts' ? { hosts: [host] }
      : name === 'settings.models' ? { defaults: { model: 'opus', displayName: 'Opus 5.5' } }
      : name === 'list_models' ? [{ model: 'default', displayName: 'Default (recommended)' }, { model: 'opus', displayName: 'Opus 5.5' }, { model: 'haiku', displayName: 'Haiku 5.5' }]
      : {} }));
  render(<MemoryRouter initialEntries={[{ pathname: '/c/new', state: { sessionHost: { ...host, launchModel: 'haiku' } } }]}>
    <ConversationPage conversationId={id} target={target} client={{ command }} language="en"/>
  </MemoryRouter>);
  expect(screen.getByRole('button', { name: /^Model · / }).textContent?.toLowerCase()).toContain('haiku');
  await act(async () => {});
  expect(screen.getByRole('button', { name: /^Model · / }).textContent).toContain('Haiku 5.5');
  expect(screen.getByRole('button', { name: /^Model · / }).textContent).not.toContain('Recommended');
  act(() => target.applyPatch({ type: 'patch', from_seq: 1, seq: 2, generation: 1, changes: {
    conversations: { upsert: [{ id, provider: 'claude', origin: 'observed' }], remove: [] },
    runs: { upsert: [{ id: `${id}:1`, conversation_id: id, generation: 1, state: 'idle', model: 'claude-sonnet-5-5' }], remove: [] },
  } }));
  expect(screen.getByRole('button', { name: /^Model · / }).textContent).toContain('Sonnet 5.5');
});
