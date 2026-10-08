import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from '../../core/src/ledger/schema.ts';
import { createCommitConversationIndex, extractCommitEvidence, matchCommitConversations } from '../src/files/conversations.ts';
const TIME = '2026-10-08T00:00:00Z';
function makePair(command: string, content: unknown, id = 'agent', isError = false) {
  return {
    call: { conversation_id: id, source_ts: TIME, body: [{ type: 'tool_use', name: 'Bash', id: 'tool', input: { command } }] },
    result: { conversation_id: id, source_ts: TIME, body: [{ type: 'tool_result', tool_use_id: 'tool', content, is_error: isError }] },
  };
}
function makeCommit(hash = 'abc123456789', subject = 'Fix', time = TIME, parents = ['parent']) { return { hash, subject, time, parents }; }
for (const [name, output] of [ ['commit', '[main abc1234] Fix'], ['root commit', '[main (root-commit) abc1234] Fix'], ['oneline', 'abc1234 Fix'] ]) {
  test(`extracts hash and conversation from ${name}`, () => {
    const { call, result } = makePair('git -C /repo commit -m "Fix"', [{ type: 'text', text: output }]);
    const evidence = extractCommitEvidence([call], [result]);
    assert.deepEqual(evidence[0].hashes, ['abc1234']);
    assert.deepEqual(matchCommitConversations([makeCommit()], evidence).get('abc123456789'), ['agent']);
  });
}
test('uses an exact subject and picks the closest commit time, including heredoc messages', () => {
  for (const command of ['git commit -m "Fix"', "git commit -m 'Fix'", 'git commit -m "$(cat <<\'EOF\'\nFix\n\nBody\nEOF\n)"']) {
    const { call, result } = makePair(command, 'commit completed');
    const matches = matchCommitConversations([makeCommit(), makeCommit('def123456789', 'Fix', '2026-10-07T00:00:00Z'), makeCommit('aaa123456789', 'Fix extra')], extractCommitEvidence([call], [result]));
    assert.deepEqual([...matches.values()], [['agent'], [], []]);
  }
});
test('excludes help, unrelated tools, failed calls, absent results and results from other conversations', () => {
  for (const command of ['git commit --help', 'git merge --help', 'git status', 'git commits -m Fix']) {
    const { call, result } = makePair(command, '[main abc1234] Fix');
    assert.deepEqual(extractCommitEvidence([call], [result]), []);
  }
  const { call, result } = makePair('git commit -m Fix', '[main abc1234] Fix', 'agent', true);
  assert.deepEqual(extractCommitEvidence([call], [result]), []);
  assert.deepEqual(extractCommitEvidence([call], []), []);
  assert.deepEqual(extractCommitEvidence([call], [{ ...result, conversation_id: 'other' }]), []);
  assert.deepEqual(extractCommitEvidence([{ ...call, body: 'Discuss git commit' }], []), []);
});
test('links merge commits only to the conversation invoking merge, never the second parent', () => {
  const child = makePair('git commit -m Fix', '[feature def1234] Fix', 'child');
  const merge = makePair('git merge feature && git log --oneline -1', 'abc1234 Merge feature', 'root');
  const commits = [makeCommit('abc123456789', 'Merge feature', TIME, ['base', 'def123456789']), makeCommit('def123456789')];
  assert.deepEqual([...matchCommitConversations(commits, extractCommitEvidence([child.call], [child.result])).values()], [[], ['child']]);
  assert.deepEqual([...matchCommitConversations(commits, extractCommitEvidence([child.call, merge.call], [child.result, merge.result])).values()], [['root'], ['child']]);
  const fallback = makePair('git merge feature -m "Merge feature"', 'Merge made by the ort strategy.', 'merger');
  assert.deepEqual(matchCommitConversations(commits, extractCommitEvidence([fallback.call], [fallback.result])).get(commits[0].hash), ['merger']);
});
test('keeps shared conversation memberships and rejects ambiguous hash prefixes', () => {
  const first = makePair('git commit -m Fix', '[main abc1234] Fix', 'first');
  const second = makePair('git commit -m Fix', '[main abc1234] Fix', 'second');
  const evidence = extractCommitEvidence([first.call, second.call], [first.result, second.result]);
  assert.deepEqual(matchCommitConversations([makeCommit()], evidence).get('abc123456789'), ['first', 'second']);
  assert.deepEqual([...matchCommitConversations([makeCommit(), makeCommit('abc123400000')], evidence).values()], [[], []]);
});
test('caches projection evidence until its revision changes and respects active memberships', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSchema(db);
    const { call, result } = makePair('git commit -m Fix', '[main abc1234] Fix');
    for (const [id, role, message] of [['call', 'assistant', call], ['result', 'user', result]] as const) {
      db.prepare('INSERT INTO messages (id, provider, role, body, source_ts) VALUES (?, ?, ?, ?, ?)').run(id, 'claude', role, JSON.stringify(message.body), TIME);
      db.prepare('INSERT INTO message_memberships (id, message_id, conversation_id, active) VALUES (?, ?, ?, 1)').run(id, id, 'agent');
    }
    // 本文が文字列の発言は、道具の呼び出しにはならない。
    db.prepare("INSERT INTO messages (id, provider, role, body) VALUES ('text', 'claude', 'assistant', ?)").run(JSON.stringify('git commit'));
    db.exec("INSERT INTO message_memberships VALUES ('text', 'text', 'agent', 1)");
    const read = createCommitConversationIndex(db);
    assert.deepEqual(read([makeCommit()]).get('abc123456789'), ['agent']);
    db.exec('UPDATE message_memberships SET active = 0');
    assert.deepEqual(read([makeCommit()]).get('abc123456789'), ['agent']);
    db.exec('UPDATE projection_state SET last_seq = 1');
    assert.deepEqual(read([makeCommit()]).get('abc123456789'), []);
    db.exec('UPDATE message_memberships SET active = 1; UPDATE projection_state SET generation = 1');
    assert.deepEqual(read([makeCommit()]).get('abc123456789'), ['agent']);
  } finally { db.close(); }
});
