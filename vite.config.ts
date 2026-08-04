import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// @objcts はリポジトリ内の複製 vendor/objcts を指す（`node scripts/sync-objcts.mjs` で
// ../objcts から取り込む）。リポジトリ単体でビルドできるようにするため、外は参照しない。
const objctsDir = fileURLToPath(new URL('./vendor/objcts', import.meta.url));
// vendor 配下から見ても同じ実体になるよう、@babylonjs/core を明示エイリアスする
// （二重ロードすると instanceof が壊れる）。
const babylonCore = fileURLToPath(new URL('./node_modules/@babylonjs/core', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['@babylonjs/core'],
    alias: {
      '@objcts': objctsDir,
      '@babylonjs/core': babylonCore,
    },
  },
});
