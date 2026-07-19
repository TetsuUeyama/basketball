// ---------------------------------------------------------------------------
// Simulation constants. All distances in metres, all speeds in metres/second.
// Coordinate convention (kept deliberately simple — no imported models, so
// handedness never produces a visible orientation bug):
//   X = court width   (sidelines at x = ±halfW)
//   Z = court length  (baselines at z = ±halfL)
//   Y = up
// Team 0 attacks the +Z hoop, Team 1 attacks the -Z hoop.
// ---------------------------------------------------------------------------

export const COURT = {
  width: 15,   // X extent (NBA: 15.24)
  length: 28,  // Z extent (NBA: 28.65)
  halfW: 7.5,
  halfL: 14,
  margin: 0.5, // players are kept this far inside the lines
};

export const RIM = {
  height: 3.05,
  radius: 0.23,
  z: 13.0,        // |Z| of the rim centre at each end (just inside the baseline)
  backboardZ: 13.6,
};

// Returns the rim centre (a 3D point) for the hoop a team attacks.
export function hoopCenter(team: number) {
  const z = team === 0 ? RIM.z : -RIM.z;
  return { x: 0, y: RIM.height, z };
}
// Floor point directly under that rim.
export function hoopFloor(team: number) {
  return { x: 0, z: team === 0 ? RIM.z : -RIM.z };
}

export const SHOOT_RANGE = 7.6;   // max distance a player will normally shoot from
export const THREE_DIST = 6.75;   // beyond this counts as a 3-pointer

// Where the stamina gauge is shown. "name": on the floating 3D name tag above
// each player (default). "icon": under the bottom-HUD face icon instead. `rev`
// bumps whenever the toggle flips so the name tags force a repaint even though
// the fatigue value itself didn't change.
export const HUD_OPTS: { staminaOn: "name" | "icon"; showNames: boolean; model: "human" | "acorn"; rev: number } =
  { staminaOn: "icon", showNames: true, model: "acorn", rev: 0 };

export const PLAYER_SPEED = 6.2;  // offensive run speed
export const DEF_SPEED = 6.5;     // defenders are a touch quicker so they can recover
export const PASS_SPEED = 13;     // pass travel speed
// Shot clock scaled to the compressed quarter (60s vs the NBA's 720s) AND the
// fast pace: 14/10 rarely bit, so 7 makes it a genuine pressure. Partial resets
// (after a foul / offensive rebound) → 5.
export const SHOT_CLOCK = 7;
export const SHOT_CLOCK_PARTIAL = 5;
export const QUARTER_TIME = 60;   // game-seconds per quarter (shown on the clock)
export const QUARTERS = 4;

export const TEAM_COLORS = [
  { r: 0.86, g: 0.34, b: 0.12 }, // Team 0 — orange (UI accent: banners, net flash, tags)
  { r: 0.16, g: 0.42, b: 0.82 }, // Team 1 — blue
];
export const TEAM_NAMES = ["BLAZE", "WAVE"];

// ---------------------------------------------------------------------------
// Uniforms. Each team has a HOME and an AWAY kit; each kit colours FOUR parts
// independently: top (chest/上半身), bottom (shorts/下半身), sleeve (そで+上腕),
// and shoes (シューズ). TEAM_UNIFORM picks which kit each team wears this game
// (default team0 home / team1 away so the two never clash) — mutate it (and call
// Game.applyUniforms) to swap.
// ---------------------------------------------------------------------------
export interface RGB { r: number; g: number; b: number; }
export interface Uniform { top: RGB; bottom: RGB; sleeve: RGB; shoes: RGB; }

