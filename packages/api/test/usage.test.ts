import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createUsageService, readCodexFallback, POLL_MS, RETRY_MS, MANUAL_MS, STALE_MS } from '../src/usage/index.ts';
import { parseClaude, parseClaudeLimits, parseClaudeStatusline, parseCodex, parseAntigravity, supportsAgy } from '../src/usage/parsers.ts';
import { CODEX_ARGS, probeCodex, probeClaude } from '../src/usage/process.ts';

const START = Date.parse('2026-10-11T00:00:00Z');
const codex = { rateLimits: { primary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 1791948550 }, secondary: { usedPercent: 95, windowDurationMins: 300, resetsAt: 1791948550 } } };
const agy = { num_turns: 0, command: { data: { groups: [
  { name: 'Gemini Models', buckets: [{ window: 'weekly', remaining_fraction: 0.69, reset_time: '2026-10-12T00:00:00Z' }, { window: '5h', disabled: true }] },
  { name: 'Claude and GPT models', buckets: [{ window: '5h', remaining_fraction: 0.1, reset_time: '2026-10-11T04:00:00Z' }] },
] } } };
function claude(time = START, percent = 31) { return { ts: new Date(time).toISOString(), windows: [{ key: 'seven_day', label: 'Week', percent, resets_at: '2026-10-12T00:00:00Z' }] }; }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'usage.json');
  await writeFile(path, JSON.stringify(claude()));
  const script = join(root, 'fake.mjs');
  await writeFile(script, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { const msg = JSON.parse(line); if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n'); if (msg.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: ${JSON.stringify(codex)} }) + '\\n'); });`);
  let version = 'agy 1.3.3';
  let turns = 0;
  let fail = false;
  let claudeFail = false;
  let claudePercent = 31;
  const calls: { command: string; args: string[]; stdin: unknown }[] = [];
  const launch: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    calls.push({ command, args, stdin: options?.stdio });
    if (fail) return spawn(process.execPath, ['-e', 'process.exit(1)'], options);
    if (command === 'fake-claude') return spawn(process.execPath, ['-e', claudeFail ? 'process.exit(1)' : `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { const msg = JSON.parse(line); process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: { rate_limits: { seven_day: { utilization: ${claudePercent}, resets_at: '2026-10-12T00:00:00Z' } } } } }) + '\\n'); });`], options);
    if (command === 'fake-codex') return spawn(process.execPath, [script], options);
    const data = args[0] === '--version' ? version : JSON.stringify({ ...agy, num_turns: turns });
    return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(data)})`], options);
  }) as typeof spawn;
  let time = START;
  const service = createUsageService({ claudePath: path, claudeCommand: 'fake-claude', claudeProbePath: join(root, 'probe'), readRepositoryPaths: () => [join(root, 'repo-old'), join(root, 'repo-new'), join(root, 'repo-bad')], codexSessionsPath: join(root, 'sessions'), codexCommand: 'fake-codex', agyCommand: 'fake-agy', spawn: launch, now: () => time });
  return { root, path, launch, calls, service, setTime: (value: number) => { time = value; }, setVersion: (value: string) => { version = value; }, setTurns: (value: number) => { turns = value; }, setClaudeFail: (value = true) => { claudeFail = value; }, setClaudePercent: (value: number) => { claudePercent = value; }, setFail: (value = true) => { fail = value; } };
}
test('parses all providers, reset times, groups and disabled buckets', () => {
  assert.equal(parseClaude(claude()).windows[0].usedPercent, 31);
  assert.deepEqual(parseCodex(codex).map(row => row.label), ['wk', '5h']);
  assert.equal(parseCodex(codex)[0].resetsAt, new Date(1791948550000).toISOString());
  assert.equal(parseCodex({ rateLimits: { primary: { usedPercent: 39.5 } } })[0].usedPercent, 39.5);
  assert.deepEqual(parseAntigravity(agy).map(row => [row.group, row.label, row.usedPercent]), [['Gemini Models', 'wk', 31], ['Claude and GPT models', '5h', 90]]);
  assert.throws(() => parseClaude({ ...claude(), ts: 'invalid' }));
  assert.throws(() => parseCodex({ rateLimits: { primary: { usedPercent: NaN } } }));
  assert.throws(() => parseAntigravity({}));
});
test('Codex initializes a read-only fake app-server and only reads rate limits', async t => {
  const f = await fixture(t);
  assert.deepEqual(await probeCodex('fake-codex', f.launch), codex);
  assert.deepEqual(f.calls[0].args, CODEX_ARGS);
});
test('uses the last token_count in the newest rollout as fallback with its own age', async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'sessions', '2026', '10');
  await mkdir(directory, { recursive: true });
  const payload = { type: 'token_count', rate_limits: { primary: { used_percent: 39, window_minutes: 10080, resets_at: 1791948550 }, secondary: null } };
  const path = join(directory, 'rollout-new.jsonl');
  await writeFile(join(directory, 'rollout-old.jsonl'), JSON.stringify({ timestamp: new Date(START).toISOString(), payload: { ...payload, rate_limits: null } }));
  await utimes(join(directory, 'rollout-old.jsonl'), 0, 0);
  await writeFile(path, [JSON.stringify({ timestamp: new Date(START).toISOString(), payload: { ...payload, rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } }), '{"token_count":', JSON.stringify({ timestamp: new Date(START - STALE_MS - 1).toISOString(), payload }), JSON.stringify({ payload: { type: 'other' } })].join('\n'));
  const result = await readCodexFallback(join(f.root, 'sessions'));
  assert.equal(result.windows[0].usedPercent, 39); assert.equal(result.windows[0].label, 'wk');
  f.setFail();
  const row = (await f.service.read()).providers[1];
  assert.equal(row.state, 'stale'); assert.equal(row.reason, 'record_fallback'); assert.equal(row.fetchedAt, new Date(START - STALE_MS - 1).toISOString());
  await writeFile(path, JSON.stringify({ timestamp: new Date(START).toISOString(), payload: { ...payload, rate_limits: null } }));
  await assert.rejects(readCodexFallback(join(f.root, 'sessions')));
});
test('checks agy version before /usage and refuses older or unknown versions', async t => {
  assert.equal(supportsAgy('agy 1.1.11'), true); assert.equal(supportsAgy('1.1.10'), false); assert.equal(supportsAgy('2.0.0'), true); assert.equal(supportsAgy('unknown'), false);
  const f = await fixture(t); f.setVersion('agy 1.1.10');
  assert.equal((await f.service.read()).providers[2].reason, 'unsupported_version');
  assert.equal(f.calls.filter(row => row.command === 'fake-agy').length, 1);
  f.setTime(START + POLL_MS); await f.service.read();
  assert.equal(f.calls.filter(row => row.command === 'fake-agy').length, 1);
});
test('stops agy for the service lifetime after nonzero turns and uses null stdin', async t => {
  const f = await fixture(t); f.setTurns(1);
  assert.equal((await f.service.read()).providers[2].reason, 'turns_detected');
  const calls = f.calls.filter(row => row.command === 'fake-agy');
  assert.deepEqual(calls[1].args, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s']);
  assert.deepEqual(calls[1].stdin, ['ignore', 'pipe', 'ignore']);
  f.setTime(START + POLL_MS); f.setTurns(0); await f.service.read({ force: true });
  assert.equal(f.calls.filter(row => row.command === 'fake-agy').length, 2);
});
test('shares in-flight reads and enforces automatic and manual intervals', async t => {
  const f = await fixture(t);
  await Promise.all([f.service.read(), f.service.read()]);
  assert.equal(f.calls.length, 4);
  f.setTime(START + MANUAL_MS - 1); await f.service.read({ force: true }); assert.equal(f.calls.length, 4);
  f.setTime(START + MANUAL_MS); await f.service.read({ force: true }); assert.equal(f.calls.length, 7);
  f.setTime(START + MANUAL_MS + POLL_MS - 1); await f.service.read(); assert.equal(f.calls.length, 7);
  f.setTime(START + MANUAL_MS + POLL_MS); await f.service.read(); assert.equal(f.calls.length, 10);
  await assert.rejects(f.service.read({ force: 'yes' }));
});
test('retries stale retained values every 30 seconds after failures', async t => {
  const f = await fixture(t); await f.service.read(); f.setFail();
  let time = START + POLL_MS;
  for (let failures = 1; failures <= 7; failures++) {
    f.setTime(time); const result = await f.service.read();
    assert.equal(result.providers[2].state, 'stale'); assert.equal(result.providers[2].windows[0].usedPercent, 31);
    const count = f.calls.length;
    const delay = RETRY_MS;
    f.setTime(time + delay - 1); await f.service.read(); assert.equal(f.calls.length, count);
    time += delay;
  }
  f.setFail(false); f.setTime(time);
  assert.equal((await f.service.read()).providers[2].state, 'ok');
  const count = f.calls.length;
  f.setTime(time + RETRY_MS); await f.service.read(); assert.equal(f.calls.length, count);
  f.setTime(time + POLL_MS); await f.service.read(); assert.equal(f.calls.length, count + 3);
});
test('uses the legacy file only when direct and statusline sources fail, and rereads it', async t => {
  const f = await fixture(t); f.setClaudeFail();
  await utimes(f.path, new Date(START), new Date(START));
  assert.equal((await f.service.read()).providers[0].windows[0].usedPercent, 31);
  await writeFile(f.path, JSON.stringify(claude(START, 80)));
  await utimes(f.path, new Date(START), new Date(START));
  f.setTime(START + STALE_MS + 1);
  const row = (await f.service.read()).providers[0];
  assert.equal(row.windows[0].usedPercent, 80); assert.equal(row.state, 'stale'); assert.equal(row.reason, 'record_fallback');
});

async function writeStatusline(root: string, name: string, time: number, percent: number) {
  const directory = join(root, name, '.agents/state');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'usage.json');
  await writeFile(path, JSON.stringify({ ts: new Date(time).toISOString(), rate_limits: {
    five_hour: { used_percentage: percent, resets_at: 1791948550 },
    seven_day: { used_percentage: 91, resets_at: 1792015200 },
  } }));
  return path;
}
test('direct Claude usage takes precedence over statusline and the stopped legacy cache', async t => {
  const f = await fixture(t); f.setClaudePercent(91);
  await writeFile(f.path, JSON.stringify(claude(START - 2 * 24 * 60 * 60_000, 46)));
  await writeStatusline(f.root, 'repo-new', START, 26);
  const row = (await f.service.read()).providers[0];
  assert.equal(row.windows[0].usedPercent, 91);
  assert.equal(row.state, 'ok'); assert.equal(row.fetchedAt, new Date(START).toISOString());
  assert.equal(f.calls.filter(row => row.command === 'fake-claude').length, 1);
  f.setTime(START + POLL_MS); f.setClaudePercent(95);
  assert.equal((await f.service.read()).providers[0].windows[0].usedPercent, 95);
});
test('failed Claude query selects the newest valid statusline ts, ignoring mtime and absent model windows', async t => {
  const f = await fixture(t); f.setClaudeFail();
  const old = await writeStatusline(f.root, 'repo-old', START - 60_000, 10);
  const latest = await writeStatusline(f.root, 'repo-new', START, 26);
  await utimes(old, new Date(START + 60_000), new Date(START + 60_000));
  await utimes(latest, 0, 0);
  await mkdir(join(f.root, 'repo-bad', '.agents/state'), { recursive: true });
  await writeFile(join(f.root, 'repo-bad', '.agents/state/usage.json'), '{');
  await writeFile(f.path, JSON.stringify(claude(START + 60_000, 46)));
  const row = (await f.service.read()).providers[0];
  assert.deepEqual(row.windows.map(window => [window.key, window.usedPercent]), [['five_hour', 26], ['seven_day', 91]]);
  assert.equal(row.windows[0].resetsAt, new Date(1791948550000).toISOString());
  assert.equal(row.fetchedAt, new Date(START).toISOString());
  assert.equal(row.state, 'stale'); assert.equal(row.reason, 'record_fallback');
  f.setTime(START + RETRY_MS - 1); await f.service.read({ force: true });
  assert.equal(f.calls.filter(row => row.command === 'fake-claude').length, 1);
  await writeStatusline(f.root, 'repo-new', START + RETRY_MS, 28);
  f.setTime(START + RETRY_MS);
  assert.equal((await f.service.read({ force: true })).providers[0].windows[0].usedPercent, 28);
  f.setClaudeFail(false); f.setTime(START + 2 * RETRY_MS);
  assert.equal((await f.service.read()).providers[0].state, 'ok');
});
test('old fallback timestamps stay stale and retry every 30 seconds instead of 15 minutes', async t => {
  const f = await fixture(t); f.setClaudeFail();
  await writeFile(f.path, JSON.stringify(claude(START - STALE_MS - 1, 46)));
  const row = (await f.service.read()).providers[0];
  assert.equal(row.state, 'stale'); assert.equal(row.fetchedAt, new Date(START - STALE_MS - 1).toISOString());
  for (let attempt = 1; attempt <= 7; attempt++) {
    f.setTime(START + attempt * RETRY_MS - 1); await f.service.read();
    assert.equal(f.calls.filter(row => row.command === 'fake-claude').length, attempt);
    f.setTime(START + attempt * RETRY_MS); await f.service.read();
    assert.equal(f.calls.filter(row => row.command === 'fake-claude').length, attempt + 1);
  }
});
test('Claude probe sends only get_usage with persistence disabled and isolates hooks from caller history', async t => {
  const f = await fixture(t);
  const cwd = join(f.root, 'isolated', '.cache/agent-graph/usage-probe');
  const environment = { PATH: process.env.PATH, HOME: f.root, AGENT_GRAPH_PARENT_SESSION: 'parent', AGENT_GRAPH_TASK: 'task',
    AGENT_GRAPH_PROJECT: '/caller', AGENT_GRAPH_SESSION: 'session', CLAUDE_PROJECT_DIR: '/caller', CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'caller-session', HERDR_PANE_ID: 'pane', CLAUDE_CONFIG_DIR: '/auth-config' };
  const original = { ...environment };
  const script = `import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
