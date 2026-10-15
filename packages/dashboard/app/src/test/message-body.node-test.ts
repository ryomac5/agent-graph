import assert from 'node:assert/strict';
import test from 'node:test';
import { readBody, readMessageBody, visibleText } from '../lib/message-body.ts';

test('保存済みの札付きコマンドを本文の読み出しで正規化する', () => {
  const command = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>';
  for (const body of [command, JSON.stringify(command), JSON.stringify({ text: command }),
    [{ type: 'text', text: command }], { content: command }]) {
    const row = { body, content_normalized: true };
    assert.equal(readBody(body), '/model haiku');
    assert.equal(readMessageBody(row), '/model haiku');
    assert.equal(visibleText(readMessageBody(row), row.content_normalized), '/model haiku');
    assert.equal(readMessageBody(row), '/model haiku');
    assert.equal(row.body, body);
  }
  assert.equal(readBody('<command-name>/model</command-name>'), '/model');
  assert.equal(readBody('/model haiku'), '/model haiku');
  const example = `Example:\n\`\`\`xml\n${command}\n\`\`\``;
  assert.equal(readBody(example), example);
  assert.equal(readBody('  Ordinary text  '), '  Ordinary text  ');
});
