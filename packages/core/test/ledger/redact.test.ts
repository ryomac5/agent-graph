import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  HIGH_ENTROPY_MIN_LENGTH, HIGH_ENTROPY_THRESHOLD, redact, redactValue, validateRules,
} from "../../src/ledger/redact.ts";
import type { RedactionRules } from "../../src/ledger/redact.ts";

// 全て形式だけの合成値。実際の認証情報は使わない。
const SECRETS = [
  ["anthropic", `sk-ant-api03-${"Fake0".repeat(20)}`],
  ["openai", `sk-${"Fake1".repeat(10)}`],
  ["openai", `sk-proj-${"Fake2".repeat(30)}`],
  ["openai", `sk-svcacct-${"Fake3".repeat(12)}`],
  ["github", `ghp_${"A".repeat(36)}`],
  ["github", `github_pat_${"Fake4_".repeat(15)}`],
  ["aws", `AKIA${"A".repeat(16)}`],
  ["aws", `ASIA${"B".repeat(16)}`],
  ["slack", "xoxb-000000000000-000000000000-FakeOnlyNotIssued"],
  ["google", `AIza${"A".repeat(35)}`],
  ["jwt", "eyJmYWtlIjp0cnVlfQ.eyJ0ZXN0Ijp0cnVlfQ.ZmFrZXNpZ25hdHVyZQ"],
] as const;

for (const [kind, secret] of SECRETS) {
  test(`${kind} の形式を伏せ、元の値を結果と検出情報に残さない: ${secret.slice(0, 12)}`, () => {
    const input = `前置き ${secret} 後置き`;
    const result = redact(input);
    assert.equal(result.findings.length, 1);
    const hash = createHash("sha256").update(secret).digest("hex").slice(0, 4);
    assert.deepEqual(result.findings[0], {
      kind, start: 4, end: 4 + secret.length, marker: `[REDACTED:${kind}:${hash}]`,
    });
    assert.equal(result.text, `前置き [REDACTED:${kind}:${hash}] 後置き`);
    assert.ok(!JSON.stringify(result).includes(secret));
  });
}

test("GitHub の短い接頭辞と Slack の各形式を全て伏せる", () => {
  for (const prefix of ["gho_", "ghu_", "ghs_", "ghr_", "xoxp-", "xoxa-", "xoxr-", "xoxs-"]) {
    const secret = `${prefix}${"A".repeat(36)}`;
    assert.ok(!redact(secret).text.includes(secret));
  }
});

test("鍵の末尾のハイフンと下線を含めて伏せる", () => {
  for (const secret of [
    `sk-ant-${"Fake0".repeat(10)}-_`,
    `sk-proj-${"Fake1".repeat(10)}_-`,
    `github_pat_${"Fake2".repeat(10)}_`,
    `xoxb-${"Fake3".repeat(10)}-`,
  ]) {
    const result = redact(`(${secret})`);
    assert.equal(result.findings[0].end, secret.length + 1);
    assert.equal(result.text, `(${result.findings[0].marker})`);
  }
});

test("Bearer の値だけを伏せる", () => {
  const secret = "FakeOnlyBearerValue+/==";
  const result = redact(`Authorization: bEaReR ${secret}`);
  assert.equal(result.text, `Authorization: bEaReR ${result.findings[0].marker}`);
  assert.ok(!result.text.includes(secret));
});

