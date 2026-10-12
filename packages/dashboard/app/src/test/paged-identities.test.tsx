import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPagedIdentityFeed, TURN_START } from '../../../../api/test/fixtures/paged-identities.ts';
import { App } from '../App.tsx';
import { createStore } from '../lib/store.ts';
import { resolveActivity } from '../lib/activity.ts';
import { resolveWorkingTurn, workingElapsed } from '../lib/turns.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(TURN_START) + 192_000);
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['page', 'snapshot', 'patch'] as const)('joins legacy runs beyond row 1000 and shows Working and elapsed time through %s', async route => {
  const directory = mkdtempSync(join(tmpdir(), 'screen-paged-identities-'));
  const fixture = createPagedIdentityFeed(join(directory, 'ledger.db'));
  try {
    const target = createStore();
    const snapshot = JSON.parse(JSON.stringify(fixture.feed.snapshot()));
    // 全対応表とページ添付のどちらかが欠けても解決する。
    if (route !== 'snapshot') snapshot.identities = { conversations: {}, runs: {} };
    target.setSnapshot(snapshot);
    target.setConnection('connected');
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      let body: unknown = { generation: snapshot.generation, projection: { messages: [], message_memberships: [] }, next: null };
      if (url.pathname === '/projection') {
        const page = fixture.feed.list(url.searchParams.get('table')!, url.searchParams.get('after')!);
        body = { ...page, identities: route === 'snapshot' ? undefined : page.identities };
      }
      return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
    }));
    if (route === 'patch') {
      snapshot.pages = {};
      target.setSnapshot(snapshot);
      expect(target.applyPatch(JSON.parse(fixture.feed.serializePatch(fixture.updateRuns())))).toBe(true);
    }
    const canonical = fixture.targets[0].canonical;
    render(<MemoryRouter initialEntries={[`/c/${encodeURIComponent(canonical)}`]}><App target={target}/></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('Working · 3m 12s');
    const toggle = screen.getByRole('button', { name: 'Toggle sessions for Other' });
    if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    const row = document.querySelector('.root-row');
    expect(row?.textContent).toContain('Working');
    expect(row?.querySelector('.root-elapsed')?.textContent).toBe('3m 12s');
    for (const { legacy, canonical } of fixture.targets) {
      const state = target.getSnapshot();
      const run = resolveActivity(state, [canonical]).run;
      expect(run).toMatchObject({ id: `${canonical}:1`, conversation_id: canonical });
      expect(workingElapsed(resolveWorkingTurn(run), Date.now())).toBe('3m 12s');
      expect(state.identities?.conversations[legacy]).toBe(canonical);
    }
    act(() => { expect(target.applyPatch(JSON.parse(fixture.feed.serializePatch(fixture.createRuns())))).toBe(true); });
    expect(screen.getByRole('status', { name: 'Working' }).textContent).toContain('Working · 3m 12s');
    for (const { canonical } of fixture.targets) expect(resolveActivity(target.getSnapshot(), [canonical]).run?.id).toBe(`${canonical}:2`);
    // 別の部分対応表が届いても、先に取り込んだ対応を失わない。
    act(() => target.applyPatch({ type: 'patch', from_seq: target.getSnapshot().seq, seq: target.getSnapshot().seq + 1,
      generation: snapshot.generation, identities: { conversations: { other: '["codex","other"]' }, runs: {} }, changes: {} }));
    target.appendDelta({ runId: `${fixture.targets[0].legacy}:1`, text: 'progress' });
    expect(Object.values(target.getSnapshot().deltas)[0].runId).toBe(`${canonical}:1`);
  } finally { fixture.close(); rmSync(directory, { recursive: true }); }
});
