// ---------------------------------------------------------------------------
// シミュレーション定数。距離はすべてメートル、速度はすべてメートル/秒。
// 座標の取り決め:
//   X = コート幅   (サイドラインは x = ±halfW)
//   Z = コート長さ (ベースラインは z = ±halfL)
//   Y = 上
// Team 0 は +Z のフープを攻め、Team 1 は -Z のフープを攻める。
// ---------------------------------------------------------------------------

export const COURT = {
  width: 15,   // X方向の広がり (NBA: 15.24)
  length: 28,  // Z方向の広がり (NBA: 28.65)
  halfW: 7.5,
  halfL: 14,
  margin: 0.5, // 選手はラインからこの距離だけ内側に保たれる
};

export const RIM = {
  height: 3.05,
  radius: 0.23,
  z: 13.0,        // 各エンドのリム中心の |Z|(ベースラインのすぐ内側)
  backboardZ: 13.6,
};

export const SHOOT_RANGE = 7.6;   // 選手が通常シュートを打つ最大距離
export const THREE_DIST = 6.75;   // これより遠いと3Pとして数える

// シュートモーションのボール高さ（ロード頂点＝頭上／ギャザー開始＝胸元）
export const SHOT_SET_Y = 2.1;    // ロード頂点での頭上のボール高さ
export const SHOT_GATHER_Y = 1.2; // ギャザーが始まる位置 — 胸元 / ポケット

// スタミナゲージを表示する場所。"name": 各選手の頭上に浮かぶ3Dネームタグ上（デフォルト）。
// "icon": 代わりに下部HUDの顔アイコンの下。`rev` はトグルが切り替わるたびに増分し、疲労値
// 自体は変わっていなくてもネームタグを強制的に再描画させる。
export const HUD_OPTS: { staminaOn: "name" | "icon"; showNames: boolean; rev: number } =
  { staminaOn: "icon", showNames: true, rev: 0 };

export const PLAYER_SPEED = 6.2;  // オフェンス時の走行速度
export const DEF_SPEED = 6.5;     // 守備がリカバーできるよう少しだけ速い
export const BURST_SPEED = 7.5;   // 抜き去りバーストの想定速度
export const BODY_MIN_DIST = 0.62; // 選手同士の最小ボディ間隔(押し離しの基準)
export const OOB_OUTSET = 0.3;     // アウトオブバウンズでラインの外に立つ距離
export const INBOUNDS_INSET = 1.0; // コート内に収める際のラインからの内側距離
// ボールの反射壁／OOB確定の位置（コートラインから外側へ。黒いエプロン(+3m)の外）。
// OOBになってもこの距離まではボールが軌道のまま外へ飛び、そこで壁/スローインになる。
export const OOB_WALL = 3.2;
export const PASS_SPEED = 13;     // パスの移動速度
export const LANE_W = 1.1;        // 守備がパスレーンを脅かす横方向の距離(m)
// 手のひら当たり判定モデル: 守備のリーチ半径を(守備−オフェンス)でスケール。false で
// 旧来の固定距離モデルへ。スティール/コンテスト/ブロックの確率ゲートに使う。
export const PALM_HITBOX = true;
// これより長いパスは投げない
export const MAX_PASS = 13;
// クォーター圧縮とペースに合わせたショットクロック。部分リセット(ファウル/オフェンスリバウンド後)は短縮。
export const SHOT_CLOCK = 12;
export const SHOT_CLOCK_PARTIAL = 8;
export const QUARTER_TIME = 60;   // 1クォーターあたりのゲーム内秒数(クロックに表示)
export const QUARTERS = 4;
export const BUZZER_WINDOW = 0.9; // 残りこの秒数を切ったらブザービーター扱い

export const TEAM_COLORS = [
  { r: 0.86, g: 0.34, b: 0.12 }, // Team 0 — オレンジ (UIアクセント: バナー、ネットのフラッシュ、タグ)
  { r: 0.16, g: 0.42, b: 0.82 }, // Team 1 — 青
];
export const TEAM_NAMES = ["BLAZE", "WAVE"];

// ---------------------------------------------------------------------------
// ユニフォーム。各チームはホームとアウェイのキットを持つ。各キットは4つの部位を
// 独立に着色する: top (胸/上半身)、bottom (ショーツ/下半身)、sleeve (そで+上腕)、
// shoes (シューズ)。TEAM_UNIFORM は各チームが今試合でどのキットを着るかを選ぶ。
// ---------------------------------------------------------------------------
export interface RGB { r: number; g: number; b: number; }
export interface Uniform { top: RGB; bottom: RGB; sleeve: RGB; shoes: RGB; }

export const UNIFORMS: [Uniform, Uniform][] = [
  [ // Team 0 — [ホーム (明るいオレンジ), アウェイ (暗色)]
    { top: { r: 0.90, g: 0.37, b: 0.14 }, bottom: { r: 0.82, g: 0.31, b: 0.10 },
      sleeve: { r: 0.70, g: 0.23, b: 0.06 }, shoes: { r: 0.95, g: 0.95, b: 0.95 } },
    { top: { r: 0.18, g: 0.18, b: 0.20 }, bottom: { r: 0.13, g: 0.13, b: 0.15 },
      sleeve: { r: 0.88, g: 0.36, b: 0.13 }, shoes: { r: 0.12, g: 0.12, b: 0.12 } },
  ],
  [ // Team 1 — [ホーム (明るい青), アウェイ (白)]
    { top: { r: 0.20, g: 0.48, b: 0.88 }, bottom: { r: 0.13, g: 0.38, b: 0.78 },
      sleeve: { r: 0.09, g: 0.28, b: 0.60 }, shoes: { r: 0.95, g: 0.95, b: 0.95 } },
    { top: { r: 0.93, g: 0.94, b: 0.97 }, bottom: { r: 0.84, g: 0.86, b: 0.92 },
      sleeve: { r: 0.16, g: 0.42, b: 0.82 }, shoes: { r: 0.14, g: 0.14, b: 0.16 } },
  ],
];

