import { USAGE_PROBE_PATH } from '../src/usage/probe-path.ts';
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openObservationService } from '../src/service/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { applyIncremental, openLedger, projectConversations, projectRuns, readLedgerDatabase } from "../../core/src/ledger/index.ts";
import type { FactInput, Ledger } from "../../core/src/ledger/index.ts";
import { createHookFacts, createHookHandler, startHookServer } from "../src/hook/index.ts";
import type { HookEvent } from "../src/hook/index.ts";

const nativeFetch = globalThis.fetch;

const EVENT: HookEvent = { version: 1, session_id: "session", generation: 1, event_id: "start",
  hook_event_name: "SessionStart", source_ts: "2026-01-01T00:00:00.000Z", input: {}, managed: false };

function createReceiver(ledger: Ledger) {
  const token = randomBytes(32).toString("base64url");
  const url = "http://127.0.0.1:12345/hook-v2";
  const handler = createHookHandler(ledger, token);
  const post = async (_url: string, options: RequestInit) => {
    const request = Readable.from([Buffer.from(String(options.body))]);
    Object.assign(request, { method: options.method, url: "/hook-v2",
      headers: { host: "127.0.0.1:12345", ...options.headers },
      socket: { remoteAddress: "127.0.0.1", localPort: 12345 } });
    let status = 0;
    let body = "";
    const response = { setHeader() {}, writeHead: (code: number) => { status = code; }, end: (value: string | Buffer) => { body = value.toString(); } };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return new Response(body, { status });
  };
  return { token, url, post, close: async () => {} };
}

test("hook を受理し、再送と受け口の再起動でも事実が増えない", async (t) => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const first = createReceiver(ledger);
  const post = (receiver: ReturnType<typeof createReceiver>, token: string, event = EVENT) => receiver.post(receiver.url, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(event) });
  try {
    const response = await post(first, first.token);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    assert.deepEqual(ledger.readSince(0, 100).map(fact => fact.subject),
      ['conversation:["claude","session"]', 'run:["claude","session"]:1']);
    const created = ledger.readSince(0, 100)[1];
    assert.ok(created.kind === 'run.created');
    assert.equal(created.payload?.conversation_id, '["claude","session"]');
    assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
    assert.equal((await post(first, first.token)).status, 200);
    assert.equal(ledger.readSince(0, 100).length, 2);
    assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
  } finally { await first.close(); }
  const second = createReceiver(ledger);
  t.after(() => second.close());
  assert.notEqual(first.token, second.token);
  assert.equal((await post(second, first.token)).status, 403);
  assert.equal((await post(second, second.token)).status, 200);
  assert.equal(ledger.readSince(0, 100).length, 2);
  assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
  const ended = { ...EVENT, event_id: "end", hook_event_name: "SessionEnd", source_ts: "2026-01-01T00:01:00.000Z" };
  assert.equal((await post(second, second.token, ended)).status, 200);
  assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "ended");
  assert.equal((await post(second, second.token, { ...EVENT, generation: 2 })).status, 200);
  assert.equal(projectRuns(ledger.readSince(0, 100)).length, 2);
  assert.equal(globalThis.fetch, nativeFetch);
});

