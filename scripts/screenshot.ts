// ダッシュボードの画面を 1440x900 で撮る。
// 使い方: node scripts/screenshot.ts --url <url> --out <png> --target overview|project|detail
// project と detail は Overview の orb をクリックして開く。detail はさらに最初のノードを選ぶ。
// playwright は依存に足さない。npm exec で都度解決する。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const get = (name: string): string => {
  const index = args.indexOf(name);
  if (index === -1) throw new Error(`missing --${name}`);
  return args[index + 1];
};

const url = get("--url");
const out = get("--out");
const target = get("--target");
if (!["overview", "project", "detail"].includes(target)) throw new Error(`unknown target: ${target}`);

// playwright のインストール先を npm exec で特定し、createRequire で import する。
const bin = execFileSync("npm", ["exec", "--yes", "--package=playwright@1", "--", "which", "playwright"], { encoding: "utf8" }).trim();
const nodeModules = dirname(dirname(bin));
const script = `
import { createRequire } from 'node:module';
const require = createRequire(process.argv[5]);
const { chromium } = require('playwright');
const [url, out, target] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
if (target === 'project' || target === 'detail') {
  // Overview の orb をクリックしてプロジェクトを開く。
  await page.waitForSelector('.overview .orb', { timeout: 15000 });
  await page.locator('.overview .orb').first().click({ force: true });
  await page.waitForSelector('svg.graph', { timeout: 15000 });
}
if (target === 'detail') {
  const node = page.locator('.graph-holder .node').first();
  if (await node.count()) {
    await node.click({ force: true });
    await page.waitForTimeout(600);
  }
}
await page.screenshot({ path: out, fullPage: false });
await browser.close();
`;
const scriptPath = join(dirname(out), `.shot-${target}-${process.pid}.mjs`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(scriptPath, script);
const base = join(nodeModules, "playwright", "package.json");
const run = () => execFileSync("node", [scriptPath, url, out, target, base], { stdio: "inherit", env: { ...process.env } });
try {
  run();
} catch {
  // chromium が無ければ入れてから撮る。
  execFileSync("npx", ["--yes", "playwright@1", "install", "chromium"], { stdio: "inherit" });
  run();
} finally {
  rmSync(scriptPath, { force: true });
}
