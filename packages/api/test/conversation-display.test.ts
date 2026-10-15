import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateState } from '../../core/src/state/index.ts';
import type { StateDecision } from '../../core/src/state/index.ts';
import { renderConversationState } from '../src/service/conversation-display.ts';

const base = evaluateState({ runId: 'parent', turnId: null, process: null, attempt: null, evidence: [] }, 0);
const waitingCases = new Set(['Idle/Working/launched', 'Idle/Working/incomplete',
  'Idle/Needs approval/launched', 'Idle/Needs approval/incomplete']);
const parentTurns = { Idle: 'completed', Working: 'running', Stopped: 'unknown', Unknown: 'unknown', 'Needs approval': 'waiting_approval' } as const;
for (const parent of ['Idle', 'Working', 'Stopped', 'Unknown', 'Needs approval'] as const)
  for (const child of ['Working', 'Needs approval', 'Unknown', 'Stopped', 'Idle', 'Waiting'] as const)
    for (const result of ['launched', 'incomplete', 'succeeded', 'unknown'] as const)
      test(`代表表示: parent=${parent}, child=${child}, attempt=${result}`, () => {
        const p: StateDecision = { ...base, turn: { ...base.turn, value: parentTurns[parent] }, display: { ...base.display, label: parent } };
        const c: StateDecision = { ...base, display: { ...base.display, label: child }, result: { ...base.result,
          attemptId: 'attempt', stage: result === 'launched' ? 'launched' : null, value: result === 'launched' ? 'unknown' : result } };
        const decision = renderConversationState(p, [c]);
        const waiting = waitingCases.has(`${parent}/${child}/${result}`);
        assert.equal(decision.display.label, waiting ? 'Waiting for agents' : parent);
        assert.equal(decision.turn, p.turn);
        assert.equal(renderConversationState(p, []).display.label, parent);
      });