test("不正なトークン、Origin、入力を拒否し、台帳へ書かない", async (t) => {
  const ledger = openLedger(":memory:");
  const receiver = createReceiver(ledger);
  t.after(async () => { await receiver.close(); ledger.close(); });
  for (const authorization of [undefined, "Bearer wrong", ""]) {
    const response = await receiver.post(receiver.url, { method: "POST", headers: {
      "content-type": "application/json", ...(authorization !== undefined ? { authorization } : {}),
    }, body: JSON.stringify(EVENT) });
    assert.equal(response.status, 403);
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${receiver.token}` };
  assert.equal((await receiver.post(receiver.url, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" },
    body: JSON.stringify(EVENT) })).status, 403);
  for (const body of ["{", JSON.stringify({ ...EVENT, generation: 0 }), JSON.stringify({ ...EVENT, run_id: 123 })]) {
    assert.equal((await receiver.post(receiver.url, { method: "POST", headers, body })).status, 400);
  }
  assert.equal(ledger.readSince(0, 100).length, 0);
});

test("agent_id 付きの hook でも親は interactive のままで、会話の作成は一度だけ", async (t) => {
  for (const childFirst of [false, true]) {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    const child: HookEvent = { ...EVENT, event_id: "child-tool", hook_event_name: "PostToolUse",
      source_ts: "2026-01-01T00:01:00.000Z", input: { agent_id: "child" } };
    const events = childFirst ? [child, EVENT] : [EVENT, child];
    const receivers = [createReceiver(ledger), createReceiver(ledger)];
    for (const [index, event] of [...events, { ...EVENT, generation: 2, event_id: "resume",
      source_ts: "2026-01-01T00:02:00.000Z" }, child].entries()) {
      const receiver = receivers[index % receivers.length];
      const response = await receiver.post(receiver.url, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
        body: JSON.stringify(event) });
      assert.equal(response.status, 200);
      const facts = ledger.readSince(0, 100);
      assert.equal(facts.filter((fact) => fact.kind === "conversation.created").length, 1);
      const conversations = projectConversations(facts).conversations;
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0].native_id, EVENT.session_id);
      assert.equal(conversations[0].type, "interactive");
    }
    assert.equal(ledger.readSince(0, 100).length, 4);
  }
});

test("Stop の後の UserPromptSubmit で running に戻り、逆順の到着や再送でも崩れない", async (t) => {
  const stopped: HookEvent = { ...EVENT, event_id: "stop", hook_event_name: "Stop",
    source_ts: "2026-01-01T00:01:00.000Z" };
  const prompted: HookEvent = { ...EVENT, event_id: "prompt", hook_event_name: "UserPromptSubmit",
    source_ts: "2026-01-01T00:02:00.000Z" };
  for (const events of [[EVENT, stopped, prompted], [prompted, stopped, EVENT]]) {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    const receiver = createReceiver(ledger);
    for (const event of [...events, stopped, prompted]) {
      const response = await receiver.post(receiver.url, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
        body: JSON.stringify(event) });
      assert.equal(response.status, 200);
      if (event === stopped && events[0] === EVENT && ledger.readSince(0, 100).length === 3) {
        assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
      }
    }
    const facts = ledger.readSince(0, 100);
    assert.equal(facts.length, 4);
    assert.equal(projectRuns(facts)[0].state, "running");
    assert.equal(projectRuns(facts)[0].last_evidence_ts, prompted.source_ts);
  }
});

test("managed の hook は補助事実だけを記録し、ホストの状態を変えない", async (t) => {
  const ledger = openLedger(":memory:");
  const receiver = createReceiver(ledger);
  t.after(async () => { await receiver.close(); ledger.close(); });
  ledger.append({ source: "host-claude", source_event_id: "host-start", kind: "run.created", subject: "run:managed",
    payload: { conversation_id: "managed-conversation", generation: 1, state: "running" },
    source_ts: EVENT.source_ts, confidence: "confirmed" });
  const event = { ...EVENT, managed: true, run_id: "managed", hook_event_name: "SessionEnd",
    source_ts: "2026-01-01T00:01:00.000Z", input: { password: "sk-ant-abcdefghijklmnopqrstuvwxyz" } };
  const post = () => receiver.post(receiver.url, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${receiver.token}` }, body: JSON.stringify(event) });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.length, 2);
  assert.equal(facts[1].kind, "run.updated");
  assert.equal(facts[1].source, "hook");
  assert.equal(facts[1].payload?.generation, event.generation);
  assert.equal(projectRuns(facts)[0].state, "running");
  assert.ok(!JSON.stringify(facts).includes("sk-ant-abcdefghijklmnopqrstuvwxyz"));
  const auxiliary = await receiver.post(receiver.url, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${receiver.token}` }, body: JSON.stringify({ ...event, event_id: "without-run", run_id: undefined }) });
  assert.equal(auxiliary.status, 200);
  assert.equal(ledger.readSince(0, 100).length, 3);
  assert.equal(projectRuns(ledger.readSince(0, 100)).length, 1);
});

test("同じ出来事 ID の内容が変わった場合は受理しない", async (t) => {
  const ledger = openLedger(":memory:");
  const receiver = createReceiver(ledger);
  t.after(async () => { await receiver.close(); ledger.close(); });
  for (const [input, expected] of [[{}, 200], [{ changed: true }, 409]] as const) {
    const response = await receiver.post(receiver.url, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${receiver.token}` }, body: JSON.stringify({ ...EVENT, input }) });
    assert.equal(response.status, expected);
  }
  assert.equal(ledger.readSince(0, 100).length, 2);
});

