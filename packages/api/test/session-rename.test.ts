import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renameSession } from '../src/ws/session-rename.ts';
import { openLedger, project } from '../../core/src/ledger/index.ts';
import type { UiFactInput } from '../src/service/index.ts';

test('rename records a UI fact, keeps kit links, replays once, and clears with empty text', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ag-rename-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = openLedger(join(directory, 'ledger.sqlite')); t.after(() => ledger.close());
  ledger.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  const roots = () => project(ledger.readSince(0, 100)).roots;
  const rootId = roots()[0].id;
  const cmd = { type: 'cmd' as const, cmd_id: 'rename', command: 'session.rename', payload: { rootId, name: 'My session' } };
  await renameSession(ledger, roots(), cmd); await renameSession(ledger, roots(), cmd);
  const facts = ledger.readSince(0, 100); assert.equal(facts.filter(f => f.kind === 'conversation.renamed').length, 1);
  assert.equal(roots()[0].name, 'My session'); assert.equal(roots()[0].auto_name, 'repo-001');
  for (const name of ['x'.repeat(81), 'bad\nname']) await assert.rejects(renameSession(ledger, roots(), { ...cmd, payload: { rootId, name } }));
  await assert.rejects(renameSession(ledger, roots(), { ...cmd, payload: { rootId: 'absent', name: 'Name' } }));
  await renameSession(ledger, roots(), { ...cmd, cmd_id: 'clear', payload: { rootId, name: '  ' } });
  assert.equal(roots()[0].name, 'repo-001');
});

for (const useWorker of [false, true]) testSocket(`API accepts rename while runner is unavailable and publishes names in root patches and snapshots (worker=${useWorker})`, async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { startWebSocketServer, WebSocket } = await import('../src/ws/index.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-rename-ws-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, 'ledger.sqlite');
  const seed = openLedger(dbPath);
  seed.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  seed.close();
  const service = openObservationService({ dbPath, live: false, readerOnly: useWorker });
  const { startObservationWorker } = await import('../src/service/worker-client.ts');
  const worker = useWorker ? await startObservationWorker(service, { observe: false, hook: false, home: directory }) : undefined;
  t.after(async () => { await worker?.close(); service.close(); });
  const api = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'missing.sock') }); t.after(() => api.close());
  const snapshot = () => fetch(api.url + '/snapshot', { headers: { 'x-agent-graph-token': api.token, Origin: api.url } }).then(response => response.json()) as Promise<any>;
  let initial = await snapshot();
  const initialDeadline = Date.now() + 5000;
  while (!initial.projection.roots.length) {
    assert.ok(Date.now() < initialDeadline, 'initial root projection timed out');
    await new Promise(done => setTimeout(done, 10)); initial = await snapshot();
  }
  const rootId = initial.projection.roots[0].id;
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
  assert.equal(service.ledger.readSince(0, 100).find(fact => fact.kind === 'conversation.renamed')?.payload?.user_name, 'New session');
  while (!messages.some(message => message.type === 'patch' && message.changes.roots?.upsert.some((root: any) => root.name === 'New session'))) {
    assert.ok(Date.now() < deadline, 'rename root patch timed out'); await new Promise(done => setTimeout(done, 10));
  }
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
  await renameSession(service.ledger, before as any, { type: 'cmd', cmd_id: 'name', command: 'session.rename', payload: { rootId, name: 'New name' } });
  const patch = feed.refresh(); assert.ok(patch && patch !== 'resync'); assert.equal(patch.changes.roots.upsert[0].name, 'New name');
  const renamed = feed.snapshot().projection.roots; assert.equal(renamed[0].auto_name, 'repo-001'); assert.deepEqual(renamed[0].conversation_ids, before[0].conversation_ids);
  await renameSession(service.ledger, renamed as any, { type: 'cmd', cmd_id: 'clear', command: 'session.rename', payload: { rootId, name: '' } });
  const cleared = feed.refresh(); assert.ok(cleared && cleared !== 'resync'); assert.equal(cleared.changes.roots.upsert[0].name, 'repo-001'); assert.equal(cleared.changes.roots.upsert[0].user_name, undefined);
});

