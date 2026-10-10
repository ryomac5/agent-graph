import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrandSvgReader, extractOpenAIIcon, sanitizeBrandSvg } from '../src/static/brand-svg.ts';
const SVG = '<svg viewBox="0 0 24 24"><path d="M0 0L1 1Z"/></svg>';
const SOURCE = `export function OpenAIIcon({size = 14}) { return (${SVG.replace('<svg ', '<svg fillRule="evenodd" ')}); }\nexport function Other() { return <svg viewBox="0 0 1 1"><path d="M9 9Z"/></svg>; }`;
test('OpenAI extraction retains only its shape, viewBox and fill rule', () => {
  const svg = extractOpenAIIcon(SOURCE)!;
  assert.match(svg, /viewBox="0 0 24 24"/); assert.match(svg, /currentColor/); assert.match(svg, /fill-rule="evenodd"/);
  assert.match(svg, /M0 0L1 1Z/); assert.doesNotMatch(svg, /M9 9/);
  for (const source of ['export function Other() {}', 'export function OpenAIIcon() {}\nexport function Other() { return ' + SVG + '; }', 'export function OpenAIIcon() { return <svg/>; }']) assert.equal(extractOpenAIIcon(source), undefined);
});
test('SVG reconstruction removes scripts, events, styles and external references', () => {
  const svg = sanitizeBrandSvg('<svg viewBox="0 0 24 24" onload="bad()"><script><path d="M9 9Z"/>bad()</script><style>bad</style><use href="https://bad"/><foreignObject><path d="M8 8Z"/></foreignObject><path d="M0 0Z" onclick="bad()" fill="url(https://bad)" href="https://bad"/></svg>', '#D97757')!;
  assert.match(svg, /#D97757/); assert.doesNotMatch(svg, /script|onload|onclick|https:\/\/bad|style|foreignObject|M9|M8/);
});
test('first requests share a download and store sanitized SVG under XDG cache; restart reuses cache', async t => {
  const cacheHome = await mkdtemp(join(tmpdir(), 'ag-svg-')); t.after(() => rmSync(cacheHome, { recursive: true, force: true }));
  const previous = process.env.XDG_CACHE_HOME; process.env.XDG_CACHE_HOME = cacheHome;
  t.after(() => { if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous; });
  const calls: string[] = [];
  const fetchSvg = async (url: string) => { calls.push(url); return url.includes('orca') ? SOURCE : SVG; };
  const reader = createBrandSvgReader({ fetchSvg });
  const results = await Promise.all([reader('openai'), reader('openai')]); assert.deepEqual(results[0], results[1]); assert.equal(calls.length, 1);
  assert.equal((await readFile(join(cacheHome, 'agent-graph/brand/openai.svg'))).toString(), results[0]!.toString());
  assert.equal((await createBrandSvgReader({ fetchSvg })('openai'))!.toString(), results[0]!.toString()); assert.equal(calls.length, 1);
  assert.match((await reader('claude'))!.toString(), /#D97757/);
  assert.deepEqual(calls, ['https://raw.githubusercontent.com/stablyai/orca/main/src/renderer/src/components/status-bar/icons.tsx', 'https://cdn.simpleicons.org/claude']);
});
test('failed download and invalid extraction are unavailable', async t => {
  const cacheHome = await mkdtemp(join(tmpdir(), 'ag-svg-fail-')); t.after(() => rmSync(cacheHome, { recursive: true, force: true }));
  assert.equal(await createBrandSvgReader({ cacheHome, fetchSvg: async () => { throw new Error('offline'); } })('openai'), undefined);
  assert.equal(await createBrandSvgReader({ cacheHome, fetchSvg: async () => 'invalid' })('openai'), undefined);
});