test("大きな hook の本文も欠落なく台帳へ届け、再送で増やさない", async (t) => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const receiver = createReceiver(ledger);
  const input = { tool_response: "結果😀".repeat(150_000) };
  const body = JSON.stringify({ ...EVENT, event_id: "large", input });
  assert.ok(Buffer.byteLength(body) > 1_048_576);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await receiver.post(receiver.url, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` }, body });
    assert.equal(response.status, 200);
  }
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.length, 2);
  assert.ok(facts[1].kind === "run.created");
  assert.deepEqual((facts[1].payload?.last_evidence as { input: unknown }).input, input);
});

test("実 HTTP の受け口は 127.0.0.1 に限定する", async (t) => {
  assert.equal(globalThis.fetch, nativeFetch);
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  let receiver: Awaited<ReturnType<typeof startHookServer>>;
  try { receiver = await startHookServer(ledger); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("sandbox blocks local HTTP listen");
    return;
  }
  t.after(() => receiver.close());
  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  const response = await fetch(receiver.url, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${receiver.token}` }, body: JSON.stringify(EVENT) });
  assert.equal(response.status, 200);
});

test("根は子の終了を待つ間も hook のターンを保ち、Stop でだけ待機へ戻る", async (t) => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const receiver = createReceiver(ledger);
  const post = (event: HookEvent) => receiver.post(receiver.url, { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${receiver.token}`,
  }, body: JSON.stringify(event) });
  await post(EVENT);
  const start = "2026-01-01T00:01:00.000Z";
  await post({ ...EVENT, event_id: "prompt", hook_event_name: "UserPromptSubmit", source_ts: start });
  ledger.append({ source: "transcript-claude", source_event_id: "child-stop", source_ts: "2026-01-01T00:11:42.000Z",
    kind: "run.state_changed", subject: 'run:["claude","session"]:1', confidence: "confirmed",
    payload: { conversation_id: "claude:session", generation: 1, state: "idle", last_evidence: { kind: "turn_completed" } } });
  await post({ ...EVENT, event_id: "tool", hook_event_name: "PostToolUse", source_ts: "2026-01-01T00:11:42.000Z" });
  let runs = projectRuns(ledger.readSince(0, 100));
  assert.equal(runs[0].state, "running");
  assert.equal(runs[0].turn_started_ts, start);
  assert.deepEqual(projectRuns(ledger.readSince(0, 100).reverse()), runs);
  await post({ ...EVENT, event_id: "stop", hook_event_name: "Stop", source_ts: "2026-01-01T00:12:00.000Z" });
  runs = projectRuns(ledger.readSince(0, 100));
  assert.equal(runs[0].state, "idle");
  assert.equal(runs[0].turn_started_ts, undefined);
  await post({ ...EVENT, event_id: "next", hook_event_name: "UserPromptSubmit", source_ts: "2026-01-01T00:13:00.000Z" });
  assert.equal(projectRuns(ledger.readSince(0, 100))[0].turn_started_ts, "2026-01-01T00:13:00.000Z");
});

test('SessionStart のない UserPromptSubmit でも開始時刻が入り、受け口の再起動で消えない', async (t) => {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const event: HookEvent = { ...EVENT, event_id: 'prompt-only', hook_event_name: 'UserPromptSubmit' };
  const post = (receiver: ReturnType<typeof createReceiver>, input: HookEvent) => receiver.post(receiver.url, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${receiver.token}` },
    body: JSON.stringify(input),
  });
  assert.equal((await post(createReceiver(ledger), event)).status, 200);
  const before = ledger.readSince(0, 100);
  assert.equal(projectRuns(before)[0].turn_started_ts, event.source_ts);
  const restarted = createReceiver(ledger);
  assert.equal((await post(restarted, event)).status, 200);
  assert.deepEqual(ledger.readSince(0, 100), before);
  assert.equal((await post(restarted, { ...event, event_id: 'additional', source_ts: '2026-01-01T00:01:00.000Z' })).status, 200);
  assert.equal(projectRuns(ledger.readSince(0, 100))[0].turn_started_ts, event.source_ts);
});

