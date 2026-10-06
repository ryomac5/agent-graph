import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { readAppendOnlyFile } from "../../src/observe/files.ts";

function createFile(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "history.jsonl");
}
test("cursor はバイト位置とハッシュを持ち、同じファイルと追記を読み分ける", (t) => {
  const path = createFile(t);
  writeFileSync(path, "一行目\r\nsecond\n");
  const first = readAppendOnlyFile(path);
  assert.deepEqual(first.lines.map((line) => line.text), ["一行目", "second"]);
  assert.equal(first.cursor.offset, Buffer.byteLength("一行目\r\nsecond\n"));
  assert.match(first.cursor.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(readAppendOnlyFile(path, JSON.parse(JSON.stringify(first.cursor))).lines, []);
  appendFileSync(path, "third\n");
  const next = readAppendOnlyFile(path, first.cursor);
  assert.deepEqual(next.lines.map((line) => line.text), ["third"]);
  assert.equal(next.reset, false);
  assert.notEqual(next.cursor.hash, first.cursor.hash);
});
test("途中の行と途中の UTF-8 を保留し、完成したとき一度だけ返す", (t) => {
  const path = createFile(t);
  const tail = Buffer.from("日本語\n");
  writeFileSync(path, Buffer.concat([Buffer.from("complete\n"), tail.subarray(0, 2)]));
  const first = readAppendOnlyFile(path);
  assert.equal(first.pendingBytes, 2);
  assert.equal(first.cursor.offset, 9);
  assert.deepEqual(readAppendOnlyFile(path, first.cursor).lines, []);
  appendFileSync(path, tail.subarray(2));
  const next = readAppendOnlyFile(path, first.cursor);
  assert.deepEqual(next.lines.map((line) => line.text), ["日本語"]);
  assert.equal(next.pendingBytes, 0);
});
test("短縮、同じ長さの書き換え、inode の置き換えを検出する", (t) => {
  const path = createFile(t);
  writeFileSync(path, "first\nsecond\n");
  let previous = readAppendOnlyFile(path).cursor;
  for (const content of ["short\n", "other\n", "a longer replacement\n"]) {
    writeFileSync(path, content);
    const next = readAppendOnlyFile(path, previous);
    assert.equal(next.reset, true);
    assert.equal(next.lines[0].text, content.trim());
    previous = next.cursor;
  }
  const replacement = `${path}.new`;
  writeFileSync(replacement, "a longer replacement\n");
  renameSync(replacement, path);
  assert.equal(readAppendOnlyFile(path, previous).reset, true);
});
test("読み取りブロックをまたぐ行と末尾を扱う", (t) => {
  const path = createFile(t);
  const text = "x".repeat(100_000);
  writeFileSync(path, `${text}\ntrailing`);
  const result = readAppendOnlyFile(path);
  assert.equal(result.lines[0].text, text);
  assert.equal(result.pendingBytes, 8);
  appendFileSync(path, "\n");
  assert.equal(readAppendOnlyFile(path, result.cursor).lines[0].text, "trailing");
});
