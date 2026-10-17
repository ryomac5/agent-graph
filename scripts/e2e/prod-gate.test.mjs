import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRssSlope, countDatabaseLocked, assessRss, parseOptions } from './prod-gate.mjs';

const mib = 1024 * 1024;
const sample = (minute, rss) => ({ atMs: 123456 + minute * 60000, rssBytes: rss * mib });

test('RSS slope uses elapsed minutes and MiB, including irregular intervals', () => {
  assert.equal(calculateRssSlope([sample(0, 100), sample(1, 102), sample(3, 106)]), 2);
  assert.equal(calculateRssSlope([sample(0, 100), sample(1, 100), sample(3, 100)]), 0);
  assert.equal(calculateRssSlope([sample(0, 106), sample(1, 104), sample(3, 100)]), -2);
});

test('OLS includes intermediate samples rather than just endpoints', () => {
  assert.ok(calculateRssSlope([sample(0, 100), sample(1, 200), sample(2, 100), sample(3, 100)]) < 0);
});

test('missing, invalid, duplicate and reversed RSS samples cannot pass', () => {
  for (const samples of [[], [sample(0, 1), sample(1, 1)],
    [sample(0, 1), sample(0, 2), sample(1, 3)],
    [sample(1, 1), sample(0, 2), sample(2, 3)],
    [sample(0, 1), sample(1, NaN), sample(2, 3)],
    [sample(0, 1), sample(1, 0), sample(2, 3)]]) {
    assert.throws(() => calculateRssSlope(samples));
  }
});

test('RSS peak includes startup, slope excludes startup', () => {
  const samples = [sample(0, 2000), sample(1, 100), sample(2, 100), sample(3, 100)];
  assert.equal(assessRss(samples, samples[1].atMs, 1024, 1).pass, false);
  const result = assessRss(samples, samples[1].atMs, 2000, 0);
  assert.equal(result.pass, true);
  assert.equal(result.peakMiB, 2000);
  assert.equal(result.slopeMiBMin, 0);
  assert.equal(result.steadySamples, 3);
});

test('sustained growth fails even below RSS cap; exact limits pass', () => {
  const samples = [sample(0, 100), sample(1, 102), sample(2, 104)];
  assert.equal(assessRss(samples, 0, 1024, 1).pass, false);
  assert.equal(assessRss(samples, 0, 104, 2).pass, true);
  assert.throws(() => assessRss(samples, samples[1].atMs, 1024, 1));
});

test('locked occurrences survive chunk boundaries and count repeats on one line', () => {
  const text = 'Session: database is locked\r\nObservation: DATABASE IS LOCKED database is locked';
  assert.equal(countDatabaseLocked([]), 0);
  assert.equal(countDatabaseLocked(['database is busy\nlocked']), 0);
  assert.equal(countDatabaseLocked([text]), 3);
  for (let i = 0; i <= text.length; i++) {
    assert.equal(countDatabaseLocked([text.slice(0, i), text.slice(i)]), 3);
  }
  assert.equal(countDatabaseLocked([...text]), 3);
});

test('CLI defaults and overrides are validated without starting services', () => {
  assert.equal(parseOptions(['--help']).help, true);
  assert.equal(parseOptions(['--rss-limit-mib', '2048', '--locked-limit', '2'])['rss-limit-mib'], 2048);
  for (const args of [['--unknown'], ['--db-copy'], ['--sample-ms', '0'], ['--rss-limit-mib', 'NaN'],
    ['--locked-limit', '0.5'], ['--observe-ms', '1'], ['--sample-ms']]) {
    assert.throws(() => parseOptions(args));
  }
});
