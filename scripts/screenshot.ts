// ダッシュボードの画面を 1440x900 で撮る。
// 使い方: node scripts/screenshot.ts --url <url> --out <png> --target overview|project|detail [--repo <key>]
// project と detail は Overview の orb をクリックして開く。detail は会話(rounds)を持つノードを選ぶ。
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
const getOpt = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const url = get("--url");
const out = get("--out");
const target = get("--target");
const repo = getOpt("--repo");
if (!["overview", "project", "detail"].includes(target)) throw new Error(`unknown target: ${target}`);

// playwright のインストール先を npm exec で特定し、createRequire で import する。
const bin = execFileSync("npm", ["exec", "--yes", "--package=playwright@1", "--", "which", "playwright"], { encoding: "utf8" }).trim();
const nodeModules = dirname(dirname(bin));
const script = `
import { createRequire } from 'node:module';
const require = createRequire(process.argv[6]);
const { chromium } = require('playwright');
const [url, out, target, repo] = process.argv.slice(2);
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
  // 会話(rounds)を持つノードの ID を API から特定して選ぶ。root は turns が無いことが多く
  // 「No messages」になるため、rounds を持つ delegation/subagent を優先する。
  let wanted = null;
  if (repo) {
    const view = await page.evaluate(async (u) => {
      const res = await fetch(u);
      const text = await res.text();
      try { return JSON.parse(text); }
      catch { throw new Error('api/project returned non-JSON: status=' + res.status + ' body=' + text.slice(0, 300)); }
    }, url + 'api/project?repo=' + encodeURIComponent(repo));
    outer: for (const s of view.sessions || []) {
      for (const n of s.nodes || []) {
        if (Array.isArray(n.rounds) && n.rounds.length) { wanted = n.id; break outer; }
      }
    }
  }
  const target = wanted
    ? page.locator('.graph-holder .node[data-node="' + wanted + '"]')
    : page.locator('.graph-holder .node:not(.root)').first();
  if (await target.count()) {
    await target.click({ force: true });
    await page.waitForTimeout(600);
  }
  // 詳細パネルに会話が描画されたかを検証する。「No messages」だけでは失敗。
  const bubbles = page.locator('#detail .chat .bubble').count();
  if (!(await bubbles)) {
    const html = await page.locator('#detail').innerHTML();
    throw new Error('detail: no chat bubble rendered after selecting node. #detail=' + html.slice(0, 500));
  }
}
await page.screenshot({ path: out, fullPage: false });
await browser.close();
`;
const scriptPath = join(dirname(out), `.shot-${target}-${process.pid}.mjs`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(scriptPath, script);
const base = join(nodeModules, "playwright", "package.json");
const run = () => execFileSync("node", [scriptPath, url, out, target, repo ?? "", base], { stdio: "inherit", env: { ...process.env } });
try {
  run();
} catch {
  // chromium が無ければ入れてから撮る。
  execFileSync("npx", ["--yes", "playwright@1", "install", "chromium"], { stdio: "inherit" });
  run();
} finally {
  rmSync(scriptPath, { force: true });
}