test('reader-only API renames through the observation worker and projects roots', { timeout: 15000 }, async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { startObservationWorker } = await import('../src/service/worker-client.ts');
  const { ProjectionFeed } = await import('../src/service/projection-feed.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-rename-worker-'));
  const dbPath = join(directory, 'ledger.sqlite');
  const seed = openLedger(dbPath);
  seed.append({ source: 'kit', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'r', origin: 'observed', type: 'interactive', history_format: 'jsonl', kit_name: 'repo-001' } });
  const roots = project(seed.readSince(0, 100)).roots;
  seed.close();
  const service = openObservationService({ dbPath, readerOnly: true, live: false });
  const worker = await startObservationWorker(service, { observe: false, hook: false, home: directory });
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  t.after(async () => { feed.close(); await worker.close(); service.close(); rmSync(directory, { recursive: true, force: true }); });
  worker.start();
  const input: UiFactInput = { source: 'ui', source_event_id: 'invalid', kind: 'conversation.renamed', subject: 'conversation:r', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { user_name: 'Invalid' } };
  assert.throws(() => service.ledger.append(input), /Ledger writes belong to the observation worker/);
  for (const source of ['hook', 'transcript-claude', 'rollout-codex']) {
    await assert.rejects(service.appendUi({ ...input, source } as UiFactInput), /Only ui facts/);
  }
  await assert.rejects(service.appendUi({ ...input, source_event_id: '' }), /source_event_id/);
  const command = { type: 'cmd' as const, cmd_id: 'worker-name', command: 'session.rename', payload: { rootId: roots[0].id, name: 'Worker name' } };
  const writer = { append: service.appendUi };
  const results = await Promise.all([renameSession(writer, roots, command), renameSession(writer, roots, command)]);
  assert.deepEqual(results, [{ rootId: roots[0].id, name: 'Worker name' }, { rootId: roots[0].id, name: 'Worker name' }]);
  const facts = service.ledger.readSince(0, 100).filter(fact => fact.kind === 'conversation.renamed');
  assert.equal(facts.length, 1); assert.equal(facts[0].source, 'ui');
  await assert.rejects(renameSession(writer, roots, { ...command, payload: { ...command.payload, name: 'Conflicting name' } }), /Conflicting session rename/);
  async function waitForName(name: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (feed.snapshot().projection.roots[0]?.name !== name) {
      assert.ok(Date.now() < deadline, 'worker rename projection timed out');
      await new Promise(done => setTimeout(done, 10)); feed.refresh();
    }
  }
  await waitForName('Worker name');
  assert.equal(feed.snapshot().projection.roots[0].auto_name, 'repo-001');
  await renameSession(writer, roots, { ...command, cmd_id: 'worker-clear', payload: { ...command.payload, name: '' } });
  await waitForName('repo-001');
  await worker.close();
  await assert.rejects(service.appendUi(input), /Observation worker stopped/);
});

test('latest series rename wins, including terminal custom titles, late facts and clearing, without rebuild', async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { ProjectionFeed } = await import('../src/service/projection-feed.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-series-name-'));
  const service = openObservationService({ dbPath: join(directory, 'ledger.sqlite'), live: false });
  const feed = new ProjectionFeed(service.dbPath, service.catchUp);
  t.after(() => { feed.close(); service.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const [id, day] of [['old', '01'], ['fork', '02']]) service.ledger.append({ source: 'kit', source_event_id: id, kind: 'conversation.created', subject: `conversation:${id}`, source_ts: `2026-10-${day}T00:00:00Z`, confidence: 'confirmed', payload: { provider: 'claude', native_id: id, origin: 'observed', history_format: 'jsonl', type: 'interactive', kit_name: 'repo-001' } });
  function rename(id: string, name: string | null, day: string) {
    service.ledger.append({ source: 'transcript-claude', source_event_id: `custom-title:${id}:${day}`, kind: 'conversation.updated', subject: `conversation:${id}`, source_ts: `2026-10-${day}T00:00:00Z`, confidence: 'confirmed', payload: { user_name: name } });
    feed.refresh();
  }
  rename('old', 'Original', '03'); rename('fork', 'Terminal title', '04');
  function expectName(name: string) {
    assert.equal(feed.snapshot().projection.roots[0].name, name);
    assert.equal(project(service.ledger.readSince(0, 100)).roots[0].name, name);
  }
  expectName('Terminal title');
  rename('old', 'Older late title', '02'); expectName('Terminal title');
  await renameSession({ append: service.appendUi }, feed.snapshot().projection.roots as any, { type: 'cmd', cmd_id: 'ui', command: 'session.rename', payload: { rootId: JSON.stringify(['claude', 'old']), name: 'Browser title' } });
  feed.refresh(); expectName('Browser title');
  rename('fork', null, '30'); expectName('repo-001');
});