export const UNIFORMS: [Uniform, Uniform][] = [
  [ // Team 0 — [HOME (bright orange), AWAY (dark)]
    { top: { r: 0.90, g: 0.37, b: 0.14 }, bottom: { r: 0.82, g: 0.31, b: 0.10 },
      sleeve: { r: 0.70, g: 0.23, b: 0.06 }, shoes: { r: 0.95, g: 0.95, b: 0.95 } },
    { top: { r: 0.18, g: 0.18, b: 0.20 }, bottom: { r: 0.13, g: 0.13, b: 0.15 },
      sleeve: { r: 0.88, g: 0.36, b: 0.13 }, shoes: { r: 0.12, g: 0.12, b: 0.12 } },
  ],
  [ // Team 1 — [HOME (bright blue), AWAY (white)]
    { top: { r: 0.20, g: 0.48, b: 0.88 }, bottom: { r: 0.13, g: 0.38, b: 0.78 },
      sleeve: { r: 0.09, g: 0.28, b: 0.60 }, shoes: { r: 0.95, g: 0.95, b: 0.95 } },
    { top: { r: 0.93, g: 0.94, b: 0.97 }, bottom: { r: 0.84, g: 0.86, b: 0.92 },
      sleeve: { r: 0.16, g: 0.42, b: 0.82 }, shoes: { r: 0.14, g: 0.14, b: 0.16 } },
  ],
];

// which kit each team wears (0 = home, 1 = away). Fixed by design: team 0
// (BLAZE side) always wears HOME, team 1 (WAVE side) always wears AWAY — this is
// no longer user-toggleable, so a club picked for team 0 shows its home kit and
// a club picked for team 1 shows its away kit.
export const TEAM_UNIFORM: [number, number] = [0, 1];

// the CLUB each team currently represents (its name, from clubdb), or "" for a
// random / BLAZE-WAVE roster. Set by the club picker; drives per-club kits.
export const TEAM_CLUB: [string, string] = ["", ""];

// (imported below the type/data it needs; the type import in clubkits is erased,
//  so the only runtime edge is config → clubkits — no cycle.)
// eslint-disable-next-line @typescript-eslint/no-use-before-define
import { CLUB_KITS } from "./clubkits";
// eslint-disable-next-line @typescript-eslint/no-use-before-define
import { CLUB_ABBR } from "./clubabbr";

export function uniformOf(team: number): Uniform {
  // a real club wears ITS OWN kit (home/away from CLUB_KITS); a random roster
  // falls back to the generic team-slot kit (BLAZE / WAVE).
  const variant = TEAM_UNIFORM[team] ? 1 : 0;
  const club = TEAM_CLUB[team];
  if (club && CLUB_KITS[club]) return CLUB_KITS[club][variant];
  return UNIFORMS[team][variant];
}

// Short label for the scoreboard score-bug: a real club shows its 3-letter code
// (ARS, BAL, …); a random / BLAZE-WAVE roster keeps the full team name.
export function teamAbbr(team: number): string {
  const club = TEAM_CLUB[team];
  if (club && CLUB_ABBR[club]) return CLUB_ABBR[club];
  return TEAM_NAMES[team];
}