test(".env の秘密名、export、引用符、コメント、差分の行を扱う", () => {
  for (const name of ["API_KEY", "ACCESS_TOKEN", "CLIENT_SECRET", "DB_PASSWORD", "PRIVATE_VALUE", "api_key"]) {
    for (const [prefix, value] of [["", "FakeOnlyValue"], ["export ", '"Fake only value"'], ["+", "'Fake only value'"]] as const) {
      const input = `${prefix}${name}=${value} # 説明\r\nPUBLIC_URL=https://example.invalid\r\n`;
      const result = redact(input);
      assert.equal(result.findings.length, 1);
      assert.ok(!result.text.includes(value.replace(/["']/g, "")));
      assert.ok(result.text.endsWith(" # 説明\r\nPUBLIC_URL=https://example.invalid\r\n"));
    }
  }
  assert.equal(redact("EMPTY_KEY=\n# API_KEY=not-a-setting\n").findings.length, 0);
});

test(".env のエスケープした引用符と複数行の値を末尾まで伏せる", () => {
  for (const [quote, secret] of [
    ['"', String.raw`Fake\"OnlySecretTail`],
    ["'", String.raw`Fake\'OnlySecretTail`],
    ['"', "FakeFirstLine\nFakeLastLine"],
    ["'", "FakeFirstLine\r\nFakeLastLine"],
  ]) {
    const input = `API_SECRET=${quote}${secret}${quote} # 説明\nPUBLIC_NAME=Example\n`;
    const result = redact(input);
    const start = input.indexOf(secret);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].start, start);
    assert.equal(result.findings[0].end, start + secret.length);
    assert.equal(result.text, input.replace(secret, result.findings[0].marker));
    assert.ok(!result.text.includes("SecretTail"));
    assert.ok(!result.text.includes("FakeLastLine"));
  }
});

test("鍵らしい名前に続く引用符のエスケープを含む値を末尾まで伏せる", () => {
  const secret = String.raw`ABCDEFGHIJKLMNOPQRST\"FakeSecretTail`;
  const input = `{"apiToken":"${secret}","public":"保持する"}`;
  const result = redact(input);
  assert.equal(result.findings.length, 1);
  assert.equal(result.text, input.replace(secret, result.findings[0].marker));
  assert.ok(!result.text.includes("FakeSecretTail"));
});

test("PEM 秘密鍵のブロック全体を伏せ、公開鍵は残す", () => {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
    const secret = `-----BEGIN ${label}-----\nFakeOnlyNotARealKey\n-----END ${label}-----`;
    const result = redact(`before\n${secret}\nafter`);
    assert.equal(result.findings[0].kind, "private-key");
    assert.equal(result.text, `before\n${result.findings[0].marker}\nafter`);
    assert.ok(!result.text.includes("FakeOnlyNotARealKey"));
  }
  const publicKey = "-----BEGIN PUBLIC KEY-----\nFakePublicKey\n-----END PUBLIC KEY-----";
  assert.equal(redact(publicKey).text, publicKey);
});

test("同じ秘密は本文、.env、Bearer、追加規則でも同じ印になる", () => {
  const secret = SECRETS[0][1];
  const input = `${secret}\nAPI_KEY=${secret}\nBearer ${secret}`;
  const result = redact(input, { patterns: [secret] });
  assert.equal(result.findings.length, 3);
  assert.equal(new Set(result.findings.map((finding) => finding.marker)).size, 1);
  assert.deepEqual(redact(result.text), { text: result.text, findings: [] });
  const plain = "FakeOnlyValue";
  const marker = redact(`TOKEN=${plain}`).findings[0].marker;
  assert.equal(redact(`Bearer ${plain}`).findings[0].marker, marker);
  assert.equal(redact(plain, { patterns: [plain] }).findings[0].marker, marker);
});

test("終端のない PEM は BEGIN と続く base64 行を伏せる", () => {
  for (const label of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const body of ["", `${newline}MIIEFakeOnly`, `${newline}MIIEFakeOnly${newline}QUJDRA==`, `${newline}MIIEFakeOnly…`, `${newline}MIIEFakeOnly...`]) {
        const secret = `-----BEGIN ${label}-----${body}`;
        for (const after of ["", `${newline}次のログ: 保持する`]) {
          const input = `before${newline}${secret}${after}`;
          const result = redact(input);
          assert.equal(result.findings.length, 1);
          assert.equal(result.findings[0].kind, "private-key");
          assert.equal(result.text, `before${newline}${result.findings[0].marker}${after}`);
          assert.equal(result.findings[0].end, input.length - after.length);
          assert.ok(!JSON.stringify(result).includes(secret));
          assert.deepEqual(redact(result.text), { text: result.text, findings: [] });
        }
      }
    }
  }
  const publicKey = "-----BEGIN PUBLIC KEY-----\nFakePublicKey";
  assert.equal(redact(publicKey).text, publicKey);
});

test("高エントロピーの長さと閾値の境界を確認する", () => {
  assert.equal(HIGH_ENTROPY_MIN_LENGTH, 20);
  assert.equal(HIGH_ENTROPY_THRESHOLD, 4);
  const atThreshold = "ABCDEFGHIJKLMNOP".repeat(2);
  const belowThreshold = "ABCDEFGHIJKLMNO".repeat(2);
  const atLength = "ABCDEFGHIJKLMNOPQRST";
  for (const secret of [atThreshold, atLength]) {
    assert.equal(redact(`const apiToken = "${secret}";`).findings.length, 1);
  }
  for (const value of [atLength.slice(1), belowThreshold, "A".repeat(80)]) {
    assert.equal(redact(`const apiToken = "${value}";`).findings.length, 0);
  }
  assert.equal(redact(`const content = "${atThreshold}";`).findings.length, 0);
});

