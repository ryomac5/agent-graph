import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "../src/index.ts";

test("ULID は長さ 26 の Crockford Base32 で時刻を符号化する", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = 0;
  for (const character of id.slice(0, 10)) {
    timestamp = timestamp * 32 + alphabet.indexOf(character);
  }
  assert.equal(timestamp, Date.now());
});

test("同一ミリ秒の ULID は一意かつ単調増加する", (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_001);
  let previous = ulid();
  for (let index = 0; index < 1_000; index += 1) {
    const current = ulid();
    assert.equal(current.slice(0, 10), previous.slice(0, 10));
    assert.ok(current > previous);
    previous = current;
  }
});

test("時刻が進んでも戻っても単調増加する", (t) => {
  let now = 1_800_000_000_002;
  t.mock.method(Date, "now", () => now);
  const first = ulid();
  now += 1;
  const second = ulid();
  now -= 100;
  const third = ulid();
  assert.ok(first < second && second < third);
});
