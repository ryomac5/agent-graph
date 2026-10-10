import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const SOURCES = {
  claude: 'https://cdn.simpleicons.org/claude',
  openai: 'https://raw.githubusercontent.com/stablyai/orca/main/src/renderer/src/components/status-bar/icons.tsx',
};
const MAX_SOURCE_LENGTH = 1024 * 1024;
const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAaEe0-9+.,\s-]+$/;
const VIEW_BOX = /^\s*-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?[ ,]+\d+(?:\.\d+)?[ ,]+\d+(?:\.\d+)?\s*$/;

// ロゴに必要な形だけで組み直し、実行できる要素と属性と参照を持ち込まない。
export function sanitizeBrandSvg(source: string, color: string): string | undefined {
  if (source.length > MAX_SOURCE_LENGTH) return;
  const clean = source.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|foreignObject)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const svg = /<svg\b([^>]*)>([\s\S]*?)<\/svg\s*>/i.exec(clean);
  if (!svg) return;
  const viewBox = /\bviewBox\s*=\s*(["'])(.*?)\1/.exec(svg[1])?.[2];
  if (!viewBox || !VIEW_BOX.test(viewBox)) return;
  const paths = [...svg[2].matchAll(/<path\b([^>]*)\/?>/gi)].flatMap(match => {
    const d = /(?:^|\s)d\s*=\s*(["'])(.*?)\1/s.exec(match[1])?.[2];
    return d && PATH_DATA.test(d) ? [d] : [];
  });
  if (!paths.length) return;
  const fillRule = /\bfill(?:Rule|-rule)\s*=\s*["']evenodd["']/.test(svg[0]) ? ' fill-rule="evenodd"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="${color}"${fillRule}>${paths.map(d => `<path d="${d}"/>`).join('')}</svg>`;
}
export function extractOpenAIIcon(source: string): string | undefined {
  const start = /export\s+function\s+OpenAIIcon\b/.exec(source);
  if (!start) return;
  const body = source.slice(start.index).split(/\nexport\s/)[0];
  return sanitizeBrandSvg(body, 'currentColor');
}
export interface BrandSvgOptions { cacheHome?: string; fetchSvg?: (url: string) => Promise<string> }
export function createBrandSvgReader(options: BrandSvgOptions = {}) {
  const directory = resolve(options.cacheHome ?? process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache'), 'agent-graph/brand');
  const fetchSvg = options.fetchSvg ?? (async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('Logo unavailable');
    return response.text();
  });
  const pending = new Map<string, Promise<Buffer | undefined>>();
  async function load(name: keyof typeof SOURCES): Promise<Buffer | undefined> {
    const destination = resolve(directory, `${name}.svg`);
    const temporary = `${destination}.${randomBytes(8).toString('hex')}`;
    try {
      const color = name === 'claude' ? '#D97757' : 'currentColor';
      try {
        const cached = sanitizeBrandSvg(await readFile(destination, 'utf8'), color);
        if (cached) return Buffer.from(cached);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const source = await fetchSvg(SOURCES[name]);
      const svg = name === 'openai' ? extractOpenAIIcon(source) : sanitizeBrandSvg(source, color);
      if (!svg) return;
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, svg);
      await rename(temporary, destination);
      return Buffer.from(svg);
    } catch { return undefined; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return (name: string): Promise<Buffer | undefined> => {
    if (!Object.hasOwn(SOURCES, name)) return Promise.resolve(undefined);
    if (!pending.has(name)) pending.set(name, load(name as keyof typeof SOURCES).finally(() => pending.delete(name)));
    return pending.get(name)!;
  };
}