// 各チームがどのキットを着るか(0 = ホーム, 1 = アウェイ)。team 0 は常にホーム、team 1 は常にアウェイ。
export const TEAM_UNIFORM: [number, number] = [0, 1];

// 各チームが現在代表しているクラブ(その名前、clubdb由来)、またはランダム / BLAZE-WAVE
// ロスターの場合は ""。クラブピッカーが設定し、クラブごとのキットを駆動する。
export const TEAM_CLUB: [string, string] = ["", ""];

// (型/データの後でインポート。実行時のエッジは config → clubkits のみで循環はない。)
// eslint-disable-next-line @typescript-eslint/no-use-before-define
import { CLUB_KITS } from "./data/club/clubkits";
// eslint-disable-next-line @typescript-eslint/no-use-before-define
import { CLUB_ABBR } from "./data/club/clubabbr";

// 素のキット(ホーム/アウェイ)。実在のクラブは自分のキット(CLUB_KITS)、ランダムロスターは
// 汎用のチームスロットキット(BLAZE / WAVE)にフォールバックする。
function baseUniform(team: number): Uniform {
  const variant = TEAM_UNIFORM[team] ? 1 : 0;
  const club = TEAM_CLUB[team];
  if (club && CLUB_KITS[club]) return CLUB_KITS[club][variant];
  return UNIFORMS[team][variant];
}

// ---- サードユニフォーム(上半身の色被り回避) ----------------------------------
const lum = (c: RGB) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const satOf = (c: RGB) => { const mx = Math.max(c.r, c.g, c.b); return mx <= 0 ? 0 : (mx - Math.min(c.r, c.g, c.b)) / mx; };
const hueOf = (c: RGB) => {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), d = mx - mn;
  if (d <= 0) return 0;
  let h = mx === c.r ? ((c.g - c.b) / d) % 6 : mx === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
};
// 上半身の色が「同系統」で見分けにくいか。明度差が大きければ区別可(白 vs 濃色)。両方ほぼ無彩色
// なら明度が近い時のみ衝突(白同士/黒同士)。両方有彩色なら色相が近い時に衝突(同じ系統色)。
function topsClash(a: RGB, b: RGB): boolean {
  if (Math.abs(lum(a) - lum(b)) > 0.32) return false;
  const sa = satOf(a), sb = satOf(b);
  if (sa < 0.18 && sb < 0.18) return true;
  if (sa < 0.18 || sb < 0.18) return false;
  let hd = Math.abs(hueOf(a) - hueOf(b)); if (hd > 180) hd = 360 - hd;
  return hd < 42;
}
// サードキット: ホームの上半身と明度で必ず差がつく中間色(明るいホーム→暗色 / 暗いホーム→白系)。
// アウェイ元の上半身色をそで(アクセント)に残し、アウェイのアイデンティティを保つ。
function thirdKit(away: Uniform, homeTop: RGB): Uniform {
  return lum(homeTop) > 0.5
    ? { top: { r: 0.14, g: 0.15, b: 0.18 }, bottom: { r: 0.10, g: 0.11, b: 0.13 }, sleeve: away.top, shoes: { r: 0.92, g: 0.92, b: 0.92 } }
    : { top: { r: 0.93, g: 0.94, b: 0.97 }, bottom: { r: 0.85, g: 0.86, b: 0.90 }, sleeve: away.top, shoes: { r: 0.14, g: 0.14, b: 0.16 } };
}

export function uniformOf(team: number): Uniform {
  const base = baseUniform(team);
  // サードユニフォーム: ホームの上半身とアウェイの上半身が同系統色なら、アウェイが着替える。
  if (TEAM_UNIFORM[team] === 1) {                 // このチームはアウェイ
    const homeTop = baseUniform(1 - team).top;    // 相手(ホーム)の上半身色
    if (topsClash(homeTop, base.top)) return thirdKit(base, homeTop);
  }
  return base;
}

// スコアボードのスコアバッジ用の短いラベル: 実在のクラブは3文字コード(ARS, BAL, …)を
// 表示し、ランダム / BLAZE-WAVE ロスターはフルのチーム名を保つ。
export function teamAbbr(team: number): string {
  const club = TEAM_CLUB[team];
  if (club && CLUB_ABBR[club]) return CLUB_ABBR[club];
  return TEAM_NAMES[team];
}

// ゲーム内バナー用に手調整した短縮名(フルのクラブ名が長すぎてレイアウトを崩す場合)。
// ここに載っていないものは teamShort() のルールで導出される。導出された短縮名を上書き
// したいクラブはここに追加する。
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

// ゲーム内の通知バナー用のコンパクトなチーム名。クラブは短縮名を使い、
// ランダムな BLAZE/WAVE ロスターはその名前を保つ。
export function teamShort(team: number): string {
  const club = TEAM_CLUB[team];
  if (!club) return TEAM_NAMES[team];
  if (CLUB_SHORT_OVERRIDE[club]) return CLUB_SHORT_OVERRIDE[club];
  let s = club;
  if (club.includes("・")) {
    const parts = club.split("・");
    const last = parts[parts.length - 1];
    if (last.length <= 2) {
      s = parts[0].slice(0, 2) + last;                    // 地名 + タグ
    } else {
      const ab = CLUB_ABBR[club];                          // ローマ字の頭文字を付けた都市
      s = (ab ? ab[0] : "") + last;
    }
  }
  return s.length > 6 ? `${s.slice(0, 5)}…` : s;           // オーバーフローしないようハードキャップ
}
