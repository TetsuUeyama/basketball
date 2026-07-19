// Per-CLUB uniforms: each real club's HOME and AWAY kit, coloured from its
// actual team colours (identified by club name + league). Four parts each:
// top (上半身) / bottom (下半身/shorts) / sleeve (そで+上腕) / shoes (シューズ).
// Keyed by the exact club name in clubdb; uniformOf() falls back to the
// team-slot default (BLAZE/WAVE) for a random, non-club roster.
import type { Uniform, RGB } from "./config";

const x = (h: string): RGB => ({
  r: parseInt(h.slice(0, 2), 16) / 255,
  g: parseInt(h.slice(2, 4), 16) / 255,
  b: parseInt(h.slice(4, 6), 16) / 255,
});
// kit(top, bottom, sleeve, shoes) — all hex "rrggbb"
const k = (t: string, b: string, s: string, sh: string): Uniform =>
  ({ top: x(t), bottom: x(b), sleeve: x(s), shoes: x(sh) });

const W = "f2f2f2", K = "1a1a1a";   // default home shoe (white) / away shoe (dark)

export const CLUB_KITS: Record<string, [Uniform, Uniform]> = {
  // ===== England =====
  "アーセナル":        [k("e01414", "ffffff", "ffffff", W), k("f4e04a", "12213f", "12213f", K)],
  "エヴァートン":      [k("11317a", "ffffff", "11317a", W), k("f0e14a", "1a1a1a", "f0e14a", K)],
  "マンチェスター・C": [k("6cabdd", "ffffff", "6cabdd", W), k("14202e", "14202e", "14202e", K)],
  "マンチェスター・U": [k("d81920", "ffffff", "d81920", K), k("101014", "101014", "101014", K)],
  "チェルシー":        [k("1d3aa8", "1d3aa8", "1d3aa8", W), k("e8e400", "12142a", "e8e400", K)],
  "トットナム":        [k("ffffff", "12213f", "ffffff", W), k("12213f", "12213f", "12213f", K)],
  "ニューカッスル":    [k("222222", "1a1a1a", "eeeeee", W), k("3a4a8c", "3a4a8c", "3a4a8c", K)],
  "リヴァプール":      [k("d00420", "d00420", "d00420", W), k("2a2a30", "d8d800", "2a2a30", K)],
  "フルハム":          [k("ffffff", "1a1a1a", "1a1a1a", K), k("c81028", "1a1a1a", "c81028", K)],
  "バーミンガム・シティ": [k("1035a0", "ffffff", "1035a0", W), k("f0f0f0", "1035a0", "f0f0f0", K)],
  "ブラックバーン":    [k("2452a8", "ffffff", "ffffff", W), k("1a1a1a", "1a1a1a", "1a1a1a", K)],
  "ボルトン":          [k("ffffff", "12213f", "ffffff", W), k("d01028", "12213f", "d01028", K)],
  "ウェストブロムウィッチ": [k("133a86", "133a86", "ffffff", W), k("f0e030", "1a1a1a", "f0e030", K)],
  "ストーク・シティ":  [k("d21c2a", "ffffff", "ffffff", W), k("1a1a1a", "1a1a1a", "1a1a1a", K)],
  "アストン・ヴィラ":  [k("7a1030", "6cabdd", "6cabdd", W), k("cfe6ff", "7a1030", "cfe6ff", K)],
  "ウィガン":          [k("2a86d8", "ffffff", "ffffff", W), k("1a1a1a", "1a1a1a", "1a1a1a", K)],
  "ウォルバーハンプトン": [k("f6a021", "1a1a1a", "f6a021", K), k("2a2a2a", "2a2a2a", "2a2a2a", K)],
  "ブラックプール":    [k("f37a1a", "ffffff", "f37a1a", W), k("ffffff", "f37a1a", "ffffff", K)],
  "サンダーランド":    [k("d21024", "d21024", "ffffff", W), k("1a1a1a", "1a1a1a", "1a1a1a", K)],
  "ウエスト・ハム・U": [k("7a1030", "12213f", "6cabdd", W), k("6cabdd", "12213f", "6cabdd", K)],

  // ===== Italy =====
  "インテル":          [k("1a1f6e", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a1f6e", "f2f2f2", K)],
  "ACミラン":          [k("bd1220", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a1a1a", "f2f2f2", K)],
  "ASローマ":          [k("8a1a2a", "8a1a2a", "e8a020", W), k("f2e6c8", "8a1a2a", "f2e6c8", K)],
  "ナポリ":            [k("21a0e0", "ffffff", "21a0e0", W), k("12213f", "12213f", "12213f", K)],
  "フィオレンティーナ": [k("7a3ca8", "7a3ca8", "7a3ca8", W), k("ffffff", "7a3ca8", "ffffff", K)],
  "ユベントス":        [k("2a2a2a", "ffffff", "eeeeee", W), k("f0e84a", "12213f", "f0e84a", K)],
  "ウディネーゼ":      [k("2a2a2a", "1a1a1a", "eeeeee", W), k("d01824", "1a1a1a", "d01824", K)],
  "ラツィオ":          [k("8fd0ee", "ffffff", "8fd0ee", W), k("12213f", "12213f", "12213f", K)],
  "ボローニャ":        [k("a01828", "12213f", "a01828", W), k("f2f2f2", "a01828", "f2f2f2", K)],
  "ジェノア":          [k("b01828", "12213f", "12213f", W), k("f2f2f2", "12213f", "f2f2f2", K)],
  "パレルモ":          [k("f2a6c8", "1a1a1a", "f2a6c8", K), k("1a1a1a", "f2a6c8", "1a1a1a", K)],
  "インテルナシオナル": [k("c81828", "ffffff", "c81828", W), k("f2f2f2", "c81828", "f2f2f2", K)],
  "バーリ":            [k("d21a2a", "ffffff", "d21a2a", W), k("1a1a1a", "d21a2a", "1a1a1a", K)],
  "サンプドリア":      [k("1a4ba0", "ffffff", "1a4ba0", W), k("ffffff", "1a4ba0", "1a4ba0", K)],
  "カリアリ":          [k("8a1830", "12213f", "12213f", W), k("f2f2f2", "8a1830", "f2f2f2", K)],
  "カターニャ":        [k("1a1a1a", "1a1a1a", "6cabdd", W), k("f2f2f2", "1a1a1a", "6cabdd", K)],
  "ブレシア":          [k("1a4ba0", "ffffff", "1a4ba0", W), k("ffffff", "1a4ba0", "ffffff", K)],
  "キエーヴォ":        [k("f0d020", "12213f", "f0d020", K), k("12213f", "f0d020", "12213f", K)],
  "チェゼーナ":        [k("ffffff", "1a1a1a", "1a1a1a", K), k("1a1a1a", "ffffff", "1a1a1a", K)],
  "パルマ":            [k("f0e84a", "12213f", "12213f", K), k("ffffff", "12213f", "12213f", K)],
  "レッチェ":          [k("f0d84a", "d01824", "d01824", K), k("d01824", "f0d84a", "d01824", K)],

  // ===== Spain =====
  "バルセロナ":        [k("14235a", "14235a", "8a1030", W), k("f28a1a", "14235a", "f28a1a", K)],
  "レアル・マドリッド": [k("f6f6f6", "f6f6f6", "f6f6f6", W), k("2a2a2a", "2a2a2a", "2a2a2a", K)],
  "レアル・サラゴサ":  [k("ffffff", "12213f", "1a4ba0", W), k("12213f", "12213f", "12213f", K)],
  "セビージャ":        [k("ffffff", "ffffff", "d01824", W), k("d01824", "ffffff", "d01824", K)],
  "アトレチコ・マドリッド": [k("cb2130", "12213f", "ffffff", W), k("f2f2f2", "12213f", "f2f2f2", K)],
  "エスパニョール":    [k("1a4ba0", "ffffff", "1a4ba0", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],
  "ヘタフェ":          [k("1a56b0", "1a56b0", "1a56b0", W), k("f2f2f2", "1a56b0", "f2f2f2", K)],
  "エルクレス":        [k("12417a", "ffffff", "ffffff", W), k("f2f2f2", "12417a", "f2f2f2", K)],
  "デポルティーボ":    [k("2a72c8", "ffffff", "2a72c8", W), k("1a1a1a", "2a72c8", "1a1a1a", K)],
  "ビジャレアル":      [k("f2e030", "12417a", "f2e030", K), k("12417a", "f2e030", "12417a", K)],
  "バレンシア":        [k("ffffff", "1a1a1a", "f28a1a", W), k("1a1a1a", "ffffff", "f28a1a", K)],
  "マジョルカ":        [k("b01828", "1a1a1a", "b01828", W), k("f2f2f2", "b01828", "f2f2f2", K)],
  "オサスナ":          [k("cb1828", "12213f", "cb1828", W), k("12213f", "cb1828", "12213f", K)],
  "ビルバオ":          [k("cb1828", "1a1a1a", "ffffff", W), k("1a1a1a", "cb1828", "1a1a1a", K)],
  "アルメリア":        [k("d01828", "ffffff", "d01828", W), k("ffffff", "d01828", "ffffff", K)],
  "デポルティボ・タチラ": [k("1a1a1a", "1a1a1a", "e8b020", W), k("e8b020", "1a1a1a", "e8b020", K)],
  "スポルティング・ヒホン": [k("d01828", "12213f", "ffffff", W), k("12213f", "d01828", "12213f", K)],
  "マラガ":            [k("2a86d8", "ffffff", "2a86d8", W), k("ffffff", "2a86d8", "ffffff", K)],
  "レアル・ソシエダ":  [k("1a4ba0", "ffffff", "1a4ba0", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],
  "デポルティボ・キト": [k("1a56b0", "ffffff", "1a56b0", W), k("d01828", "1a56b0", "d01828", K)],
  "レバンテ":          [k("1a4ba0", "8a1030", "8a1030", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],
  "デポルティボ・イタリア": [k("1a56b0", "1a56b0", "1a56b0", W), k("f2f2f2", "1a56b0", "f2f2f2", K)],
  "デポルティボ・クエンカ": [k("d01828", "1a1a1a", "d01828", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "ラシン・サンタンデール": [k("2a8a3a", "ffffff", "ffffff", W), k("1a1a1a", "2a8a3a", "1a1a1a", K)],

  // ===== Netherlands =====
  "ローダJC":          [k("f0d020", "1a1a1a", "1a1a1a", K), k("1a1a1a", "f0d020", "1a1a1a", K)],
  "フェイエノールト":  [k("d01828", "1a1a1a", "ffffff", K), k("f2f2f2", "1a1a1a", "d01828", K)],
  "VVVフェンロ":       [k("f0d020", "1a1a1a", "1a1a1a", K), k("1a1a1a", "f0d020", "1a1a1a", K)],
  "フローニンヘン":    [k("1a8a4a", "ffffff", "1a8a4a", W), k("1a1a1a", "1a8a4a", "1a1a1a", K)],
  "NECナイメーヘン":   [k("d01828", "1a1a1a", "1a1a1a", W), k("1a8a4a", "1a1a1a", "1a8a4a", K)],
  "NACブレダ":         [k("f0d020", "1a1a1a", "1a1a1a", K), k("1a1a1a", "f0d020", "1a1a1a", K)],
  "ヘーレンフェーン":  [k("1a5ac0", "ffffff", "ffffff", W), k("f2f2f2", "1a5ac0", "d01828", K)],
  "ADOデンハーグ":     [k("1a8a4a", "f0d020", "1a8a4a", W), k("f0d020", "1a8a4a", "f0d020", K)],
  "デ・フラーフスハプ": [k("1a4ba0", "ffffff", "1a4ba0", W), k("ffffff", "1a4ba0", "ffffff", K)],
  "アヤックス":        [k("ffffff", "ffffff", "d01828", W), k("101014", "101014", "d01828", K)],
  "ユトレヒト":        [k("d01828", "ffffff", "d01828", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "AZアルクマール":    [k("d01828", "ffffff", "d01828", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "ウィレムⅡ":         [k("d01828", "12213f", "ffffff", W), k("12213f", "d01828", "12213f", K)],
  "エクセルシオール":  [k("d01828", "1a1a1a", "1a1a1a", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "PSVアイントホーヘン": [k("d01828", "d01828", "ffffff", W), k("f2f2f2", "d01828", "f2f2f2", K)],
  "ヘラクレス":        [k("1a1a1a", "1a1a1a", "ffffff", W), k("f2f2f2", "1a1a1a", "f2f2f2", K)],
  "FCトゥウェンテ":    [k("d01828", "ffffff", "d01828", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "フィテッセ":        [k("1a1a1a", "1a1a1a", "f0d020", K), k("f0d020", "1a1a1a", "f0d020", K)],

  // ===== France =====
  "ヴァランシアンヌ":  [k("d01828", "ffffff", "1a1a1a", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "カーン":            [k("d01828", "12213f", "12213f", W), k("f2f2f2", "12213f", "f2f2f2", K)],
  "リヨン":            [k("ffffff", "ffffff", "1a4ba0", W), k("12213f", "d01828", "12213f", K)],
  "モンペリエSC":      [k("14417a", "f28a1a", "14417a", W), k("f28a1a", "14417a", "f28a1a", K)],
  "マルセイユ":        [k("ffffff", "ffffff", "3aa6dd", W), k("14417a", "14417a", "3aa6dd", K)],
  "サンテティエンヌ":  [k("1a8a4a", "ffffff", "1a8a4a", W), k("1a1a1a", "1a8a4a", "1a1a1a", K)],
  "パリ・サンジェルマン": [k("101a3a", "101a3a", "d01828", W), k("f2f2f2", "101a3a", "d01828", K)],
  "リールOSC":         [k("d01828", "ffffff", "12213f", W), k("12213f", "d01828", "12213f", K)],
  "OGCニース":         [k("d01828", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a1a1a", "d01828", K)],
  "ボルドー":          [k("12213f", "ffffff", "8a1030", W), k("8a1030", "12213f", "8a1030", K)],
  "ソショー":          [k("f0d020", "1a4ba0", "1a4ba0", K), k("1a4ba0", "f0d020", "1a4ba0", K)],
  "RCランス":          [k("f0d020", "d01828", "d01828", K), k("d01828", "f0d020", "d01828", K)],
  "ASナンシー":        [k("d01828", "ffffff", "12213f", W), k("12213f", "d01828", "12213f", K)],
  "スタード・ブレストワ": [k("d01828", "ffffff", "d01828", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "ロリアン":          [k("f37a1a", "1a1a1a", "f37a1a", K), k("1a1a1a", "f37a1a", "1a1a1a", K)],
  "AJオセール":        [k("ffffff", "12417a", "12417a", W), k("12417a", "ffffff", "12417a", K)],
  "ASモナコ":          [k("d01828", "ffffff", "ffffff", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "トゥールーズ":      [k("7a3ca8", "ffffff", "7a3ca8", W), k("ffffff", "7a3ca8", "ffffff", K)],
  "ACアルル":          [k("1a56b0", "ffffff", "1a56b0", W), k("f2f2f2", "1a56b0", "f2f2f2", K)],
  "スタード・レンヌ":  [k("d01828", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a1a1a", "d01828", K)],

  // ===== League A (Europe misc) =====
  "ベンフィカ":        [k("d01828", "ffffff", "d01828", W), k("2a2a2a", "d01828", "2a2a2a", K)],
  "FCポルト":          [k("1a4ba0", "ffffff", "1a4ba0", W), k("1a1a1a", "1a4ba0", "1a1a1a", K)],
  "オリンピアコス":    [k("d01828", "ffffff", "d01828", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "フェネルバフチェ":  [k("113a86", "113a86", "f0d84a", W), k("f0d84a", "113a86", "f0d84a", K)],
  "レンジャース":      [k("1a4ba0", "ffffff", "1a4ba0", W), k("1a1a1a", "1a4ba0", "1a1a1a", K)],
  "パナシナイコス":    [k("1a8a4a", "ffffff", "1a8a4a", W), k("f2f2f2", "1a8a4a", "f2f2f2", K)],
  "ペジクタシュ":      [k("1a1a1a", "1a1a1a", "ffffff", W), k("f2f2f2", "1a1a1a", "f2f2f2", K)],
  "スポルティング・CP": [k("1a8a4a", "ffffff", "1a8a4a", W), k("f2f2f2", "1a8a4a", "f2f2f2", K)],
  "CFRクルージュ":     [k("8a1030", "ffffff", "8a1030", W), k("f2f2f2", "8a1030", "f2f2f2", K)],
  "ディナモ・ザグレブ": [k("1a5ac0", "ffffff", "1a5ac0", W), k("f2f2f2", "1a5ac0", "f2f2f2", K)],
  "ディナモ・キエフ":  [k("1a4ba0", "ffffff", "ffffff", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],
  "ウニレア・ウルジチェニ": [k("f0d020", "1a4ba0", "f0d020", K), k("1a4ba0", "f0d020", "1a4ba0", K)],
  "レッドスター":      [k("d01828", "ffffff", "d01828", W), k("f2f2f2", "d01828", "f2f2f2", K)],
  "セルティック":      [k("1a8a4a", "ffffff", "ffffff", W), k("f0d84a", "1a8a4a", "f0d84a", K)],

  // ===== Argentina =====
  "CAコロン":          [k("d01828", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a1a1a", "d01828", K)],
  "ベレス・サルスフィエルド": [k("ffffff", "ffffff", "1a4ba0", W), k("1a4ba0", "ffffff", "1a4ba0", K)],
  "エストゥディアンテス・LP": [k("d01828", "1a1a1a", "ffffff", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "CAバンフィエルド":  [k("1a7a3a", "ffffff", "1a7a3a", W), k("f2f2f2", "1a7a3a", "f2f2f2", K)],
  "リーベル・プレート": [k("ffffff", "1a1a1a", "d01828", W), k("d01828", "1a1a1a", "ffffff", K)],
  "ニューウェルズ・OB": [k("d01828", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a1a1a", "d01828", K)],
  "ボカ・ジュニオルス": [k("12285a", "12285a", "e8b020", W), k("f0d020", "12285a", "f0d020", K)],

  // ===== Brazil =====
  "コリンチャンス":    [k("f2f2f2", "1a1a1a", "1a1a1a", W), k("1a1a1a", "f2f2f2", "1a1a1a", K)],
  "フラメンゴ":        [k("c81828", "1a1a1a", "1a1a1a", W), k("f2f2f2", "c81828", "1a1a1a", K)],
  "サン・パウロFC":    [k("ffffff", "1a1a1a", "d01828", W), k("d01828", "1a1a1a", "d01828", K)],
  "SCブラガ":          [k("c81828", "ffffff", "c81828", W), k("1a1a1a", "c81828", "1a1a1a", K)],
  "クルゼイロ":        [k("1a4ba0", "ffffff", "1a4ba0", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],

  // ===== Mexico =====
  "モナルカス・モレリア": [k("c81828", "f0d020", "c81828", K), k("f0d020", "c81828", "f0d020", K)],
  "サン・ルイスFC":    [k("c81828", "ffffff", "c81828", W), k("f2f2f2", "c81828", "f2f2f2", K)],
  "CFモンテレイ":      [k("12213f", "ffffff", "12213f", W), k("f2f2f2", "12213f", "f2f2f2", K)],
  "CDグアダラハラ":    [k("c81828", "12213f", "ffffff", W), k("f2f2f2", "12213f", "c81828", K)],
  "エストゥディアンテス・TC": [k("1a1a1a", "1a1a1a", "c81828", W), k("c81828", "1a1a1a", "c81828", K)],

  // ===== Uruguay =====
  "クラブ・ナシオナル(U)": [k("ffffff", "12417a", "12417a", W), k("12417a", "ffffff", "12417a", K)],
  "RCモンテビデオ":    [k("1a7a3a", "ffffff", "d01828", W), k("f2f2f2", "1a7a3a", "d01828", K)],
  "CAセロ":            [k("6cabdd", "ffffff", "6cabdd", W), k("12417a", "6cabdd", "12417a", K)],

  // ===== Chile =====
  "ウニベルシダ・デ・チリ": [k("12417a", "ffffff", "12417a", W), k("f2f2f2", "12417a", "f2f2f2", K)],
  "ウニベルシダ・カトリカ": [k("ffffff", "12417a", "12417a", W), k("12417a", "ffffff", "12417a", K)],
  "CSDコロ・コロ":     [k("ffffff", "1a1a1a", "1a1a1a", W), k("1a1a1a", "ffffff", "1a1a1a", K)],

  // ===== Paraguay =====
  "クラブ・リベルタ":  [k("1a1a1a", "1a1a1a", "ffffff", W), k("f2f2f2", "1a1a1a", "f2f2f2", K)],
  "クラブ・ナシオナル(P)": [k("1a4ba0", "ffffff", "1a4ba0", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],
  "セロ・ポルテーニョ": [k("d01828", "12285a", "12285a", W), k("f2f2f2", "d01828", "12285a", K)],

  // ===== Peru =====
  "ウニベルシタリオ・D": [k("f0ead0", "1a1a1a", "f0ead0", K), k("8a1030", "f0ead0", "8a1030", K)],
  "アリアンサ・リマ":  [k("12417a", "ffffff", "12417a", W), k("f0d84a", "12417a", "f0d84a", K)],
  "ファン・アウリチ":  [k("f0d020", "1a1a1a", "f0d020", K), k("1a1a1a", "f0d020", "1a1a1a", K)],

  // ===== Bolivia =====
  "クラブ・ブルーミング": [k("6cabdd", "ffffff", "6cabdd", W), k("f2f2f2", "6cabdd", "f2f2f2", K)],
  "レアル・ポトシ":    [k("7a3ca8", "ffffff", "7a3ca8", W), k("f2f2f2", "7a3ca8", "f2f2f2", K)],
  "クラブ・ボリバル":  [k("2a72c8", "ffffff", "2a72c8", W), k("f2f2f2", "2a72c8", "f2f2f2", K)],

  // ===== Russia =====
  "スパルタク・モスクワ": [k("d01828", "ffffff", "ffffff", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "ゼニト":            [k("2a86d8", "ffffff", "2a86d8", W), k("12213f", "2a86d8", "12213f", K)],
  "ルビン・カザン":    [k("8a1030", "1a7a3a", "8a1030", W), k("1a7a3a", "8a1030", "1a7a3a", K)],

  // ===== Greece =====
  "PAOKテッサロニキ":  [k("1a1a1a", "1a1a1a", "ffffff", W), k("f2f2f2", "1a1a1a", "f2f2f2", K)],
  "AEKアテネ":         [k("f0d020", "1a1a1a", "1a1a1a", K), k("1a1a1a", "f0d020", "1a1a1a", K)],

  // ===== Colombia =====
  "アトレチコ・ジュニオール": [k("d01828", "ffffff", "1a1a1a", W), k("1a1a1a", "d01828", "1a1a1a", K)],
  "オンセ・カルダス":  [k("ffffff", "1a1a1a", "d01828", W), k("1a1a1a", "ffffff", "d01828", K)],

  // ===== Czech =====
  "スパルタ・プラハ":  [k("8a1030", "1a1a1a", "8a1030", W), k("f2f2f2", "8a1030", "f2f2f2", K)],
  "スラビア・プラハ":  [k("d01828", "ffffff", "ffffff", W), k("1a1a1a", "d01828", "1a1a1a", K)],

  // ===== Germany =====
  "ブレーメン":        [k("1a8a4a", "ffffff", "1a8a4a", W), k("1a1a1a", "1a8a4a", "1a1a1a", K)],
  "バイエルン・ミュンヘン": [k("d21024", "d21024", "d21024", W), k("101014", "d21024", "101014", K)],

  // ===== Belgium =====
  "クラブ・ブルージュ": [k("1a5ac0", "1a1a1a", "1a1a1a", W), k("f2f2f2", "1a5ac0", "f2f2f2", K)],
  "アンデルレヒト":    [k("7a3ca8", "ffffff", "7a3ca8", W), k("f2f2f2", "7a3ca8", "f2f2f2", K)],

  // ===== Others (single-team leagues) =====
  "シャフタール・ドネツク": [k("f37a1a", "1a1a1a", "1a1a1a", K), k("1a1a1a", "f37a1a", "1a1a1a", K)],
  "CSエメルク":        [k("1a5ac0", "ffffff", "1a5ac0", W), k("f2f2f2", "1a5ac0", "f2f2f2", K)],
  "FCバーゼル":        [k("d01828", "12417a", "d01828", W), k("12417a", "d01828", "12417a", K)],
  "AIKソルナ":         [k("1a1a1a", "1a1a1a", "f0d020", K), k("f0d020", "1a1a1a", "f0d020", K)],
  "FCコペンハーゲン":  [k("ffffff", "12417a", "12417a", W), k("12417a", "ffffff", "12417a", K)],
  "ガラタサライ":      [k("c81828", "f2a020", "c81828", K), k("f2a020", "c81828", "f2a020", K)],
  "ローゼンボリ":      [k("ffffff", "1a1a1a", "1a1a1a", W), k("1a1a1a", "ffffff", "1a1a1a", K)],
  "HJKヘルシンキ":     [k("1a4ba0", "ffffff", "1a4ba0", W), k("f2f2f2", "1a4ba0", "f2f2f2", K)],
  "カラカスFC":        [k("8a1030", "8a1030", "8a1030", W), k("f2f2f2", "8a1030", "f2f2f2", K)],
  "ディナモ・ブカレスト": [k("d01828", "1a4ba0", "d01828", W), k("1a4ba0", "d01828", "1a4ba0", K)],
};
