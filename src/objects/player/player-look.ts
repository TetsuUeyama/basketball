// 選手の見た目（肌色・髪色・髪型）。番号(index)で表現し、playerdb の各選手が
// [skin, hairColor, style] として1人ずつ保持する。HUDの2D顔アイコン(ui.ts)と
// 3D選手の頭(player-visual.ts)で共有し、両者を一致させる。
// - resolveLook: 番号 → 色/髪型（PlayerLook）を解決。playerdb 由来の見た目はこれ。
// - lookIndicesFromName / playerLook: DB未登録の選手（初期ダミー等）向けに、名前
//   ハッシュから番号を導くフォールバック。playerdb への番号焼き込み生成にも使う。

// 見た目の番号4つ組: [肌index, 髪色index, 髪型index(2Dアイコン用), 髪型No(3D用)]
export type LookIdx = [number, number, number, number];

// style 0..12 は **HUDの2D顔アイコン専用**のカテゴリ:
//   0短髪 1丸刈り 2アフロ 3フラットトップ 4ヘッドバンド 5ロング(サイド長め)
//   6前髪上げ(生え際後退) 7モヒカン 8マンバン 9センター分け 10ロング(肩まで) 11くせ毛長髪 12ドレッド
// hairNo は **3Dの頭に載るボクセル髪型**の番号（hair.json の元番号 1..140 / 0 = 髪なし）。
// 138種を選手へ均等に配ってあるので、両者は必ずしも一致しない。
export type PlayerLook = {
  skinHex: string; hairHex: string;
  skin: { r: number; g: number; b: number }; hair: { r: number; g: number; b: number };
  style: number; hairNo: number;
};

// ロスタースロットごとの手続き的な顔の見た目 — HUDの顔アイコン（2Dキャンバス）と
// 3D選手の頭で共有し、コート上の選手がアイコンと一致するようにする。
const SKIN_HEX = ["#f7ddbe", "#f2cfa8", "#e6b48c", "#cf9a6a", "#b7824e", "#a9713f", "#8a5a2b", "#5e3a1e"];
const HAIR_HEX = ["#0e0e0e", "#20140a", "#3a2413", "#5a3a1c", "#7a5230", "#111820", "#4a4a4a", "#9a9a9a",
                  "#9a4a1e", "#c9a24b", "#e0c98a"];   // 黒〜茶〜白髪(グレー)〜赤毛〜金〜プラチナ
function hexRGB(h: string): { r: number; g: number; b: number } {
  const n = parseInt(h.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** 見た目の番号4つ組 → 色/髪型（PlayerLook）。playerdb 由来の見た目はこの経路。 */
export function resolveLook(idx: LookIdx): PlayerLook {
  const skinHex = SKIN_HEX[idx[0]] ?? SKIN_HEX[0];
  const hairHex = HAIR_HEX[idx[1]] ?? HAIR_HEX[0];
  return { skinHex, hairHex, skin: hexRGB(skinHex), hair: hexRGB(hairHex), style: idx[2], hairNo: idx[3] };
}

// ---------------------------------------------------------------------------
// 以下は DB未登録の選手向けフォールバック（名前ハッシュから番号を導く）。
// playerdb.ts への番号焼き込み（scripts/bake-look）にも同じロジックを使う。
// ---------------------------------------------------------------------------

// 文字列のFNV-1aハッシュ → 安定した32bitシード。見た目は選手の名前をキーにするので、
// 同じ選手は常に同じ見た目、別の選手は別の見た目になる（チーム/並び順に非依存）。
function hashName(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 有名選手向けに手選びした2Dアイコンの髪型。それ以外は名前ハッシュから決定的ランダムに
// 割り当てる。名は playerdb と完全一致が必要。3Dの髪型No(hairNo)には効かない。
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

// 2Dアイコンの髪型の相対頻度。ランダム（オーバーライドされない）選手の間で。大半は同じ(1.0)。
// “極端な”見た目は多くなりすぎないよう稀にする — 特にモヒカン。インデックス = 髪型番号。
//        0    1    2    3    4    5    6     7(モヒカン) 8(マンバン) 9    10   11(くせ毛) 12(ドレッド)
const STYLE_WEIGHT = [1, 1, 1, 1, 1, 1, 1, 0.15, 0.55, 1, 1, 0.8, 0.4];

// ハッシュからの決定的な重み付き抽選（Math.randomを使わず選手ごとに安定）。
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

// 選手ごとの髪の色オーバーライド(名前 → hex)。名は playerdb と完全一致させること。
const HAIR_COLOR_OVERRIDE: Record<string, string> = {
  "マルセロ": "#0e0e0e",                    // 黒髪のドレッド
  "クリスティアーノ・ロナウド": "#0e0e0e",  // 黒髪(金髪ではなく)
};

/** 名前ハッシュから見た目の番号4つ組を導く（DB未登録の選手 / playerdb 生成用）。 */
export function lookIndicesFromName(name: string): LookIdx {
  const h = hashName(name);
  const skin = h % SKIN_HEX.length;
  const ov = HAIR_COLOR_OVERRIDE[name];
  const hairIdx = ov ? HAIR_HEX.indexOf(ov) : (h >>> 3) % HAIR_HEX.length;   // 符号なしシフト
  const hair = hairIdx < 0 ? 0 : hairIdx;
  const style = HAIR_STYLE_OVERRIDE[name] ?? pickWeightedStyle(h);   // 有名選手 → 似合うもの / それ以外 → 重み付きランダム
  // 3Dの髪型No: 1..140 を名前から一様に。丸刈りのアイコンだけは3Dも髪なしに揃える。
  const hairNo = style === 1 ? 0 : 1 + ((h >>> 13) % 140);
  return [skin, hair, style, hairNo];
}

/** DB未登録の選手（初期ダミー等）向けフォールバック: 名前から見た目を導く。 */
export function playerLook(name: string): PlayerLook {
  return resolveLook(lookIndicesFromName(name));
}
