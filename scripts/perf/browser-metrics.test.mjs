import assert from 'node:assert/strict';
import test from 'node:test';
import { isLastMessageVisible, measureConversationScroll } from './browser-metrics.mjs';

function setGlobal(t, key, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key]; });
}

test('browser script checks the last message and waits for the conversation window', t => {
  let loading = true;
  let top = 80;
  const box = { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  const article = { getBoundingClientRect: () => ({ top, bottom: top + 20 }) };
  setGlobal(t, 'document', { querySelector: () => ({
    querySelector: selector => selector === '.conv-timeline' ? box : loading ? {} : null,
    querySelectorAll: () => [article],
  }) });
  assert.equal(isLastMessageVisible(), false);
  loading = false;
  assert.equal(isLastMessageVisible(), true);
  top = 120;
  assert.equal(isLastMessageVisible(), false);
});

test('browser script reports 120 scroll frames, task durations and React work', async t => {
  const metrics = { commits: 2, workFibers: 10, longTasks: [{ ms: 90 }] };
  let frames = 0;
  let events = 0;
  const box = { scrollTop: 20000, dispatchEvent: event => { assert.equal(event.type, 'scroll'); events++; },
    querySelectorAll: () => Array.from({ length: 200 }) };
  setGlobal(t, 'window', { __perf: metrics });
  setGlobal(t, 'document', { querySelector: () => box });
  setGlobal(t, 'requestAnimationFrame', callback => {
    frames++;
    if (frames % 10 === 0) { metrics.commits++; metrics.workFibers += 3; metrics.longTasks.push({ ms: 60, start: frames }); }
    callback(performance.now());
  });
  const result = await measureConversationScroll();
  assert.equal(box.scrollTop, 2000);
  assert.equal(events, 120);
  assert.equal(result.frames.length, 120);
  assert.equal(result.commits, 12);
  assert.equal(result.workFibers, 36);
  assert.equal(result.longTasks.length, 12);
  assert.ok(result.longTasks.every(task => task.ms === 60));
  assert.equal(result.messages, 200);
  assert.ok(result.ms >= 0);
});
