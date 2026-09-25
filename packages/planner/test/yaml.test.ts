import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parseYaml } from "../src/yaml.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
for (const file of readdirSync(fixtures)) test(`parse ${file}`, () => {
  assert.ok(parseYaml(readFileSync(new URL(file, fixtures), "utf8")));
});
test("scalar forms", () => {
  assert.deepEqual(parseYaml("a: [one, 'two, three', \"four\"] # note\nb: true\nc: -12\nd: |\n  hello\n  world\n"), {
    a: ["one", "two, three", "four"], b: true, c: -12, d: "hello\nworld\n",
  });
});
test("block scalar preserves tabs and odd indentation", () => {
  assert.deepEqual(parseYaml("prompt: |\n  first\n   odd\n  \tindented\nnext: true\n"), {
    prompt: "first\n odd\n\tindented\n", next: true,
  });
});
test("unsupported syntax reports line", () => {
  assert.throws(() => parseYaml("ok: yes\nbad: {x: 1}\n"), /line 2/);
  assert.throws(() => parseYaml("ok: yes\n  bad: value\n"), /line 2/);
  assert.throws(() => parseYaml("ok: yes\n\tbad: value\n"), /line 2/);
});
