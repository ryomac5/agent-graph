import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

function readStyles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? readStyles(path) : entry.name.endsWith('.css') ? [readFileSync(path, 'utf8')] : [];
  });
}
const styles = readStyles('app/src');
const shared = readFileSync('app/src/styles.css', 'utf8');
function readTokens(selector: RegExp, css = shared): Map<string, string> {
  const block = css.match(selector)![1];
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}
const BODY_CONTRAST = 7;
const SECONDARY_CONTRAST = 4.5;
const BORDER_CONTRAST = 3;
const surfaces = ['--bg-0', '--bg-1', '--bg-2', '--bg-3'];
const light = readTokens(/:root\s*\{([^}]+)\}/);
const dark = new Map([...light, ...readTokens(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/)]);

it('matches the design document with explicit contrast overrides pending document updates', () => {
  const document = readFileSync('../../docs/agents/design-system.md', 'utf8');
  // D2の要件を優先する差分。scope外の設計書に反映後、この例外を外す。
  const overrides: Record<string, [string, string]> = {
    '--fg-2': ['#454750', '#c8cad2'],
    '--fg-3': ['#545660', '#b1b4bf'],
    '--fg-4': ['#63656e', '#979ba7'],
    '--accent': ['#35418f', '#a6afff'],
    '--accent-hover': ['#2b357a', '#bac1ff'],
    '--on-accent': ['#ffffff', '#111215'],
    '--focus': ['var(--accent)', 'var(--accent)'],
    '--state-running': ['#17683d', '#3fbf7a'],
    '--state-approval': ['#874600', '#f0a03c'],
    '--state-reply': ['#225daa', '#5aa2f0'],
    '--state-failed': ['#a52424', '#f06464'],
    '--state-done': ['#4b5b7e', '#93a3c8'],
    '--state-idle': ['#60626b', '#a1a3ab'],
    '--diff-add-fg': ['#125832', '#86e3ad'],
    '--diff-del-fg': ['#922026', '#ffa5a8'],
  };
  let checked = 0;
  for (const line of document.split('\n')) {
    const token = line.match(/^\| `(--[\w-]+)`/);
    const colours = [...line.matchAll(/`(#[\da-f]{6}|rgb\([^`]+\))`/g)].map(match => match[1]);
    if (!token || colours.length !== 2) continue;
    const expected = overrides[token[1]] ?? colours;
    expect(light.get(token[1]), token[1] + ' light').toBe(expected[0]);
    expect(dark.get(token[1]), token[1] + ' dark').toBe(expected[1]);
    checked++;
  }
  expect(checked).toBe(23);
});

function readColour(tokens: Map<string, string>, token: string): string {
  const value = tokens.get(token)!;
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  return reference ? readColour(tokens, reference[1]) : value;
}
function calculateLuminance(colour: string): number {
  expect(colour).toMatch(/^#[\da-f]{6}$/i);
  const channels = colour.slice(1).match(/../g)!.map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function calculateContrast(tokens: Map<string, string>, foreground: string, background: string): number {
  const values = [foreground, background].map(token => calculateLuminance(readColour(tokens, token)));
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}
it('keeps explicit and automatic dark palettes identical', () => {
  expect(readTokens(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/))
    .toEqual(readTokens(/:root:not\(\[data-theme='light'\]\)\s*\{([^}]+)\}/));
});
it.each([['light', light], ['dark', dark]] as const)('meets WCAG contrast for %s text, borders and conversation surfaces', (theme, tokens) => {
  for (const background of surfaces) {
    expect(calculateContrast(tokens, '--fg-1', background), theme + ' body on ' + background).toBeGreaterThanOrEqual(BODY_CONTRAST);
    for (const foreground of ['--fg-2', '--fg-3', '--fg-4', '--accent', '--accent-hover', '--provider-claude', '--provider-codex',
      '--state-running', '--state-approval', '--state-reply', '--state-failed', '--state-done', '--state-idle']) {
      expect(calculateContrast(tokens, foreground, background), theme + ' ' + foreground + ' on ' + background).toBeGreaterThanOrEqual(SECONDARY_CONTRAST);
    }
    for (const foreground of ['--accent', '--accent-hover']) {
      expect(calculateContrast(tokens, foreground, background), theme + ' link on ' + background).toBeGreaterThanOrEqual(BODY_CONTRAST);
    }
    for (const foreground of ['--input-line', '--focus']) {
      expect(calculateContrast(tokens, foreground, background), theme + ' ' + foreground + ' on ' + background).toBeGreaterThanOrEqual(BORDER_CONTRAST);
    }
  }
  for (const background of ['--accent', '--accent-hover']) {
    expect(calculateContrast(tokens, '--on-accent', background), theme + ' button on ' + background).toBeGreaterThanOrEqual(BODY_CONTRAST);
  }
  for (const kind of ['add', 'del']) {
    expect(calculateContrast(tokens, '--diff-' + kind + '-fg', '--diff-' + kind + '-bg'), theme + ' diff ' + kind).toBeGreaterThanOrEqual(BODY_CONTRAST);
  }
});
it.each(['light', 'dark'] as const)('meets contrast for %s syntax highlighting', theme => {
  const css = readFileSync('app/src/pages/files/highlight.css', 'utf8');
  const syntax = readTokens(/:root\s*\{([^}]+)\}/, css);
  const tokens = new Map([...(theme === 'light' ? light : dark), ...syntax,
    ...(theme === 'dark' ? readTokens(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/, css) : [])]);
  for (const foreground of syntax.keys()) for (const background of ['--bg-0', '--bg-1']) {
    expect(calculateContrast(tokens, foreground, background), theme + ' ' + foreground + ' on ' + background).toBeGreaterThanOrEqual(SECONDARY_CONTRAST);
  }
  expect(readTokens(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/, css))
    .toEqual(readTokens(/:root:not\(\[data-theme='light'\]\)\s*\{([^}]+)\}/, css));
});
it.each([['light', light], ['dark', dark]] as const)('meets contrast on the actual %s conversation bubbles', (theme, tokens) => {
  const css = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  const foreground = css.match(/\.message-bubble\s*\{[^}]*color:\s*var\((--[\w-]+)\)/)![1];
  for (const sender of ['user', 'agent']) {
    const rule = css.match(new RegExp(`\\.message-${sender} \\.message-bubble\\s*\\{([^}]+)\\}`))![1];
    const background = rule.match(/background:\s*var\((--[\w-]+)\)/)![1];
    expect(background).toBe('--bubble-' + sender);
    expect(readColour(tokens, background)).not.toBe(readColour(tokens, '--bg-0'));
    if (sender === 'agent') expect(rule).toContain('border: var(--border)');
    expect(calculateContrast(tokens, foreground, background), theme + ' ' + sender + ' bubble').toBeGreaterThanOrEqual(BODY_CONTRAST);
    for (const colour of ['--accent']) {
      expect(calculateContrast(tokens, colour, background), theme + ' ' + sender + ' ' + colour)
        .toBeGreaterThanOrEqual(BODY_CONTRAST);
    }
  }
});
it('uses defined tokens and keeps forbidden decoration and raw colours out of component rules', () => {
  const combined = styles.join('\n');
  const defined = new Set([...combined.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  for (const match of combined.matchAll(/var\((--[\w-]+)/g)) expect(defined.has(match[1]), match[1]).toBe(true);
  for (const css of styles) {
    const components = css.replace(/:root[^{}]*\{[^}]*\}/g, '');
    expect(components).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(|hsla?\(|:\s*(?:white|black)\b|\b(?:dashed|dotted)\b|1\.5px/);
    expect(components).not.toMatch(/font-weight:\s*(?!400\b|600\b)\d+|font-size:\s*(?:[0-9]|1[01])px/);
    expect(components).not.toMatch(/border(?:-(?:left|right|top|bottom))?(?:-width)?:\s*[2-9]px/);
  }
  expect(combined).not.toMatch(/accent-soft|--text-xs|radius-lg|letter-spacing|text-transform/);
  expect(shared).toContain('outline: 2px solid var(--focus)');
  expect(shared).toContain('@media (prefers-reduced-motion: reduce)');
});

it.each([['light', light], ['dark', dark]] as const)('preserves distinct secondary contrast levels in %s', (theme, tokens) => {
  const levels = ['--fg-2', '--fg-3', '--fg-4'].map(token => calculateContrast(tokens, token, '--bg-0'));
  expect(levels[0], theme).toBeGreaterThan(levels[1]);
  expect(levels[1], theme).toBeGreaterThan(levels[2]);
});
it('uses accessible input borders separately from decorative separators', () => {
  expect(shared).toContain('--border: 1px solid var(--line)');
  expect(shared).toContain('--input-border: 1px solid var(--input-line)');
  for (const selector of ['input:not', 'textarea {', 'select {']) {
    const rule = shared.split('\n').find(line => line.startsWith(selector))!;
    expect(rule).toContain('border: var(--input-border)');
  }
  const session = readFileSync('app/src/components/session-create.css', 'utf8');
  expect(session.split('\n').find(line => line.startsWith('.session-create input'))).toContain('border: var(--input-border)');
  expect(session.split('\n').find(line => line.startsWith('.session-target {'))).toContain('border: var(--input-border)');
  const conversation = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  expect(conversation.match(/\.composer-box\s*\{([^}]+)\}/)![1]).toContain('border: var(--input-border)');
  expect(conversation.match(/\.composer-box:focus-within\s*\{([^}]+)\}/)![1]).toContain('outline: 2px solid var(--focus)');
});

it.each([['light', light], ['dark', dark]] as const)('keeps disabled send button contrast in %s', (theme, tokens) => {
  const rule = shared.match(/\.btn-primary:disabled\s*\{([^}]+)\}/)![1];
  const foreground = rule.match(/color:\s*var\((--[\w-]+)\)/)![1];
  const background = rule.match(/background:\s*var\((--[\w-]+)\)/)![1];
  expect(foreground).toBe('--fg-4');
  expect(calculateContrast(tokens, foreground, background), theme).toBeGreaterThanOrEqual(SECONDARY_CONTRAST);
});

it('distinguishes disabled inputs and settled rows without dimming readable row text', () => {
  for (const selector of ['input', 'select', 'textarea']) {
    expect(shared.match(new RegExp(`${selector}:disabled\\s*\\{([^}]+)\\}`))![1]).toContain('opacity: .6');
  }
  const activity = readFileSync('app/src/components/activity.css', 'utf8');
  const inbox = readFileSync('app/src/pages/inbox/inbox.css', 'utf8');
  const conversation = readFileSync('app/src/pages/conversation/conversation.css', 'utf8');
  for (const [css, selector] of [
    [activity, '.activity-line.is-stopped > :not(.row-actions)'],
    [activity, '.activity-row.is-stopped > .cell'],
    [activity, '.activity-item.is-stopped > :not(.delegation-fold)'],
    [activity, '.delegation-line.is-stopped > .delegation-line-row'],
    [inbox, '.approval-row.sent'],
    [conversation, '.timeline-approval.is-settled .approval-request'],
  ]) {
    const rule = css.split('\n').find(line => line.startsWith(selector + ' {'))!;
    expect(rule).toContain('color: var(--fg-3)');
    expect(rule).not.toContain('opacity:');
  }
  expect(activity).not.toContain('.activity-row.is-stopped:hover > .cell');
  expect(activity).toContain('.is-stopped :is(.activity-name, .activity-excerpt, .agent-model, .cell-elapsed, .cell-changes) { color: var(--fg-3); }');
  expect(conversation).not.toMatch(/\.composer-(?:box textarea|controls select):disabled\s*\{[^}]*opacity:/);
});
