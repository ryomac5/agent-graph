import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = process.env.AGENT_GRAPH_API_URL ?? 'http://127.0.0.1:7422';
export default defineConfig({
  root: new URL('./app', import.meta.url).pathname,
  plugins: [react(), {
    name: 'ignore-build-output',
    apply: 'build',
    generateBundle() {
      // 出力先を保ったまま、生成物をソースの差分から除く。
      this.emitFile({ type: 'asset', fileName: '.gitignore', source: '*\n' });
    },
  }, {
    name: 'report-and-compress-assets',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(item => item.type === 'chunk');
      this.emitFile({ type: 'asset', fileName: '.vite/bundle-analysis.json', source: JSON.stringify(chunks.map(chunk => ({
        file: chunk.fileName, entry: chunk.isEntry, imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        modules: Object.entries(chunk.modules).map(([id, module]) => ({ id, bytes: module.renderedLength })),
      })), null, 2) });
    },
    async writeBundle(options, bundle) {
      // Vite が参照先を確定して書き出した内容を圧縮する。
      for (const item of Object.values(bundle)) {
        if (!/\.(?:js|css|svg|json)$/.test(item.fileName) || item.fileName.startsWith('.vite/')) continue;
        const path = resolve(options.dir!, item.fileName);
        const source = await readFile(path);
        for (const [extension, compress] of [['br', brotliCompressSync], ['gz', gzipSync]] as const) {
          await writeFile(`${path}.${extension}`, compress(source));
        }
      }
    },
  }],
  cacheDir: new URL('./app/node_modules/.vite', import.meta.url).pathname,
  build: { outDir: '../dist', emptyOutDir: true, manifest: true },
  server: { host: '127.0.0.1', proxy: {
    '/ws': { target, ws: true, changeOrigin: true, rewriteWsOrigin: true },
    '/snapshot': { target, changeOrigin: true },
    '/conversation': { target, changeOrigin: true },
    '/projection': { target, changeOrigin: true },
    '/api/search': { target, changeOrigin: true },
  } },
});