test("普通の英文、日本語、コード、git SHA、UUID を誤って伏せない", () => {
  const values = [
    "The quick brown fox jumps over the lazy dog.",
    "これは秘密を含まない普通の日本語です。鍵の扱いを説明します。",
    'const key = "hello"; function add(a: number, b: number) { return a + b; }',
    'const token = "0123456789abcdef0123456789abcdef01234567";',
    `const key = "${"0123456789abcdef".repeat(4)}";`,
    'const privateId = "12345678-1234-5678-9abc-123456789abc";',
    "0123456789abcdef0123456789abcdef01234567",
    "12345678-1234-5678-9abc-123456789abc",
    'const key = "0123456789abcdef".repeat(4);',
    "PUBLIC_NAME=Example\nPUBLIC_PORT=3000\n",
  ];
  for (const value of values) assert.deepEqual(redact(value), { text: value, findings: [] });
});

test("入れ子の JSON と URL のクエリで秘密でない名前の後も検査する", () => {
  const secret = "Xy7Qp2Lm9Rt4Vb8Nc1Zk5Hw3";
  const marker = redact(`TOKEN=${secret}`).findings[0].marker;
  for (const input of [
    `{"auth":{"token":"${secret}"}}`,
    `{"auth": {"token": "${secret}"}}`,
    `url=https://x.invalid/?api_key=${secret}`,
  ]) {
    const result = redact(input);
    const start = input.indexOf(secret);
    assert.equal(result.text, input.replace(secret, marker));
    assert.deepEqual(result.findings, [{ kind: "secret", start, end: start + secret.length, marker }]);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test("オブジェクトの秘密名に続く高エントロピー値を伏せる", () => {
  const secret = "Xy7Qp2Lm9Rt4Vb8Nc1Zk5Hw3";
  const marker = redact(`TOKEN=${secret}`).findings[0].marker;
  const input = { env: { API_TOKEN: secret }, entries: [{ clientSecret: secret }], content: secret };
  const result = redactValue(input);
  assert.deepEqual(result, {
    env: { API_TOKEN: marker }, entries: [{ clientSecret: marker }], content: secret,
  });
  assert.equal(input.env.API_TOKEN, secret);
  assert.deepEqual(redactValue(result), result);
  assert.deepEqual(redactValue(input, { defaults: false }), input);
});

test("オブジェクトの秘密名でも長さとエントロピーの境界と識別子の除外を守る", () => {
  for (const secret of ["ABCDEFGHIJKLMNOP".repeat(2), "ABCDEFGHIJKLMNOPQRST"]) {
    assert.deepEqual(redactValue({ API_TOKEN: secret }), { API_TOKEN: redact(`TOKEN=${secret}`).text.slice(6) });
  }
  for (const value of [
    "ABCDEFGHIJKLMNOPQRS", "ABCDEFGHIJKLMNO".repeat(2), "A".repeat(80),
    "0123456789abcdef0123456789abcdef01234567", "0123456789abcdef".repeat(4),
    "12345678-1234-5678-9abc-123456789abc",
  ]) {
    assert.deepEqual(redactValue({ API_TOKEN: value }), { API_TOKEN: value });
  }
});

test("入れ子の文字列を伏せ、元のオブジェクトと非文字列を保持する", () => {
  const secret = SECRETS[1][1];
  const input = { payload: [{ text: secret, nested: [null, 42, true, { output: secret }] }], ordinary: "日本語" };
  const marker = redact(secret).text;
  assert.deepEqual(redactValue(input), {
    payload: [{ text: marker, nested: [null, 42, true, { output: marker }] }], ordinary: "日本語",
  });
  assert.equal(input.payload[0].text, secret);
  assert.equal(redactValue(undefined), undefined);
  assert.equal(redactValue(secret), marker);
});

test("循環と共有参照をたどり、__proto__ は通常のキーとして保持する", () => {
  const input: Record<string, unknown> = JSON.parse('{"__proto__":{"text":"Bearer FakeOnlyValue"}}');
  input.self = input;
  input.shared = input.__proto__;
  const result = redactValue(input) as Record<string, unknown>;
  assert.equal(result.self, result);
  assert.equal(result.shared, result.__proto__);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.ok(!JSON.stringify(result.__proto__).includes("FakeOnlyValue"));
});

test("入れ子のオブジェクトと配列の文字列キーにも既定と追加の規則を適用する", () => {
  const secret = SECRETS[0][1];
  const marker = redact(secret).text;
  const input = { nested: [{ [secret]: { "CUSTOM-EXAMPLE": secret } }] };
  const rules = { patterns: ["CUSTOM-[A-Z]+"] };
  const customMarker = redact("CUSTOM-EXAMPLE", rules).text;
  const result = redactValue(input, rules);
  assert.deepEqual(result, { nested: [{ [marker]: { [customMarker]: marker } }] });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("CUSTOM-EXAMPLE"));
  assert.equal(input.nested[0][secret]["CUSTOM-EXAMPLE"], secret);
  assert.deepEqual(redactValue(result, rules), result);
  assert.deepEqual(redactValue(input, { defaults: false }), input);
});

test("秘匿したキーの衝突は予約済みの接尾辞を避けて全ての値を保持する", () => {
  const secret = SECRETS[0][1];
  const marker = redact(secret).text;
  for (const entries of [
    [[secret, "first"], [marker, "second"], [`${marker}#1`, "reserved"]],
    [[marker, "first"], [secret, "second"], [`${marker}#1`, "reserved"]],
  ]) {
    const result = redactValue(Object.fromEntries(entries));
    assert.deepEqual(result, { [marker]: "first", [`${marker}#2`]: "second", [`${marker}#1`]: "reserved" });
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(redactValue(result), result);
  }
});

test("Date などの特殊なオブジェクトは入れ子でもそのまま保持する", () => {
  class Example {
    value = 42;
  }
  const values = [new Date(0), /example/g, new Map([["name", "value"]]), new Set(["value"]), new Uint8Array([1, 2]), new Example()];
  for (const value of values) {
    assert.equal(redactValue(value), value);
    const result = redactValue({ at: value, nested: [value] }) as { at: unknown; nested: unknown[] };
    assert.equal(result.at, value);
    assert.equal(result.nested[0], value);
  }
  assert.equal(JSON.stringify(redactValue({ at: new Date(0) })), '{"at":"1970-01-01T00:00:00.000Z"}');
  const plain = Object.create(null);
  plain[SECRETS[0][1]] = SECRETS[1][1];
  const result = redactValue(plain);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(JSON.stringify(result), JSON.stringify({ [redact(SECRETS[0][1]).text]: redact(SECRETS[1][1]).text }));
});

test("追加規則は全ての一致に適用し、正規表現の状態を変更しない", () => {
  const pattern = /FAKE-\d+/iy;
  pattern.lastIndex = 10;
  const rules: RedactionRules = { patterns: [pattern, "CUSTOM-[A-Z]+"] };
  const result = redact("fake-123 FAKE-456 CUSTOM-EXAMPLE", rules);
  assert.equal(result.findings.length, 3);
  assert.equal(pattern.lastIndex, 10);
  assert.deepEqual(redact("fake-123 FAKE-456 CUSTOM-EXAMPLE", rules), result);
  assert.deepEqual(validateRules(rules), []);
  assert.ok(!JSON.stringify(redactValue({ a: ["CUSTOM-EXAMPLE"] }, rules)).includes("CUSTOM-EXAMPLE"));
  assert.equal(redact(SECRETS[0][1], { defaults: false }).text, SECRETS[0][1]);
  assert.equal(redact("CUSTOM-EXAMPLE", { defaults: false, patterns: rules.patterns }).findings.length, 1);
});

test("不正な正規表現は検証の誤りを返し、未検証の規則では保存用の値を返さない", () => {
  const rules = { patterns: ["[", "valid", "("] };
  assert.deepEqual(validateRules(rules), [
    { index: 0, message: "不正な正規表現です" },
    { index: 2, message: "不正な正規表現です" },
  ]);
  assert.throws(() => redact("text", rules), TypeError);
  assert.throws(() => redactValue({}, rules), TypeError);
  assert.deepEqual(validateRules(), []);
  assert.deepEqual(redact("abc", { patterns: ["(?:)"] }), { text: "abc", findings: [] });
});

test("重なる追加規則は範囲をまとめ、元の位置を維持する", () => {
  const result = redact("x abcdef y zz", { defaults: false, patterns: ["abcd", "cdef", "zz"] });
  assert.deepEqual(result.findings.map(({ start, end }) => [start, end]), [[2, 8], [11, 13]]);
  assert.equal(result.text, `x ${result.findings[0].marker} y ${result.findings[1].marker}`);
});