test('real conversation hooks remain recorded at the exact probe path', async t => {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const receiver = createReceiver(ledger);
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const response = await receiver.post(receiver.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + receiver.token },
      body: JSON.stringify({ ...EVENT, event_id: hook_event_name, hook_event_name, input: { cwd: hook_event_name === 'SessionStart' ? '/home/test/repo' : USAGE_PROBE_PATH } }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
  }
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.equal(facts.filter(fact => fact.kind.startsWith('run.')).length, 4);
  assert.equal(projectRuns(facts)[0].state, 'ended');
});

for (const conversationId of ['claude:session', '["claude","session"]']) {
  for (const projected of [false, true]) test(`既存 ${conversationId} の run を再利用する（投影済み=${projected}）`, async t => {
    const ledger = openLedger(':memory:');
    t.after(() => ledger.close());
    const subject = `run:${conversationId}:1` as const;
    ledger.append({ source: 'hook', source_event_id: 'old-start', source_ts: EVENT.source_ts,
      confidence: 'confirmed', kind: 'run.created', subject,
      payload: { conversation_id: conversationId, generation: 1, state: 'idle', started_ts: EVENT.source_ts } });
    if (projected) applyIncremental(readLedgerDatabase(ledger), 0);
    const original = ledger.readSince(0, 100);
    const event = { ...EVENT, event_id: 'new-prompt', hook_event_name: 'UserPromptSubmit', source_ts: '2026-01-01T00:01:00.000Z' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const receiver = createReceiver(ledger);
      const response = await receiver.post(receiver.url, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${receiver.token}`,
      }, body: JSON.stringify(event) });
      assert.equal(response.status, 200);
    }
    const facts = ledger.readSince(0, 100);
    assert.deepEqual(facts.slice(0, original.length), original);
    assert.equal(facts.length, 3);
    assert.equal(facts[1].subject, 'conversation:["claude","session"]');
    assert.equal(facts[2].subject, subject);
    const updated = facts[2];
    assert.ok(updated.kind === 'run.updated');
    assert.equal(updated.payload?.conversation_id, '["claude","session"]');
    assert.equal(projectRuns(facts).length, 1);
    assert.equal(projectRuns(facts)[0].state, 'running');
    const receiver = createReceiver(ledger);
    assert.equal((await receiver.post(receiver.url, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${receiver.token}`,
    }, body: JSON.stringify({ ...EVENT, generation: 2, event_id: 'resume' }) })).status, 200);
    assert.equal(ledger.readSince(facts.at(-1)!.seq, 100)[0].subject, 'run:["claude","session"]:2');
  });
}

