import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodexTurnModel } from '../../src/ledger/turns.ts';
import { serializeValue } from '../../src/ledger/projections/relations.ts';
import type { JsonValue } from '../../src/ledger/facts.ts';

test('turn_context のモデルは状態の判定から独立して読む', () => {
  assert.deepEqual(readCodexTurnModel({ type: 'turn_context', payload: { model: 'gpt-test', reasoning: { effort: 'high' } } }), { model: 'gpt-test', effort: 'high' });
  assert.deepEqual(readCodexTurnModel({ type: 'event_msg', payload: { model: 'other' } }), {});
});

test("投影の中で組んだ値の未定義の欄は、JSON と同じく省く", () => {
  const value = { attempt: 1, result: undefined, items: [undefined, 2] } as unknown as JsonValue;
  assert.equal(serializeValue(value), '{"attempt":1,"items":[null,2]}');
  assert.deepEqual(JSON.parse(serializeValue(value)), { attempt: 1, items: [null, 2] });
});