test('rename resolves a root beyond the first snapshot page', async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { ProjectionFeed } = await import('../src/service/projection-feed.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-many-roots-'));
  const service = openObservationService({ dbPath: join(directory, 'ledger.sqlite'), live: false });
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  for (let i = 0; i < 1001; i++) {
    const id = `root-${String(i).padStart(4, '0')}`;
    service.ledger.append({ source: 'kit', source_event_id: id, kind: 'conversation.created', subject: `conversation:${id}`, source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: id, origin: 'observed', history_format: 'jsonl', type: 'interactive', kit_name: id } });
  }
  const feed = new ProjectionFeed(service.dbPath, service.catchUp); t.after(() => feed.close());
  assert.equal(feed.snapshot().projection.roots.length, 1000);
  assert.equal(feed.snapshot().projection.roots.some(row => row.id === JSON.stringify(['claude', 'root-1000'])), false);
  await renameSession({ append: service.appendUi }, id => feed.hasRoot(id), { type: 'cmd', cmd_id: 'beyond-page', command: 'session.rename', payload: { rootId: JSON.stringify(['claude', 'root-1000']), name: 'Beyond page' } });
  const patch = feed.refresh(); assert.ok(patch && patch !== 'resync');
  assert.equal(patch.changes.roots.upsert.find(row => row.id === JSON.stringify(['claude', 'root-1000']))?.name, 'Beyond page');
});

test('indexed series names retain partial corrections across refresh, rebuild and feed reopen', async t => {
  const { openObservationService } = await import('../src/service/index.ts');
  const { ProjectionFeed } = await import('../src/service/projection-feed.ts');
  const directory = mkdtempSync(join(tmpdir(), 'ag-series-correction-'));
  const service = openObservationService({ dbPath: join(directory, 'ledger.sqlite'), live: false });
  let feed = new ProjectionFeed(service.dbPath, service.catchUp);
  t.after(() => { feed.close(); service.close(); rmSync(directory, { recursive: true, force: true }); });
  service.ledger.append({ source: 'host-claude', source_event_id: 'created', kind: 'conversation.created', subject: 'conversation:original', source_ts: '2026-10-01T00:00:00Z', confidence: 'confirmed', payload: { provider: 'claude', native_id: 'native', origin: 'managed', history_format: 'jsonl', type: 'interactive', kit_name: 'repo-001' } });
  const renamed = service.ledger.append({ source: 'ui', source_event_id: 'renamed', kind: 'conversation.renamed', subject: 'conversation:original', source_ts: '2026-10-02T00:00:00Z', confidence: 'confirmed', payload: { user_name: 'Inherited title' } });
  service.ledger.append({ source: 'ui', source_event_id: 'corrected', kind: 'conversation.corrected', subject: 'conversation:original', source_ts: '2026-10-03T00:00:00Z', confidence: 'confirmed', supersedes: renamed.fact_id, payload: { cwd: '/fixture' } });
  const expectName = (name: string) => {
    feed.refresh();
    const expected = project(service.ledger.readSince(0, 100)).roots;
    assert.equal(expected[0].name, name);
    assert.deepEqual(feed.snapshot().projection.roots, expected.map(row => ({ ...row, activity_rank: 8 })));
  };
  expectName('Inherited title');
  service.rebuild(); expectName('Inherited title');
  feed.close(); feed = new ProjectionFeed(service.dbPath, service.catchUp);
  expectName('Inherited title');
  service.ledger.append({ source: 'ui', source_event_id: 'cleared', kind: 'conversation.renamed', subject: 'conversation:original', source_ts: '2026-10-04T00:00:00Z', confidence: 'confirmed', payload: { user_name: null } });
  expectName('repo-001');
});
