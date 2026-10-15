import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createIsolation, assertIsolation, removeIsolation, readActors, waitFor, readJson, runCommand, DIRECTORY } from './isolation.mjs';
import { Transcript, renderClaude, renderCodex, REPLY_PREFIX } from './fixtures.mjs';
import { InputDecoder } from './fake-cli.mjs';
import { scriptActor } from './journeys.mjs';
import { Report, JOURNEYS } from './report.mjs';

async function fixture(t) {
  const isolated = await createIsolation(process.env.E2E_CHECK_ROOT);
  isolated.cleanups = [];
  t.after(async () => { for (const close of isolated.cleanups.reverse()) await close(); await removeIsolation(isolated); }); return isolated;
}

test('環境変数を隔離し、所有外の削除と本番 HOME を拒否する', async t => {
  const isolated = await fixture(t);
  assert.equal(await assertIsolation(isolated.env), isolated.root);
  assert.equal(isolated.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(isolated.env.OPENAI_API_KEY, undefined);
  assert.equal(isolated.env.NODE_OPTIONS, undefined);
  assert.ok(!isolated.env.PATH.includes('/Users/r/.local/bin'));
  await assert.rejects(assertIsolation({ ...isolated.env, HOME: '/Users/r' }), /HOME escapes/);
  await assert.rejects(assertIsolation({ ...isolated.env, E2E_ROOT: DIRECTORY }), /owned workspace/);
});

test('bracketed paste の途中分割、Ctrl+U、別送 Enter から一度だけ送る', () => {
  const received = [];
  const decoder = new InputDecoder(value => received.push(value), () => {}, () => false);
  decoder.feed('old'); decoder.feed('\x15\x1b'); decoder.feed('[20'); decoder.feed('0~二通目\n続き\x1b[2'); decoder.feed('01~');
  assert.deepEqual(received, []);
  decoder.feed('\r'); assert.deepEqual(received, ['二通目\n続き']);
});

test('偽画面を本物の xterm/parser で読み、作業中は入力できモデル選択は止まる', async () => {
  const { TerminalScreen, isInputBlocked, readPrompt } = await import('../../packages/api/src/terminal/screen.ts');
  const screen = new TerminalScreen();
  try {
    screen.write(renderClaude()); assert.ok(readPrompt(await screen.read(), 'claude'));
    screen.write(renderClaude({ working: true })); assert.equal(isInputBlocked(await screen.read(), 'claude'), false);
    screen.write(renderClaude({ panel: true })); assert.equal(isInputBlocked(await screen.read(), 'claude'), true);
    screen.write(renderClaude({ output: '⎿ Set model to haiku' })); assert.equal(isInputBlocked(await screen.read(), 'claude'), false);
    screen.write(renderCodex()); assert.ok(readPrompt(await screen.read(), 'codex'));
  } finally { screen.close(); }
});

test('合成 jsonl を本物の取り込みで読み、キュー・継続・圧縮・再読込を確認する', async t => {
  const isolated = await fixture(t);
  const { openLedger, project } = await import('../../packages/core/src/ledger/index.ts');
  const { observeClaudeFile } = await import('../../packages/api/src/observe/claude/index.ts');
  const ledger = openLedger(':memory:'); t.after(() => ledger.close());
  const transcript = new Transcript('claude', isolated.env); t.after(() => transcript.close());
  transcript.user('first'); transcript.assistant('answer');
  const item = transcript.enqueue('second'); transcript.absorb(item); transcript.assistant('second answer');
  transcript.rename('synthetic name'); transcript.compact();
  const original = transcript.path; const { previous, next } = transcript.fork();
  transcript.user('latest'); transcript.assistant('latest answer');
  for (const path of [original, transcript.path]) assert.deepEqual(observeClaudeFile(ledger, path).conflicts, []);
  const facts = ledger.readSince(0, 100_000); const projection = project(facts);
  assert.equal(projection.messages.filter(row => row.body === 'second').length, 1);
  assert.ok(projection.relations.some(row => row.type === 'continued' && row.from_id === JSON.stringify(['claude', previous]) && row.to_id === JSON.stringify(['claude', next])));
  assert.ok(projection.relations.some(row => row.type === 'compacted'));
  assert.ok(!projection.messages.some(row => String(row.body).includes('E2E synthetic compact summary')));
  for (const path of [original, transcript.path]) assert.deepEqual(observeClaudeFile(ledger, path).conflicts, []);
  assert.deepEqual(ledger.readSince(0, 100_000), facts);
});

test('Codex の paginated rollout の送信と返事を本物の取り込みが読める', async t => {
  const isolated = await fixture(t);
  const { openLedger, project } = await import('../../packages/core/src/ledger/index.ts');
  const { observeCodexFile } = await import('../../packages/api/src/observe/codex/index.ts');
  const ledger = openLedger(':memory:'); t.after(() => ledger.close());
  const transcript = new Transcript('codex', isolated.env); t.after(() => transcript.close());
  transcript.user('codex input'); transcript.assistant('codex reply');
  const results = observeCodexFile(ledger, transcript.path, { codexHome: isolated.env.CODEX_HOME });
  assert.ok(results.every(row => row.status !== 'conflict'));
  const projection = project(ledger.readSince(0, 100_000));
  assert.deepEqual(projection.messages.map(row => row.role).sort(), ['assistant', 'user']);
  assert.ok(projection.messages.some(row => JSON.stringify(row.body).includes('codex reply')));
});

test('本物の SDK が偽 Claude のモデル一覧を取得し、Codex も偽 app-server を使う', async t => {
  const isolated = await fixture(t);
  await runCommand(process.execPath, [join(DIRECTORY, 'protocol-check.mjs')], { cwd: isolated.state, env: isolated.env });
  const audit = (await readFile(join(isolated.control, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(audit.some(row => row.provider === 'claude' && row.request?.request?.subtype === 'initialize'));
  assert.ok(audit.some(row => row.provider === 'codex' && row.request?.method === 'model/list'));
});

test('本物の PTY と送信サービスで、偽 CLI の送信・キュー・モデル確認を通す', async t => {
  const isolated = await fixture(t);
  const output = await runCommand(process.execPath, [join(DIRECTORY, 'pty-check.mjs')], { cwd: isolated.state, env: isolated.env });
  assert.ok(output.includes('double-send rejection: PASS'));
});

test('偽 CLI は実 stdin と adapter を通じて台本・hook・履歴を生成する', { timeout: 20_000 }, async t => {
  const isolated = await fixture(t);
  const child = spawn(join(isolated.bin, 'claude'), [], { cwd: isolated.project, env: isolated.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  isolated.cleanups.push(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; });
  const actor = await waitFor(async () => (await readActors(isolated.control)).find(row => row.id), 'fake startup');
  const state = () => readJson(join(isolated.control, String(actor.pid), 'state.json'));
  const command = (action, values) => scriptActor(isolated.control, actor.pid, action, values);
  const send = text => child.stdin.write(`\x15\x1b[200~${text}\x1b[201~\r`);
  await command('hold-next'); send('first'); await waitFor(async () => (await state()).working, 'first working');
  send('second'); await waitFor(async () => (await state()).queued.includes('second'), 'second queued');
  await command('release'); await waitFor(() => output.includes(REPLY_PREFIX + 'second'), 'second reply');
  const fork = await command('fork'); assert.notEqual(fork.id, actor.id);
  send('/rename Synthetic'); await waitFor(async () => (await readFile((await state()).path, 'utf8')).includes('custom-title'), 'rename');
  send('/model haiku'); await waitFor(async () => (await state()).panel, 'model panel');
  child.stdin.write('s'); await waitFor(async () => (await state()).model === 'haiku' && !(await state()).panel, 'model confirmed');
  await command('end'); await command('hold-next'); send('after end');
  await waitFor(async () => (await state()).working && !(await state()).stopped, 'after end working');
  await command('release'); await command('compact');
  await command('drop-next'); send('lost');
  await waitFor(async () => (await readFile(join(isolated.control, 'events.jsonl'), 'utf8')).includes('"event":"dropped"'), 'drop');
  const transcript = await readFile((await state()).path, 'utf8'); assert.ok(!transcript.includes('lost'));
  assert.ok(transcript.includes('isCompactSummary')); assert.ok(transcript.includes('queued_command'));
  const outbox = join(isolated.state, 'outbox');
  const hooks = await Promise.all((await readdir(outbox)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(outbox, name), 'utf8'))));
  for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) assert.ok(hooks.some(row => row.hook_event_name === name));
  assert.ok(hooks.every(row => row.input.transcript_path.startsWith(isolated.home) && row.managed === false));
  child.kill('SIGTERM'); assert.equal(await closed, 0, errors);
  assert.equal(errors, '');
});

test('未実行・写しの失敗・後片付け失敗は公開ゲートを通さない', async t => {
  const isolated = await fixture(t);
  const report = new Report(join(isolated.root, 'report'), { cleanup: { ok: true, runtimeRemoved: true } }, () => {}); await report.initialize();
  await report.blockRemaining('listen EPERM'); assert.equal(report.passed(), false);
  assert.equal(report.results.length, JOURNEYS.length);
  report.results = JOURNEYS.map(([id, name]) => ({ id, name, status: 'pass', artifacts: [id + '.png'] }));
  assert.equal(report.passed(), true);
  report.metadata.cleanup.ok = false; assert.equal(report.passed(), false);
  report.metadata.cleanup.ok = true; report.results[0].status = 'fail'; assert.equal(report.passed(), false);
  report.results = [];
  const failedCapture = await report.step('1-claude', { isClosed: () => false, screenshot: async () => { throw new Error('capture unavailable'); } }, async () => 'completed');
  assert.equal(failedCapture.status, 'fail'); assert.match(failedCapture.error, /capture unavailable/);
});

test('壊し方の台本を実 stdin・adapter・走査・API 判定まで通す', { timeout: 30_000 }, async t => {
  const isolated = await fixture(t);
  const { openObservationService } = await import('../../packages/api/src/service/index.ts');
  const { ProjectionFeed } = await import('../../packages/api/src/service/projection-feed.ts');
  const { scanSessions } = await import('../../packages/api/src/service/session-scan.ts');
  const { stateNow } = await import('./clock.mjs');
  const service = openObservationService({ home: isolated.home, env: isolated.env, dbPath: join(isolated.state, 'state-test.db') });
  const feed = new ProjectionFeed(service.dbPath, service.catchUp);
  const child = spawn(join(isolated.bin, 'claude'), [], { cwd: isolated.project, env: isolated.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stdout.resume(); child.stderr.on('data', chunk => { errors += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  isolated.cleanups.push(async () => {
    for (const actor of await readActors(isolated.control)) { try { process.kill(actor.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await closed; await new Promise(resolve => setTimeout(resolve, 200)); feed.close(); service.close();
  });
  const actor = await waitFor(async () => (await readActors(isolated.control)).find(row => row.id), 'fault actor');
  const command = (action, values) => scriptActor(isolated.control, actor.pid, action, values);
  const id = JSON.stringify(['claude', actor.id]);
  async function processes() {
    const current = new Map();
    for (const actor of await readActors(isolated.control)) {
      try { process.kill(actor.pid, 0); current.set(actor.pid, String(actor.pid)); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return current;
  }
  async function inspect(target = id, scan = true) {
    service.ingestOnce();
    if (scan) feed.recordScan(await scanSessions(join(isolated.env.CLAUDE_CONFIG_DIR, 'sessions'), processes, () => stateNow(isolated.env)));
    feed.refresh(stateNow(isolated.env));
    return feed.current.conversations.get(target)?.decision;
  }
  await command('drop-stop'); await command('hold-next'); child.stdin.write('first\r');
  await waitFor(async () => (await readJson(join(isolated.control, String(actor.pid), 'state.json'))).working, 'first prompt');
  await command('release');
  await waitFor(async () => (await inspect())?.display.label === 'Idle', 'duration completes without Stop');
  await command('long-tool'); assert.equal((await inspect()).display.label, 'Working');
  await command('advance-clock', { ms: 301_000 }); const longDecision = await inspect(); assert.equal(longDecision.turn.reason, 'running_tool', JSON.stringify(longDecision));
  await command('scan-failure'); await command('advance-clock', { ms: 31_000 });
  const failed = await inspect(); assert.equal(failed.display.label, 'Unknown'); assert.equal(failed.observation[0].state, 'failed');
  await command('restore-scan'); assert.equal((await inspect()).display.label, 'Working');
  await command('interrupt'); assert.equal((await inspect()).display.label, 'Idle');
  await command('approval-wait'); const approval = await inspect(); assert.equal(approval.display.label, 'Needs approval');
  await command('interrupt'); await inspect();
  const childState = await command('child-tool'); const childId = JSON.stringify(['claude', childState.child.id]);
  assert.equal((await inspect(childId)).display.label, 'Working');
  await command('child-stop-tool'); assert.equal((await inspect(childId)).turn.reason, 'boundary_unavailable');
  const nextChild = await command('child-tool'); const nextId = JSON.stringify(['claude', nextChild.child.id]);
  await inspect(nextId); await command('child-stopped-notification');
  assert.equal((await inspect(nextId)).display.label, 'Unknown'); assert.equal((await inspect()).display.label, 'Idle');
  const restartedChild = await command('child-tool'); const restartedId = JSON.stringify(['claude', restartedChild.child.id]);
  await inspect(restartedId); await command('advance-clock', { ms: 301_000 }); await command('parent-restart');
  const successor = await waitFor(async () => (await readActors(isolated.control)).find(row => row.id === actor.id && row.pid !== actor.pid), 'restart');
  assert.equal((await inspect(restartedId)).process.reason, 'owner_restarted');
  await scriptActor(isolated.control, successor.pid, 'external-input', { text: 'same' });
  await scriptActor(isolated.control, successor.pid, 'external-input', { text: 'same' });
  const rows = (await readFile(successor.path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.message?.content === 'same').length, 2);
  await inspect(); await scriptActor(isolated.control, successor.pid, 'drop-session-end'); await scriptActor(isolated.control, successor.pid, 'exit');
  await waitFor(async () => (await inspect())?.display.label === 'Stopped', 'dropped SessionEnd detects physical exit');
  assert.equal(errors, '');
});
