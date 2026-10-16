import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fact, FactInput, RunPayload } from '../../src/ledger/facts.ts';
import { applyIncremental, openLedger, readLedgerDatabase, rebuild } from '../../src/ledger/index.ts';
import { projectRuns } from '../../src/ledger/projections/runs.ts';
import { projectInputQueues } from '../../src/ledger/projections/input-queue.ts';
import { createSessionEndFacts, CONVERSATION, GENERATION, SESSION, END, RESUME } from './fixtures/session-end.ts';

function change(fact: Fact, payload: object, extra: Partial<Fact> = {}): Fact {
  return { ...fact, payload: { ...fact.payload, ...payload }, ...extra } as Fact;
}

test('SessionEnd(other) 後の同一 session・世代の新しいターンで running、Stop で idle に戻る', () => {
  const [start, end, prompt, stop] = createSessionEndFacts();
  for (const next of [prompt, change(prompt, { conversation_id: JSON.stringify(['claude', SESSION]),
    last_evidence: { kind: 'turn_started', turn_id: 'new-turn' } }, { source: 'transcript-claude' })]) {
    const facts = [start, end, next];
    const run = projectRuns(facts)[0];
    assert.equal(run.state, 'running');
    assert.equal(run.id, `${CONVERSATION}:${GENERATION}`);
    assert.equal(run.turn_started_ts, RESUME);
    assert.equal(run.ended_ts, undefined);
    assert.equal(run.end_evidence, undefined);
    assert.equal(run.cause, undefined);
    assert.equal(run.reason, undefined);
    assert.deepEqual(projectRuns([...facts].reverse()), [run]);
    assert.deepEqual(projectRuns([...facts, ...facts]), [run]);
    const idle = projectRuns([...facts, stop])[0];
    assert.equal(idle.state, 'idle');
    assert.equal(idle.turn_started_ts, undefined);
    assert.equal(idle.ended_ts, undefined);
  }
});

test('新しい開始のない SessionEnd、遅延・同時刻・別会話・別世代・弱い根拠では復帰しない', () => {
  const [start, end, prompt, stop] = createSessionEndFacts();
  const invalid = [
    stop,
    change(prompt, { state: 'running', last_evidence: {} }),
    change(prompt, { last_evidence: { kind: 'tool_result' } }, { source: 'transcript-claude' }),
    change(prompt, { last_evidence: { kind: 'tool_call' } }, { source: 'transcript-claude' }),
    change(prompt, {}, { confidence: 'inferred' }),
    change(prompt, {}, { source: 'legacy' }),
    change(prompt, {}, { source: 'host-claude' }),
    change(prompt, { conversation_id: 'claude:other' }),
    change(prompt, { generation: GENERATION + 1 }),
    change(prompt, { generation: undefined }),
    change(prompt, { conversation_id: undefined }),
    change(prompt, { last_evidence: { hook_event_name: 'UserPromptSubmit', input: { session_id: 'other' } } }),
    change(prompt, { last_evidence: { hook_event_name: 'UserPromptSubmit', auxiliary: true } }),
    change(prompt, { last_evidence_ts: END }),
    change(prompt, { last_evidence_ts: '2026-10-14T09:00:00Z' }),
    change(prompt, { last_evidence_ts: 'invalid' }),
    change(prompt, {}, { source_ts: END }),
    change(prompt, {}, { source_ts: '2026-10-14T09:00:00Z', observed_ts: RESUME }),
  ];
  assert.equal(projectRuns([start, end])[0].state, 'ended');
  for (const next of invalid) {
    const run = projectRuns([start, end, next]).find(run => run.generation === GENERATION)!;
    assert.equal(run.state, 'ended', JSON.stringify(next));
    assert.equal(run.ended_ts, END);
  }
});

test('終了前の hook の作業中状態で再開後の履歴の完了を抑制しない', () => {
  const [start, end, prompt, stop] = createSessionEndFacts();
  const earlier = change(prompt, { last_evidence_ts: '2026-10-14T08:00:00Z' }, {
    fact_id: 'earlier-prompt', source_event_id: 'earlier-prompt', source_ts: '2026-10-14T08:00:00Z' });
  const resumed = change(prompt, { last_evidence: { kind: 'turn_started' } }, { source: 'transcript-claude' });
  const completed = change(stop, { last_evidence: { kind: 'turn_completed' } }, { source: 'transcript-claude' });
  const facts = [start, earlier, end, resumed];
  assert.equal(projectRuns(facts)[0].state, 'running');
  assert.equal(projectRuns([...facts, completed])[0].state, 'idle');
});

