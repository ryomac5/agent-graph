import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameSession } from '../src/ws/session-rename.ts';
import { openLedger, project } from '../../core/src/ledger/index.ts';

test('rename records a UI fact, keeps kit links, replays once, and clears with empty text', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ag-rename-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = openLedger(join(directory, 'ledger.sqlite')); t.after(() => ledger.close());
  ledger.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  const roots = () => project(ledger.readSince(0, 100)).roots;
  const rootId = roots()[0].id;
  const cmd = { type: 'cmd' as const, cmd_id: 'rename', command: 'session.rename', payload: { rootId, name: 'My session' } };
  renameSession(ledger, roots(), cmd); renameSession(ledger, roots(), cmd);
  const facts = ledger.readSince(0, 100); assert.equal(facts.filter(f => f.kind === 'conversation.renamed').length, 1);
  assert.equal(roots()[0].name, 'My session'); assert.equal(roots()[0].auto_name, 'repo-001');
  for (const name of ['x'.repeat(81), 'bad\nname']) assert.throws(() => renameSession(ledger, roots(), { ...cmd, payload: { rootId, name } }));
  assert.throws(() => renameSession(ledger, roots(), { ...cmd, payload: { rootId: 'absent', name: 'Name' } }));
  renameSession(ledger, roots(), { ...cmd, cmd_id: 'clear', payload: { rootId, name: '  ' } });
  assert.equal(roots()[0].name, 'repo-001');
});

testSocket('API accepts rename while runner is unavailable and publishes names in root patches and snapshots', async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { startWebSocketServer, WebSocket } = await import('../src/ws/index.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-rename-ws-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = openObservationService({ dbPath: join(directory, 'ledger.sqlite'), live: false }); t.after(() => service.close());
  service.ledger.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  const api = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'missing.sock') }); t.after(() => api.close());
  const snapshot = () => fetch(api.url + '/snapshot', { headers: { 'x-agent-graph-token': api.token, Origin: api.url } }).then(response => response.json()) as Promise<any>;
  const initial = await snapshot(); const rootId = initial.projection.roots[0].id;
  const socket = new WebSocket(api.wsUrl + '?token=' + api.token, { origin: api.url }); t.after(() => socket.terminate());
  const messages: any[] = []; socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail); });
  socket.send(JSON.stringify({ type: 'hello', seq: initial.seq, generation: initial.generation }));
  socket.send(JSON.stringify({ type: 'cmd', cmd_id: 'rename', command: 'session.rename', payload: { rootId, name: 'New session' } }));
  const deadline = Date.now() + 5000;
  while (!messages.some(message => message.type === 'ack' && message.cmd_id === 'rename')) {
    assert.ok(Date.now() < deadline, 'rename ack timed out'); await new Promise(done => setTimeout(done, 10));
  }
  assert.equal(messages.find(message => message.type === 'ack').ok, true);
  assert.ok(messages.some(message => message.type === 'patch' && message.changes.roots?.upsert.some((root: any) => root.name === 'New session')));
  const renamed = await snapshot(); assert.equal(renamed.projection.roots[0].user_name, 'New session'); assert.equal(renamed.projection.roots[0].auto_name, 'repo-001');
});

function testSocket(name: string, action: (t: TestContext) => Promise<void>): void {
  test(name, { timeout: 15000 }, async t => {
    try { await action(t); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM' && 'syscall' in error && error.syscall === 'listen')) throw error;
      t.skip('sandbox blocks local TCP socket listen');
    }
  });
}

test('projection feed publishes rename and clearing without changing delegation targets', async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { ProjectionFeed } = await import('../src/service/projection-feed.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-rename-feed-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = openObservationService({ dbPath: join(directory, 'ledger.sqlite'), live: false }); t.after(() => service.close());
  service.ledger.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  const feed = new ProjectionFeed(service.dbPath, service.catchUp); t.after(() => feed.close());
  const before = feed.snapshot().projection.roots;
  const rootId = String(before[0].id);
  renameSession(service.ledger, before as any, { type: 'cmd', cmd_id: 'name', command: 'session.rename', payload: { rootId, name: 'New name' } });
  const patch = feed.refresh(); assert.ok(patch && patch !== 'resync'); assert.equal(patch.changes.roots.upsert[0].name, 'New name');
  const renamed = feed.snapshot().projection.roots; assert.equal(renamed[0].auto_name, 'repo-001'); assert.deepEqual(renamed[0].conversation_ids, before[0].conversation_ids);
  renameSession(service.ledger, renamed as any, { type: 'cmd', cmd_id: 'clear', command: 'session.rename', payload: { rootId, name: '' } });
  const cleared = feed.refresh(); assert.ok(cleared && cleared !== 'resync'); assert.equal(cleared.changes.roots.upsert[0].name, 'repo-001'); assert.equal(cleared.changes.roots.upsert[0].user_name, undefined);
});
