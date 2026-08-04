import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// ../objcts を @objcts として解決する。実体は basketball-sim の外にあるので
// server.fs.allow で親ディレクトリ配下の配信を許可している。
const objctsDir = fileURLToPath(new URL('../objcts', import.meta.url));
// ../objcts 配下のファイルは basketball-sim の node_modules を辿れないため、
// @babylonjs/core をここの node_modules に明示エイリアスして解決させる。
const babylonCore = fileURLToPath(new URL('./node_modules/@babylonjs/core', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['@babylonjs/core'],
    alias: {
      '@objcts': objctsDir,
      '@babylonjs/core': babylonCore,
    },
  },
  server: {
    // basketball-sim の外（= ../objcts）から .ts を直接 import するため許可する
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), objctsDir],
    },
  },
});
