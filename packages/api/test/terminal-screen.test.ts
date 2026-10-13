import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalScreen, readPrompt, readPanel } from '../src/terminal/screen.ts';
import { promptFrame, HELP_PANEL, MODEL_PANEL } from './terminal-screen-fixture.ts';

for (const provider of ['claude', 'codex'] as const) test(`${provider}: only the current composer is an input-ready screen`, async t => {
  const screen = new TerminalScreen(); t.after(() => screen.close());
  screen.write(promptFrame(provider));
  assert.ok(readPrompt(await screen.read(), provider));
  screen.write(MODEL_PANEL);
  assert.equal(readPrompt(await screen.read(), provider), undefined);
  screen.write(promptFrame(provider));
  assert.ok(readPrompt(await screen.read(), provider));
});

test('cursor moves and erase sequences replace stale prompts, even across PTY chunks', async t => {
  const screen = new TerminalScreen(); t.after(() => screen.close());
  screen.write(promptFrame());
  assert.ok(readPrompt(await screen.read(), 'claude'));
  for (let index = 0; index < HELP_PANEL.length; index += 3) screen.write(HELP_PANEL.slice(index, index + 3));
  const panel = await screen.read();
  assert.equal(readPrompt(panel, 'claude'), undefined);
  assert.match(readPanel(panel), /Help\s+General/);
  assert.ok(!readPanel(panel).includes('❯ /help'));
  screen.resize(100, 36);
  screen.write(promptFrame());
  assert.ok(readPrompt(await screen.read(), 'claude'));
});

test('an old prompt above a dialog does not make the dialog input-ready', async t => {
  const screen = new TerminalScreen(); t.after(() => screen.close());
  screen.write(promptFrame() + '\x1b[8;1HSelect model\r\n❯ 1. Haiku\r\nEnter to select · Esc to cancel');
  assert.equal(readPrompt(await screen.read(), 'claude'), undefined);
});
