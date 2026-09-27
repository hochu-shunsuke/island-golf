import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: true,
    // 手元では、部屋の中継（npm run relay、wrangler dev）へ /ws を取り次ぐ。本番と同じく同じ場所の /ws につなげばよい。
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
  build: { target: 'es2022' },
});
