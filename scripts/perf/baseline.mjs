import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch, cpus } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PERF = join(ROOT, '.perf');
export const REPEATS = 5;
export function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: values.length, median, min: sorted[0], max: sorted.at(-1), samples: values };
}
export function measure(action, n = REPEATS) {
  const times = [];
  let value;
  for (let i = 0; i < n; i++) { const start = performance.now(); value = action(); times.push(performance.now() - start); }
  return { ...summarize(times), value };
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function build() {
  const start = performance.now();
  // 出力だけを隔離し、本番が配信する dist は触らない。
  let result = spawnSync('npx', ['--yes', 'pnpm@10', '--filter', '@agent-graph/dashboard', 'build:app', '--outDir', resolve(PERF, 'build')], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
  writeFileSync(join(PERF, 'build.log'), result.stdout + result.stderr);
  let command = 'npx --yes pnpm@10 --filter @agent-graph/dashboard build:app';
  if (result.status !== 0) {
    // pnpm の取得が拒否された環境では、同じ build:app の既存 Vite を直接実行する。
    const require = createRequire(join(ROOT, 'packages/dashboard/package.json'));
    const vite = join(require.resolve('vite/package.json'), '../bin/vite.js');
    result = spawnSync(process.execPath, [vite, 'build', '--configLoader', 'native', '--outDir', resolve(PERF, 'build')], { cwd: join(ROOT, 'packages/dashboard'), encoding: 'utf8' });
    writeFileSync(join(PERF, 'build-fallback.log'), result.stdout + result.stderr);
    command = '既存の Vite で build:app と同じ引数を直接実行';
  }
  if (result.status !== 0) throw new Error(`build failed: ${result.stderr.slice(-1000)}`);
  const assets = files(join(PERF, 'build')).map(path => ({ path: path.slice(PERF.length + 1), bytes: statSync(path).size, gzipBytes: gzipSync(readFileSync(path)).length }));
  const total = extension => assets.filter(a => !extension || a.path.endsWith(extension)).reduce((sum, a) => sum + a.bytes, 0);
  return { n: 1, command, msIncludingLauncher: performance.now() - start, totalBytes: total(), jsBytes: total('.js'), cssBytes: total('.css'), assets };
}
function tests() {
  const runs = [];
  for (let i = 0; i < REPEATS; i++) {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=worker の大量取り込み中も主スレッド', 'packages/api/test/observe-perf.test.ts'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const output = result.stdout + result.stderr;
    writeFileSync(join(PERF, `observe-test-${i + 1}.tap`), output);
    runs.push({ run: i + 1, exitCode: result.status, lagMs: Number(/maximum event-loop delay: ([\d.]+)/.exec(output)?.[1] ?? NaN), feedMs: Number(/maximum projection feed refresh: ([\d.]+)/.exec(output)?.[1] ?? NaN), error: result.error?.message });
  }
  return { runs, lag: summarize(runs.map(r => r.lagMs)), feed: summarize(runs.map(r => r.feedMs)) };
}
function child(name) {
  const result = spawnSync(process.execPath, [`scripts/perf/${name}.mjs`], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  writeFileSync(join(PERF, `${name}.log`), result.stderr);
  if (result.status !== 0) throw new Error(`${name}: ${result.stderr.slice(-1500)}`);
  writeFileSync(join(PERF, `${name}.json`), result.stdout);
  return JSON.parse(result.stdout);
}
async function main() {
  mkdirSync(PERF, { recursive: true });
  const selected = process.argv.find(a => a.startsWith('--only='))?.slice(7)?.split(',');
  const results = { environment: { timestamp: new Date().toISOString(), node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), repeats: REPEATS } };
  const stages = { build, tests, ledger: () => child('ledger'), observation: () => child('observation'), live: () => child('browser') };
  for (const [name, action] of Object.entries(stages)) {
    if (selected && !selected.includes(name)) continue;
    process.stderr.write(`Measuring ${name}\n`);
    try { results[name] = await action(); }
    catch (error) { results[name] = { unavailable: error.message }; }
  }
  writeFileSync(join(PERF, 'baseline.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  if (Object.values(results).some(r => r.unavailable) || results.tests?.runs.some(r => r.exitCode !== 0)
    || results.live?.dashboard?.unavailable || results.live?.processIdle?.unavailable) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
