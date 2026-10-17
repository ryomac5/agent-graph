import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalConversationId } from '../../src/index.ts';
import { canonicalConversationId as ledgerCanonicalConversationId } from '../../src/ledger/index.ts';
import type { Fact } from '../../src/ledger/facts.ts';
import { createNativeId, serializeValue } from '../../src/ledger/projections/relations.ts';
import { projectRuns } from '../../src/ledger/projections/runs.ts';
import { createSessionEndFacts, GENERATION, SESSION } from './fixtures/session-end.ts';

const FORMS = [
  '', 'claude:', '["claude",""]', `claude:${SESSION}`, `["claude","${SESSION}"]`,
  'claude:other', '["claude","other"]', 'claude:a:b', 'claude:a"\\\n日本語',
  'codex:session', '["codex","session"]', 'legacy:session', 'runner-uuid',
  '["claude", "session"]', '["claude"]', '[invalid', 'Claude:session',
];

function changeConversation(fact: Fact, id: string): Fact {
  return { ...fact, payload: { ...fact.payload, conversation_id: id } } as Fact;
}

test('Claude の両形を同じ JSON に揃え、公開 export と冪等性を保つ', () => {
  assert.equal(ledgerCanonicalConversationId, canonicalConversationId);
  for (const nativeId of [SESSION, '', 'a:b', 'a"\\\n日本語']) {
    const expected = createNativeId('claude', nativeId);
    assert.equal(canonicalConversationId(`claude:${nativeId}`), expected);
    assert.equal(canonicalConversationId(expected), expected);
  }
  for (const id of FORMS) {
    const canonical = canonicalConversationId(id);
    assert.equal(canonicalConversationId(canonical), canonical);
    if (!id.startsWith('claude:')) assert.equal(canonical, id);
  }
});

test('文字列専用の正規化は null と undefined を拒否する', () => {
  // @ts-expect-error null は公開契約の対象外。
  assert.throws(() => canonicalConversationId(null), TypeError);
  // @ts-expect-error undefined は公開契約の対象外。
  assert.throws(() => canonicalConversationId(undefined), TypeError);
});

test('旧 matchClaudeConversation と同値で、再開しても run の ID の形を変えない', () => {
  const normalizeBefore = (id: string) => id.startsWith('claude:')
    ? JSON.stringify(['claude', id.slice('claude:'.length)]) : id;
  const [start, end, prompt] = createSessionEndFacts();
  for (const left of FORMS) {
    for (const right of FORMS) {
      const matches = normalizeBefore(left) === normalizeBefore(right);
      assert.equal(canonicalConversationId(left) === canonicalConversationId(right), matches);
      if (!left) continue;
      const next = { ...changeConversation(prompt, right), source: 'transcript-claude',
        payload: { ...prompt.payload, conversation_id: right, last_evidence: { kind: 'turn_started' } } } as Fact;
      const facts = [changeConversation(start, left), changeConversation(end, left), next];
      const before = structuredClone(facts);
      const [run] = projectRuns(facts);
      assert.equal(run.state, right && matches ? 'running' : 'ended', JSON.stringify([left, right]));
      assert.equal(run.id, `${left}:${GENERATION}`);
      assert.equal(run.conversation_id, left);
      assert.deepEqual(facts, before);
    }
  }
});

test('再開時の session_id の照合も両形で同じ結果になる', () => {
  const [start, end, prompt] = createSessionEndFacts();
  for (const id of [`claude:${SESSION}`, createNativeId('claude', SESSION)]) {
    for (const sessionId of [SESSION, 'other', '', null, undefined]) {
      const next = { ...prompt, payload: { ...prompt.payload, conversation_id: id,
        last_evidence: { hook_event_name: 'UserPromptSubmit', input: { session_id: sessionId } } } } as Fact;
      const [run] = projectRuns([changeConversation(start, id), changeConversation(end, id), next]);
      assert.equal(run.state, sessionId === SESSION || sessionId === undefined ? 'running' : 'ended');
      assert.equal(run.conversation_id, id);
    }
  }
});

test('runner が使う native ID と関係・受理記録の直列化を維持する', () => {
  assert.equal(createNativeId('claude', SESSION), `["claude","${SESSION}"]`);
  assert.equal(createNativeId('codex', 'thread:1'), '["codex","thread:1"]');
  assert.equal(serializeValue({ payload: { z: null, a: ['claude:session', null] }, command: 'resume' }),
    '{"command":"resume","payload":{"a":["claude:session",null],"z":null}}');
});
