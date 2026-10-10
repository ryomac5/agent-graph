import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBrandReader } from '../src/static/index.ts';

async function fixture(t: TestContext) {
  const cacheHome = await mkdtemp(join(tmpdir(), 'ag-brand-'));
  t.after(() => rmSync(cacheHome, { recursive: true, force: true }));
  const source = join(cacheHome, 'electron.icns');
  await writeFile(source, 'local icon');
  const destination = join(cacheHome, 'agent-graph', 'brand');
  return { cacheHome, source, destination };
}
test('brands convert local sources once, share concurrent requests and reuse the disk cache after restart', async t => {
  const { cacheHome, source, destination } = await fixture(t);
  const converted: string[] = [];
  const convert = async (input: string, output: string) => { converted.push(input); await writeFile(output, 'png'); };
  const options = { cacheHome, sources: { claude: source, chatgpt: source }, convert };
  const read = createBrandReader(options);
  const values = await Promise.all([read('claude'), read('claude')]);
  assert.deepEqual(values.map(value => value?.toString()), ['png', 'png']);
  assert.equal((await read('claude'))?.toString(), 'png');
  assert.equal((await createBrandReader(options)('claude'))?.toString(), 'png');
  assert.equal(converted.length, 1);
  assert.equal((await readFile(join(destination, 'claude.png'))).toString(), 'png');
  assert.equal((await read('chatgpt'))?.toString(), 'png');
  assert.deepEqual(converted, [source, source]);
});
test('Antigravity fetches the favicon once and retains it when conversion must be retried', async t => {
  const { cacheHome } = await fixture(t);
  let fetched = 0; let converted = 0;
  const options = { cacheHome,
    fetchIcon: async (url: string) => { assert.equal(url, 'https://antigravity.google/favicon.ico'); fetched++; return Buffer.from('ico'); },
    convert: async (source: string, output: string) => { converted++; assert.equal((await readFile(source)).toString(), 'ico'); if (converted === 1) throw new Error('sips failed'); await writeFile(output, 'png'); },
  };
  assert.equal(await createBrandReader(options)('antigravity'), undefined);
  assert.equal((await createBrandReader(options)('antigravity'))?.toString(), 'png');
  assert.equal((await createBrandReader(options)('antigravity'))?.toString(), 'png');
  assert.equal(fetched, 1); assert.equal(converted, 2);
});
test('missing sources, conversion and download failures and unknown brands are unavailable', async t => {
  const { cacheHome, source } = await fixture(t);
  let converted = 0;
  const read = createBrandReader({ cacheHome, sources: { claude: join(cacheHome, 'absent'), chatgpt: source },
    convert: async () => { converted++; throw new Error('sips failed'); }, fetchIcon: async () => { throw new Error('offline'); } });
  assert.equal(await read('claude'), undefined); assert.equal(converted, 0);
  assert.equal(await read('chatgpt'), undefined); assert.equal(converted, 1);
  assert.equal(await read('antigravity'), undefined);
  for (const name of ['unknown', '../claude', 'toString']) assert.equal(await read(name), undefined);
});
test('default cache location follows XDG_CACHE_HOME', async t => {
  const { cacheHome, destination } = await fixture(t);
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cacheHome;
  t.after(() => { if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous; });
  await mkdir(destination, { recursive: true }); await writeFile(join(destination, 'claude.png'), 'cached');
  assert.equal((await createBrandReader()('claude'))?.toString(), 'cached');
});
