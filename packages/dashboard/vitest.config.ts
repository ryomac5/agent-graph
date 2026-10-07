import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// app の package.json を境界にし、Vitest の保存先を共有依存から分ける。
export default defineConfig({
  root: new URL('./app/', import.meta.url).pathname,
  plugins: [react()],
  cacheDir: new URL('./app/node_modules/.vite', import.meta.url).pathname,
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
