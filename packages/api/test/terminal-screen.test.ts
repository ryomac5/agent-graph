import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TerminalScreen, isInputBlocked, readPrompt, readPanel } from '../src/terminal/screen.ts';
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
  assert.equal(isInputBlocked(await screen.read(), 'claude'), true);
});

// Claude Code 2.1.296 の .agents/slash-smoke/model-selection.json から、パネル本文だけを保存した標本。
const recordedPanels = JSON.parse(readFileSync(new URL('./samples/terminal-panels/claude.json', import.meta.url), 'utf8')) as { command: string; lines: string[] }[];
for (const panel of recordedPanels) test(`recorded ${panel.command} blocks input while the panel is open, but not in history`, async t => {
  const screen = new TerminalScreen(); t.after(() => screen.close());
  screen.resize(100, 40);
  screen.write('\x1b[2J\x1b[H' + panel.lines.join('\r\n') + '\x1b[1;1H');
  const snapshot = await screen.read();
  assert.equal(isInputBlocked(snapshot, 'claude'), true);
  const lines = [...snapshot.lines.filter(Boolean), '────────────────────────────────────────', '❯ ', '────────────────────────────────────────'];
  assert.equal(isInputBlocked({ ...snapshot, lines, cursorY: lines.length - 2 }, 'claude'), false);
});

test('Codex has no verified blocking panels and does not require a footer to allow input', async t => {
  const screen = new TerminalScreen(); t.after(() => screen.close());
  for (const frame of [MODEL_PANEL, '\x1b[2J\x1b[HWorking…', '\x1b[2J\x1b[H› \x1b[1;3H']) {
    screen.write(frame);
    assert.equal(isInputBlocked(await screen.read(), 'codex'), false);
  }
});
