// 指定選手の見た目（肌色・髪色・2Dアイコンの髪型・3Dの髪型No）と、3Dで実際に載る髪型を確認。
import "./stubs";
import { PLAYER_DB } from "../src/data/player-data";
import { resolveLook, lookIndicesFromName } from "../src/objects/player/player-look";
import { voxHairIndex } from "../src/objects/player/player-voxel";
import { hairStyles } from "@objcts/player/voxel/voxelBody";

const STYLE_2D = ["短髪", "丸刈り", "アフロ", "フラットトップ", "ヘッドバンド", "ロング(サイド長め)",
  "前髪上げ", "モヒカン", "マンバン", "センター分け", "ロング(肩まで)", "くせ毛長髪", "ドレッド"];
const names = hairStyles();

for (const target of ["ドログバ", "エトー", "アンリ"]) {
  const p = PLAYER_DB.find((q) => q[0] === target);
  if (!p) { console.log(`${target}: DBに無し`); continue; }
  const idx = p[7] as [number, number, number, number];
  const L = resolveLook(idx);
  const vs = voxHairIndex(L.hairNo);
  console.log(`${target}  DBのlook=[${idx}]`);
  console.log(`   肌 ${L.skinHex} / 髪色 ${L.hairHex} / 2Dアイコン ${STYLE_2D[L.style]}(${L.style})`
    + ` / 3D髪型No ${L.hairNo} → ${vs >= 0 ? `${names[vs]} (index ${vs})` : "髪なし"}`);
  // 再生成(bake-look)を流したときに同じ見た目へ戻るか
  const re = lookIndicesFromName(target);
  console.log(`   bake-look 再生成での値=[${re}] ${re.join() === idx.join() ? "→ 一致" : "→ ⚠️ ズレる"}`);
}
