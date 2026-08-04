// ../objcts から、このアプリのビルドに必要なぶんだけ vendor/objcts へ複製する。
//   node scripts/sync-objcts.mjs
//
// vendor/objcts はビルド用の複製。オーサリング（ボクセル/モーションの焼き込み）は
// 元の ../objcts 側で行い、終わったらこれを流して取り込む。
// ⚠️ 40MB ある player/player（.vox の元素材）と各 tools は複製しない。実行時に読まないため。
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const src = fileURLToPath(new URL("../../objcts", import.meta.url));
const dst = fileURLToPath(new URL("../vendor/objcts", import.meta.url));
if (!existsSync(src)) {
  console.error(`元の objcts が見つからない: ${src}`);
  process.exit(1);
}

// [複製元の相対パス, 取り込む拡張子]。ディレクトリは非再帰で拾う。
const PICK = [
  ["player", [".ts"]],
  ["player/voxel", [".ts"]],
  ["player/voxel/data", [".json"]],
  ["player/motion", [".ts"]],
  ["player/motion/data", [".json"]],
];

rmSync(dst, { recursive: true, force: true });
let files = 0, bytes = 0;
for (const [rel, exts] of PICK) {
  const from = `${src}/${rel}`, to = `${dst}/${rel}`;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (!exts.some((e) => name.endsWith(e))) continue;
    const f = `${from}/${name}`;
    if (statSync(f).isDirectory()) continue;
    cpSync(f, `${to}/${name}`);
    files++; bytes += statSync(f).size;
  }
}
console.log(`vendor/objcts へ ${files}ファイル / ${(bytes / 1048576).toFixed(2)}MB を複製`);