for (const projected of [false, true]) for (const split of [false, true]) {
  test(`本番の旧形 run を outbox でも再利用する（投影=${projected}、両形=${split}）`, async t => {
    const home = mkdtempSync(join(tmpdir(), 'hook-outbox-'));
    const state = join(home, 'state');
    const path = join(state, 'agent-graph', 'agent-graph.db');
    mkdirSync(join(state, 'agent-graph'), { recursive: true });
    const env = { HOME: home, XDG_STATE_HOME: state, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex') };
    const session = 'b6e4a8a5-742d-45e1-b374-97ac7bad6077';
    const generation = 1792162860493;
    const legacyId = `claude:${session}:${generation}`;
    const canonical = JSON.stringify(['claude', session]);
    const ledger = openLedger(path);
    ledger.append({ source: 'hook', source_event_id: 'old-start', kind: 'run.created',
      subject: `run:${legacyId}`, source_ts: '2026-10-16T15:01:00.510Z', confidence: 'confirmed',
      payload: { conversation_id: `claude:${session}`, generation, state: 'idle', started_ts: '2026-10-16T15:01:00.510Z' } });
    ledger.append({ source: 'transcript-claude', source_event_id: 'old-turn', kind: 'run.state_changed',
      subject: `run:${legacyId}`, source_ts: '2026-10-17T10:28:52.758Z', confidence: 'confirmed',
      payload: { conversation_id: canonical, generation, state: 'idle', last_evidence: { kind: 'turn_completed' } } });
    if (split) ledger.append({ source: 'hook', source_event_id: 'split', kind: 'run.updated',
      subject: `run:${canonical}:${generation}`, source_ts: '2026-10-17T10:29:19.611Z', confidence: 'confirmed',
      payload: { conversation_id: canonical, generation, last_evidence: { hook_event_name: 'SubagentStop', auxiliary: false } } });
    if (projected) {
      applyIncremental(readLedgerDatabase(ledger), 0);
      assert.deepEqual({ ...readLedgerDatabase(ledger).prepare('SELECT * FROM run_subjects').get() },
        { conversation_id: `claude:${session}`, generation, subject_id: legacyId });
    }
    const original = ledger.readSince(0, 100);
    ledger.close();
    const service = openObservationService({ home, env, writerOnly: true });
    t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
    mkdirSync(service.outbox);
    const event: HookEvent = { ...EVENT, session_id: session, generation, event_id: 'continue',
      hook_event_name: 'SubagentStop', source_ts: '2026-10-17T10:40:00.078Z' };
    writeFileSync(join(service.outbox, 'event.json'), JSON.stringify(event));
    service.ingestOnce();
    const facts = service.ledger.readSince(0, 100);
    assert.deepEqual(facts.slice(0, original.length), original);
    assert.equal(facts.at(-1)!.subject, `run:${legacyId}`);
    assert.equal(projectRuns(facts).length, split ? 2 : 1);
    writeFileSync(join(service.outbox, 'retry.json'), JSON.stringify(event));
    service.ingestOnce();
    const receiver = createReceiver(service.ledger);
    const response = await receiver.post(receiver.url, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${receiver.token}`,
    }, body: JSON.stringify(event) });
    assert.equal(response.status, 200);
    assert.deepEqual(service.ledger.readSince(0, 100), facts);
  });
}

for (const state of ['idle', 'running'] as const) for (const reverse of [false, true]) {
  test(`同世代の unknown は根の ${state} に勝たない（逆順=${reverse}）`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'hook-root-'));
    const path = join(directory, 'ledger.db');
    const ledger = openLedger(path);
    let feed: ProjectionFeed | undefined;
    t.after(() => { feed?.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const canonical = '["claude","session"]';
    const start = createHookFacts(EVENT)[0];
    ledger.append(start);
    ledger.append({ ...start, subject: 'conversation:claude:session', source_event_id: 'old-conversation' });
    const rows: FactInput[] = [
      { source: 'hook', source_event_id: 'known', source_ts: EVENT.source_ts, confidence: 'confirmed',
        kind: 'run.created', subject: 'run:claude:session:1',
        payload: { conversation_id: 'claude:session', generation: 1, state, started_ts: EVENT.source_ts,
          last_evidence: { hook_event_name: state === 'running' ? 'UserPromptSubmit' : 'SessionStart', auxiliary: false } } },
      { source: 'hook', source_event_id: 'unknown', source_ts: '2026-01-01T00:01:00.000Z', confidence: 'confirmed',
        kind: 'run.updated', subject: `run:${canonical}:1`,
        payload: { conversation_id: canonical, generation: 1, last_evidence: { hook_event_name: 'SubagentStop', auxiliary: false } } },
    ];
    for (const row of reverse ? rows.toReversed() : rows) {
      ledger.append(row);
      applyIncremental(readLedgerDatabase(ledger), 0);
    }
    feed = new ProjectionFeed(path, () => applyIncremental(readLedgerDatabase(ledger), 0));
    assert.equal(feed.snapshot().projection.roots[0].state, state);
    assert.equal(feed.snapshot().projection.runs.length, 2);
    ledger.append({ ...rows[1], source_event_id: 'new-generation', subject: `run:${canonical}:2`,
      payload: { conversation_id: canonical, generation: 2 } } as FactInput);
    const patch = feed.refresh();
    assert.ok(patch && patch !== 'resync');
    assert.equal(patch.changes.roots.upsert[0].state, 'unknown');
    assert.equal(feed.snapshot().projection.roots[0].state, 'unknown');
  });
}
