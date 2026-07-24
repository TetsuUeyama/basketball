import { Vector3 } from "@babylonjs/core";

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const chance = (p: number) => Math.random() < p;

/** 2点間の水平（XZ平面）距離。 */
export function dist2D(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

export function dist2DTo(a: Vector3, x: number, z: number): number {
  return Math.hypot(a.x - x, a.z - z);
}

/** `cur` を `(tx,tz)` へ、XZ平面上で最大 `maxStep` だけ動かす。cur を変更する。 */
export function moveToward2D(cur: Vector3, tx: number, tz: number, maxStep: number): void {
  const dx = tx - cur.x;
  const dz = tz - cur.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxStep || d === 0) {
    cur.x = tx;
    cur.z = tz;
    return;
  }
  cur.x += (dx / d) * maxStep;
  cur.z += (dz / d) * maxStep;
}

// ロスタースロットごとの手続き的な顔の見た目 — HUDの顔アイコン（2Dキャンバス）と
// 3D選手の頭で共有し、コート上の選手がアイコンと一致するようにする。ロスターインデックス
// をシードにするため決定的で、両者で同一になる。
const SKIN_HEX = ["#f7ddbe", "#f2cfa8", "#e6b48c", "#cf9a6a", "#b7824e", "#a9713f", "#8a5a2b", "#5e3a1e"];
const HAIR_HEX = ["#0e0e0e", "#20140a", "#3a2413", "#5a3a1c", "#7a5230", "#111820", "#4a4a4a", "#9a9a9a",
                  "#9a4a1e", "#c9a24b", "#e0c98a"];   // 黒〜茶〜白髪(グレー)〜赤毛〜金〜プラチナ
function hexRGB(h: string): { r: number; g: number; b: number } {
  const n = parseInt(h.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
// hairStyle 0..4: 0=短髪 1=坊主(bald) 2=アフロ 3=フラットトップ(背高) 4=ヘッドバンド
export type PlayerLook = {
  skinHex: string; hairHex: string;
  skin: { r: number; g: number; b: number }; hair: { r: number; g: number; b: number };
  style: number;
};
// 文字列のFNV-1aハッシュ → 安定した32bitシード。見た目は選手のロスタースロットではなく
// 選手の名前（その選手のデータ）をキーにする — そのため同じ選手は常に同じ見た目になり、
// 別の選手は別の見た目になる。チームやラインナップの並び順に依存しない。
function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 有名選手向けに手選びした髪型（実際の見た目におおむね合わせる）。それ以外は
// 名前ハッシュから決定的ランダムな髪型を割り当てる。
// Style key: 0短髪 1丸刈り 2アフロ 3フラットトップ 4ヘッドバンド 5ロング(サイド長め)
//            6前髪上げ(生え際後退) 7モヒカン 8マンバン 9センター分け(前髪おろし) 10ロング(肩まで)
//            11くせ毛長髪 12ドレッド。名は playerdb と完全一致が必要。
const HAIR_STYLE_OVERRIDE: Record<string, number> = {
  "メッシ": 11,     // くせ毛長髪
  "マルセロ": 12,   // ドレッド(黒髪は下の HAIR_COLOR_OVERRIDE で固定)
  "ドレンテ": 12,   // ドレッド
  "ムンタリ": 12,   // ドレッド
  "タイウォ": 12,   // ドレッド
  "クリスティアーノ・ロナウド": 0,
  "カカ": 0,
  "トッティ": 0,
  "ビジャ": 0,
  "アグエロ": 0,
  "デル・ピエーロ": 0,
  "ファン・ベルシー": 0,
  "イグアイン": 0,
  "ロベルト・カルロス": 1,
  "ジェラード": 1,
  "ランパード": 1,
  "エトー": 1,
  "ドログバ": 1,
  "アンリ": 1,
  "シャビ": 1,
  "シルバ": 1,
  "スナイデル": 1,
  "セスク": 0,
  "ルーニー": 6,
  "イニエスタ": 6,
  "テベス": 5,
  "フォルラン": 5,
  "ロナウジーニョ": 8,
  "イブラヒモヴィッチ": 8,
  "バロテッリ": 7,
};

// ランダム（オーバーライドされない）選手の間での各髪型の相対頻度。
// 大半は同じ(1.0)。“極端な”見た目は多くなりすぎないよう稀にする —
// 特にモヒカン(多くの選手に付きすぎていた)。インデックス = 髪型番号。
//        0    1    2    3    4    5    6     7(モヒカン) 8(マンバン) 9    10   11(くせ毛) 12(ドレッド)
const STYLE_WEIGHT = [1, 1, 1, 1, 1, 1, 1, 0.15, 0.55, 1, 1, 0.8, 0.4];

// ハッシュからの決定的な重み付き抽選（Math.randomを使うweightedPickと違い、選手ごとに
// 安定）。ハッシュを[0,total)へ写し、累積和をたどる。
function pickWeightedStyle(h: number): number {
  let total = 0;
  for (const w of STYLE_WEIGHT) total += w;
  let r = ((h >>> 8) % 100000) / 100000 * total;
  for (let i = 0; i < STYLE_WEIGHT.length; i++) {
    r -= STYLE_WEIGHT[i];
    if (r < 0) return i;
  }
  return STYLE_WEIGHT.length - 1;
}

// 選手ごとの髪の色オーバーライド(名前 → hex)。それ以外は名前ハッシュから色を導出する。
// 名前は playerdb と完全一致させること。
const HAIR_COLOR_OVERRIDE: Record<string, string> = {
  "マルセロ": "#0e0e0e",                    // 黒髪のドレッド
  "クリスティアーノ・ロナウド": "#0e0e0e",  // 黒髪(金髪ではなく)
};

export function playerLook(name: string): PlayerLook {
  const h = hashName(name);
  const skinHex = SKIN_HEX[h % SKIN_HEX.length];
  const hairHex = HAIR_COLOR_OVERRIDE[name] ?? HAIR_HEX[(h >>> 3) % HAIR_HEX.length];   // 符号なしシフト(>>だと負になり得る → undefined)
  const style = HAIR_STYLE_OVERRIDE[name] ?? pickWeightedStyle(h);   // 有名選手 → 似合うもの / それ以外 → 重み付きランダム
  return { skinHex, hairHex, skin: hexRGB(skinHex), hair: hexRGB(hairHex), style };
}

/** 重みリスト(すべて >= 0)から重み付きランダムなインデックスを選ぶ。 */
export function weightedPick(weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}
