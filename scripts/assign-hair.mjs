// identity.ts の look に髪型No（hair.json の元番号 1..140）を割り当て直す。
//   node scripts/assign-hair.mjs
//
// 規則:
//   - 現 style が 1（丸刈り）の選手は髪なし = 0。髪型ではないので均等配分の対象外。
//   - それ以外の全員へ、138種（1..140 のうち 18/80 は欠番）を id 順のラウンドロビンで
//     均等配分する。1種あたり 26〜27人。
//   - look が既に4要素でも作り直す（何度実行しても同じ結果）。
// 個別に変えたいときはこのスクリプトを使わず identity.ts の4つ目の数字を直接書き換える。
// ⚠️ このスクリプトは全員を配分し直すので、手で指定した髪型No は消える。指定のある選手は
//    player-look.ts の HAIR_NO_OVERRIDE / SKIN_OVERRIDE を見て入れ直すこと。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const idPath = fileURLToPath(new URL("../src/data/player-data/identity.ts", import.meta.url));
const hairPath = fileURLToPath(new URL("../../objcts/player/voxel/data/hair.json", import.meta.url));

const NUMS = JSON.parse(readFileSync(hairPath, "utf8")).styles.map((s) => s.n).sort((a, b) => a - b);
const src = readFileSync(idPath, "utf8");

// 行末の look タプル: [skin,hair,style] または [skin,hair,style,hairNo]
const RE = /\[(\d+),(\d+),(\d+)(?:,(\d+))?\]\]/g;
let i = 0;
const count = new Map();
const out = src.replace(RE, (_m, skin, hair, style, _old) => {
  const no = Number(style) === 1 ? 0 : NUMS[i++ % NUMS.length];
  count.set(no, (count.get(no) ?? 0) + 1);
  return `[${skin},${hair},${style},${no}]]`;
});
writeFileSync(idPath, out);

const hairy = [...count].filter(([n]) => n > 0).map(([, c]) => c);
console.log(`書き換え ${[...count.values()].reduce((a, b) => a + b, 0)}人`);
console.log(`髪なし(丸刈り) ${count.get(0) ?? 0}人 / 髪あり ${i}人 を ${NUMS.length}種へ配分`);
console.log(`1種あたり ${Math.min(...hairy)}〜${Math.max(...hairy)}人 (使われた種類 ${hairy.length})`);