const requests = [];
lines.on('line', line => requests.push(JSON.parse(line)));
lines.on('close', () => {
  assert.equal(process.cwd(), realpathSync(${JSON.stringify(cwd)}));
  assert.equal(process.env.AGENT_GRAPH_PROJECT, ${JSON.stringify(cwd)});
  assert.equal(process.env.CLAUDE_PROJECT_DIR, ${JSON.stringify(cwd)});
  for (const key of ['AGENT_GRAPH_PARENT_SESSION', 'AGENT_GRAPH_TASK', 'AGENT_GRAPH_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'HERDR_PANE_ID']) assert.equal(process.env[key], undefined);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, '/auth-config');
  assert.deepEqual(requests, [{ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }]);
  process.stdout.write('non-json startup noise\\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: 'other', response: { rate_limits: { seven_day: { utilization: 1 } } } } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: 'usage', subtype: 'success', response: { rate_limits: {
    five_hour: { utilization: 26.5 }, seven_day: { utilization: 91 }, model_scoped: [{ display_name: 'Sonnet', utilization: 80 }]
  } } } }) + '\\n');
});`;
  const launch: typeof spawn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    assert.equal(command, 'fake-claude');
    assert.equal(options?.cwd, cwd);
    assert.deepEqual(args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']);
    assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe']);
    return spawn(process.execPath, ['-e', script], options);
  }) as typeof spawn;
  const result = await probeClaude('fake-claude', cwd, launch, environment);
  assert.deepEqual(environment, original);
  assert.deepEqual(parseClaudeLimits(result).map(window => [window.key, window.usedPercent]), [['five_hour', 26.5], ['seven_day', 91], ['model:Sonnet', 80]]);
});

test('Claude sources accept partial windows without inventing missing weekly or model values', () => {
  const result = parseClaudeStatusline({ ts: new Date(START).toISOString(), five_hour: { used_percentage: 28, resets_at: 1791948550 } });
  assert.deepEqual(result.windows.map(row => [row.key, row.usedPercent]), [['five_hour', 28]]);
  assert.equal(result.timestamp, START);
  assert.deepEqual(parseClaudeLimits({ seven_day: { utilization: 91 }, model_scoped: [{ display_name: 'Sonnet' }] })
    .map(row => [row.key, row.usedPercent]), [['seven_day', 91]]);
  assert.throws(() => parseClaudeStatusline({ ts: 'invalid', five_hour: { used_percentage: 28 } }));
  assert.throws(() => parseClaudeStatusline({ ts: new Date(START).toISOString(), rate_limits: { five_hour: { used_percentage: 101 } } }));
  assert.throws(() => parseClaudeLimits({}));
});

test('unavailable sources retain exponential backoff capped at 15 minutes', async t => {
  const f = await fixture(t); f.setFail();
  let time = START;
  for (let failures = 1; failures <= 7; failures++) {
    f.setTime(time);
    assert.equal((await f.service.read()).providers[2].state, 'unavailable');
    const delay = Math.min(RETRY_MS * 2 ** (failures - 1), POLL_MS);
    f.setTime(time + delay - 1); await f.service.read();
    assert.equal(f.calls.filter(row => row.command === 'fake-agy').length, failures);
    time += delay;
  }
  f.setFail(false); f.setTime(time);
  assert.equal((await f.service.read()).providers[2].state, 'ok');
});
