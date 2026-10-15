import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, applyIncremental, readLedgerDatabase } from '../../packages/core/src/ledger/index.ts';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';
import { renameSession } from '../../packages/api/src/ws/session-rename.ts';

/** 配信中の画面で改名する。WebSocket の書き込み先は、この一時台帳だけに固定する。 */
export async function verifyRename(browser, base) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-graph-smoke-rename-'));
  const ledger = openLedger(join(directory, 'ledger.db'));
  let feed;
  let context;
  try {
    const id = JSON.stringify(['claude', 'rename-fixture']);
    ledger.append({ source: 'hook', source_event_id: 'fixture', kind: 'conversation.created', subject: `conversation:${id}`,
      source_ts: new Date().toISOString(), confidence: 'confirmed',
      payload: { provider: 'claude', native_id: 'rename-fixture', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'smoke-fixture' } });
    feed = new ProjectionFeed(join(directory, 'ledger.db'), () => applyIncremental(readLedgerDatabase(ledger), 0));
    context = await browser.newContext();
    await context.route('**/*', route => {
      const request = route.request();
      if (request.method() !== 'GET') return route.abort();
      const url = new URL(request.url());
      const data = url.pathname === '/snapshot' ? feed.snapshot()
        : url.pathname === '/conversation' ? feed.conversation(url.searchParams.get('id'))
        : url.pathname === '/projection' ? feed.list(url.searchParams.get('table'), url.searchParams.get('after') ?? '')
        : url.pathname === '/api/send-watches' ? [] : undefined;
      return data === undefined ? route.continue() : route.fulfill({ json: data });
    });
    const writes = [];
    await context.routeWebSocket(/\/ws(\?|$)/, socket => {
      // connectToServer は呼ばない。本番の命令口には一切接続しない。
      socket.onMessage(async data => {
        const message = JSON.parse(String(data));
        if (message.type !== 'cmd') return;
        try {
          let result;
          if (message.command === 'session.rename') {
            assert.equal(message.payload.rootId, id);
            result = await renameSession(ledger, feed.snapshot().projection.roots, message);
            writes.push(message);
            const patch = feed.refresh();
            assert.ok(patch && patch !== 'resync');
            socket.send(JSON.stringify(patch));
          } else if (message.command === 'session.hosts') result = { hosts: [] };
          else if (message.command === 'list_models') result = [];
          else if (['settings.read', 'settings.status', 'settings.models', 'usage.read', 'models.table', 'models.resolve', 'session.commands', 'ssh.read'].includes(message.command)) result = {};
          else throw new Error(`Unexpected fixture command: ${message.command}`);
          socket.send(JSON.stringify({ type: 'ack', cmd_id: message.cmd_id, ok: true, result }));
        } catch (error) {
          socket.send(JSON.stringify({ type: 'ack', cmd_id: message.cmd_id, ok: false, error: error.message }));
        }
      });
    });
    const page = await context.newPage();
    await page.goto(`${base}/p/other?root=${encodeURIComponent(id)}`);
    const link = () => page.locator('a.root-row[aria-current="page"]');
    await link().waitFor({ timeout: 20_000 });
    const original = await link().getAttribute('aria-label');
    const name = `smoke-${Date.now().toString(36)}`;
    await link().dblclick();
    const input = () => page.getByRole('textbox', { name: 'Rename', exact: true });
    await input().fill(name); await input().press('Enter');
    await page.getByRole('link', { name, exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(feed.snapshot().projection.roots[0].name, name);
    await page.reload();
    await page.getByRole('link', { name, exact: true }).waitFor({ timeout: 10_000 });
    await link().dblclick();
    await input().fill(''); await input().press('Enter');
    await page.getByRole('link', { name: original, exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(writes.length, 2);
    assert.equal(ledger.readSince(0, 100).filter(fact => fact.kind === 'conversation.renamed').length, 2);
    return `"${original}" -> "${name}" -> "${original}"; reload and ledger verified`;
  } finally {
    await context?.close();
    feed?.close(); ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
}