// Hand-tuned short names for the in-game banners (where a full club name is too
// long and breaks the layout). Anything not listed is derived by the rule in
// teamShort(); add a club here to override its derived short name.
const CLUB_SHORT_OVERRIDE: Record<string, string> = {
  // イングランド
  "マンチェスター・U": "マンU",
  "マンチェスター・C": "マンC",
  "ニューカッスル": "ニューカスル",
  "ブラックバーン": "ブラバーン",
  "ウェストブロムウィッチ": "ウェストブロ",
  "ウォルバーハンプトン": "ウルブス",
  "ブラックプール": "ブラプール",
  "サンダーランド": "サンダラン",
  "ウエスト・ハム・U": "ウェストハム",
  // イタリア
  "フィオレンティーナ": "フィオレ",
  "インテルナシオナル": "インテナシ",
  // スペイン
  "レアル・マドリッド": "Rマドリー",
  "アトレチコ・マドリッド": "Aマドリー",
  "エスパニョール": "エスパニョル",
  "デポルティーボ": "デポル",
  "ラシン・サンタンデール": "サンタンデル",
  // オランダ
  "フェイエノールト": "フェイエ",
  "VVVフェンロ": "Vフェンロ",
  "フローニンヘン": "フローニン",
  "NECナイメーヘン": "NEC",
  "ヘーレンフェーン": "ヘーレン",
  "ADOデンハーグ": "ADO",
  "デ・フラーフスハプ": "フラーフス",
  "AZアルクマール": "AZ",
  "エクセルシオール": "エクセル",
  "PSVアイントホーヘン": "PSV",
  "FCトゥウェンテ": "トゥエンテ",
  // フランス
  "ヴァランシアンヌ": "ヴァラン",
  "モンペリエSC": "モンペリエ",
  "サンテティエンヌ": "サンテティ",
  "パリ・サンジェルマン": "PSG",
  "スタード・ブレストワ": "ブレスト",
  // 他リーグA
  "オリンピアコス": "オリンピア",
  "フェネルバフチェ": "フェネル",
  "パナシナイコス": "パナシナイ",
  "CFRクルージュ": "CFR",
  "ウニレア・ウルジチェニ": "ウニレア",
  // アルゼンチン
  "ベレス・サルスフィエルド": "ベレス",
  "CAバンフィエルド": "バンフィエル",
  "ニューウェルズ・OB": "ニューエル",
  "ボカ・ジュニオルス": "ボカ",
  // ブラジル
  "コリンチャンス": "コリンチャ",
  "サン・パウロFC": "サンパウロ",
  // メキシコ
  "モナルカス・モレリア": "モレリア",
  "サン・ルイスFC": "サンルイス",
  "CFモンテレイ": "モンテレイ",
  "CDグアダラハラ": "グアダラ",
  // ウルグアイ
  "クラブ・ナシオナル(U)": "ナシオナルU",
  "RCモンテビデオ": "モンテビデ",
  // チリ
  "ウニベルシダ・カトリカ": "カトリカ",
  "CSDコロ・コロ": "コロコロ",
  // パラグアイ
  "クラブ・ナシオナル(P)": "ナシオナルP",
  "セロ・ポルテーニョ": "セロポル",
  // ペルー
  "ウニベルシタリオ・D": "ウニタリオ",
  "アリアンサ・リマ": "アリアンサ",
  "ファン・アウリチ": "アウリチ",
  // ボリビア
  "クラブ・ブルーミング": "ブルーミン",
  "レアル・ポトシ": "ポトシ",
  "クラブ・ボリバル": "ボリバル",
  // ギリシャ
  "PAOKテッサロニキ": "PAOK",
  // コロンビア
  "アトレチコ・ジュニオール": "ジュニオル",
  "オンセ・カルダス": "カルダス",
  // チェコ（重複回避）
  "スパルタ・プラハ": "スパルタ",
  "スラビア・プラハ": "スラビア",
  // ベルギー
  "クラブ・ブルージュ": "ブルージュ",
  "アンデルレヒト": "アンデル",
  // 単独リーグ
  "シャフタール・ドネツク": "シャフタル",
  "FCコペンハーゲン": "コペン",
  "HJKヘルシンキ": "HJK",
  "ディナモ・ブカレスト": "ブカレスト",
};

// A compact TEAM NAME for the in-game notification banners. A club uses its short
// name (e.g. バイエルン・ミュンヘン → Bミュンヘン, レアル・マドリッド → Rマドリー); a
// random BLAZE/WAVE roster keeps its (already short) name.
export function teamShort(team: number): string {
  const club = TEAM_CLUB[team];
  if (!club) return TEAM_NAMES[team];
  if (CLUB_SHORT_OVERRIDE[club]) return CLUB_SHORT_OVERRIDE[club];
  let s = club;
  if (club.includes("・")) {
    const parts = club.split("・");
    const last = parts[parts.length - 1];
    if (last.length <= 2) {
      s = parts[0].slice(0, 2) + last;                    // place + tag: マンチェスター・U → マンU
    } else {
      const ab = CLUB_ABBR[club];                          // city with a romaji initial:
      s = (ab ? ab[0] : "") + last;                        //   バイエルン・ミュンヘン → Bミュンヘン
    }
  }
  return s.length > 6 ? `${s.slice(0, 5)}…` : s;           // hard cap so it never overflows
}
