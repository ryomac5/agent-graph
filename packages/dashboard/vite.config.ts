import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  }],
  cacheDir: new URL('./app/node_modules/.vite', import.meta.url).pathname,
  build: { outDir: '../dist', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: {
    '/ws': { target, ws: true, changeOrigin: true, rewriteWsOrigin: true },
    '/snapshot': { target, changeOrigin: true },
    '/conversation': { target, changeOrigin: true },
    '/projection': { target, changeOrigin: true },
    '/api/search': { target, changeOrigin: true },
  } },
});