test('本当に終了した run と失敗した run を新しいターンで復帰させない', () => {
  const [start, end, prompt] = createSessionEndFacts();
  const terminals: Fact[] = [
    change(end, { end_evidence: { kind: 'host_exit', exit_code: 0 } }, { source: 'host-claude' }),
    change(end, { end_evidence: { kind: 'thread_closed' } }, { source: 'host-codex' }),
    change(end, { end_evidence: { kind: 'archived', location: 'archived_sessions' } }, { source: 'rollout-codex' }),
    change(end, { end_evidence: { kind: 'user_correction' } }, { source: 'ui' }),
    change(end, { end_evidence: { kind: 'process_check', succeeded: true, matches: false, pid: 1, start_fingerprint: 'p1' } }),
    change(end, { state: 'failed', cause: 'exit 1', end_evidence: { kind: 'host_exit', exit_code: 1 } }, { source: 'host-claude' }),
  ];
  for (const terminal of terminals) {
    const created = change(start, { pid: 1, start_fingerprint: 'p1' });
    const run = projectRuns([created, terminal, prompt])[0];
    assert.equal(run.state, (terminal.payload as RunPayload).state);
    // SessionEnd の後に届く確実な終了も見落とさない。
    const later = { ...terminal, fact_id: 'hard-end', source_event_id: 'hard-end', source_ts: '2026-10-14T09:09:00Z' };
    assert.equal(projectRuns([created, end, later, prompt])[0].state, run.state);
  }
  const incomplete = change(end, { state: 'failed', end_evidence: { kind: 'host_exit', exit_code: 1 } }, {
    source: 'host-claude', fact_id: 'incomplete-failure', source_event_id: 'incomplete-failure', source_ts: RESUME });
  assert.equal(projectRuns([start, end, incomplete])[0].state, 'ended');
});

test('二度目の SessionEnd より古い開始では復帰せず、終了の訂正は境界からも除く', () => {
  const [start, end, prompt] = createSessionEndFacts();
  const later = change(end, { ended_ts: '2026-10-14T09:10:42Z' }, {
    fact_id: 'end-again', source_event_id: 'end-again', source_ts: '2026-10-14T09:10:42Z' });
  assert.equal(projectRuns([start, end, later, prompt])[0].state, 'ended');
  const corrected = change(prompt, {}, { supersedes: end.fact_id });
  assert.equal(projectRuns([start, end, corrected])[0].state, 'running');
});

test('既存版の ended 投影は次の事実で直り、投影世代を変えず rebuild と一致する', t => {
  const ledger = openLedger(':memory:');
  t.after(() => ledger.close());
  const db = readLedgerDatabase(ledger);
  const [start, end, prompt, stop] = createSessionEndFacts();
  for (const fact of [start, end]) ledger.append(fact as FactInput);
  let state = applyIncremental(db, 0);
  const generation = state.generation;
  const version = db.prepare('SELECT version FROM runner_projection_version').get()!.version;
  const read = () => JSON.parse(String(db.prepare("SELECT data FROM projection_records WHERE projection = 'runs'").get()!.data));
  assert.equal(read().state, 'ended');
  ledger.append(prompt as FactInput);
  state = applyIncremental(db, state.last_seq);
  assert.equal(read().state, 'running');
  assert.equal(db.prepare('SELECT ended_ts FROM runs').get()!.ended_ts, null);
  assert.equal(state.generation, generation);
  assert.equal(db.prepare('SELECT version FROM runner_projection_version').get()!.version, version);
  // 新しいターンの事実まで処理済みだが、旧実装が ended に固定した本番投影も再現する。
  const stale = projectRuns([start, end])[0];
  db.prepare("UPDATE projection_records SET data = ? WHERE projection = 'runs'").run(JSON.stringify(stale));
  db.prepare("UPDATE runs SET state = 'ended', ended_ts = ?, end_evidence = ?, turn_started_ts = NULL")
    .run(stale.ended_ts!, JSON.stringify(stale.end_evidence));
  assert.equal(read().state, 'ended');
  ledger.append(stop as FactInput);
  state = applyIncremental(db, state.last_seq);
  assert.equal(state.generation, generation);
  const before = read();
  assert.equal(before.state, 'idle');
  rebuild(db);
  assert.deepEqual(read(), before);
});

test('再開しても終了前の Queued は戻らず、終了後の入力だけを保つ', () => {
  const [start, end, prompt, stop] = createSessionEndFacts();
  const queue = (id: string, ts: string): Fact => ({ ...prompt, fact_id: id, source_event_id: `${ts}:${id}`,
    kind: 'conversation.input_queue_changed', subject: `conversation:${CONVERSATION}`, source_ts: ts,
    payload: { input_queue_event: { operation: 'enqueue', body: id } } });
  const facts = [start, queue('old', '2026-10-14T09:00:00Z'), end, queue('new', '2026-10-14T09:10:00Z'), prompt];
  assert.equal(projectRuns(facts)[0].state, 'running');
  for (const input of [facts, [...facts, stop], [...facts].reverse()]) {
    assert.deepEqual(projectInputQueues(input).get(CONVERSATION)?.map(row => row.body), ['new']);
  }
  const correction = change(prompt, {}, { supersedes: end.fact_id });
  assert.deepEqual(projectInputQueues([...facts.slice(0, -1), correction]).get(CONVERSATION)?.map(row => row.body), ['old', 'new']);
});
