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
function readTokens(selector: RegExp): Map<string, string> {
  const block = shared.match(selector)![1];
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}
it('matches both explicit and automatic dark palettes to the design document', () => {
  const light = readTokens(/:root\s*\{([^}]+)\}/);
  const dark = readTokens(/:root\[data-theme='dark'\]\s*\{([^}]+)\}/);
  const automatic = readTokens(/:root:not\(\[data-theme='light'\]\)\s*\{([^}]+)\}/);
  expect(dark).toEqual(automatic);
  const document = readFileSync('../../docs/agents/design-system.md', 'utf8');
  let checked = 0;
  for (const line of document.split('\n')) {
    const token = line.match(/^\| `(--[\w-]+)`/);
    const colours = [...line.matchAll(/`(#[\da-f]{6}|rgb\([^`]+\))`/g)].map(match => match[1]);
    if (!token || colours.length !== 2) continue;
    expect(light.get(token[1]), `${token[1]} light`).toBe(colours[0]);
    expect(dark.get(token[1]), `${token[1]} dark`).toBe(colours[1]);
    checked++;
  }
  expect(checked).toBe(23);
});
it('uses defined tokens and keeps forbidden decoration and raw colours out of component rules', () => {
  const combined = styles.join('\n');
  const defined = new Set([...combined.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
  for (const match of combined.matchAll(/var\((--[\w-]+)/g)) expect(defined.has(match[1]), match[1]).toBe(true);
  for (const css of styles) {
    const components = css.replace(/:root[^{}]*\{[^}]*\}/g, '');
    expect(components).not.toMatch(/#[\da-f]{3,8}\b|\b(?:dashed|dotted)\b|1\.5px/);
    expect(components).not.toMatch(/font-weight:\s*(?!400\b|600\b)\d+|font-size:\s*(?:[0-9]|1[01])px/);
    expect(components).not.toMatch(/border(?:-(?:left|right|top|bottom))?(?:-width)?:\s*[2-9]px/);
  }
  expect(combined).not.toMatch(/accent-soft|--text-xs|radius-lg|letter-spacing|text-transform/);
  expect(shared).toContain('outline: 2px solid var(--focus)');
  expect(shared).toContain('@media (prefers-reduced-motion: reduce)');
});
