import { clamp } from "./util";

// ---------------------------------------------------------------------------
// Player attributes. All ratings are 0..100. The 25-item schema follows the
// user's spec (see workPlan.md): every rating below is wired into game.ts.
// Height lives on PlayerDef (metres), not here.
// ---------------------------------------------------------------------------
export interface Attributes {
  offense: number;      // オフェンス — オフェンス時の判断・反応の速さ・視野の広さ
  defense: number;      // ディフェンス — ディフェンス時の判断・反応の良さ・視野の広さ
  balance: number;      // ボディバランス — 接触時の強さ
  stamina: number;      // スタミナ — 持久力
  speed: number;        // 速度 — 最高速度
  accel: number;        // 加速力 — 最高速度に到達するまでの速さ
  reaction: number;     // 反応 — とっさの判断や反応
  agility: number;      // 敏捷性 — クイックネス
  dribbleAcc: number;   // D精度 — ドリブル時のスティールされなさ・次の行動への滑らかさ
  dribbleSpd: number;   // D速度 — ドリブル中でも速度が落ちない度
  passAcc: number;      // P精度 — パスの精度・視野の広さ
  passSpd: number;      // P速度 — パスの速さ
  threeAcc: number;     // L精度 — 3Pシュートの精度
  threeRange: number;   // L速度 — 3Pを打てる距離（高いほど遠くから打てる）
  midAcc: number;       // S精度 — ミドルシュートやレイアップの精度
  shotStrength: number; // S威力 — ブロッカーの接触があっても精度を落とさない度合い
  shotTech: number;     // S技術 — 態勢が崩れていても精度よく打てる度合い
  freeThrow: number;    // FK — フリースローの精度
  bank: number;         // カーブ — バンクシュートのうまさ
  dunk: number;         // ヘッド — ダンクのうまさとそれをブロックするうまさ
  jump: number;         // ジャンプ — ジャンプ力
  handling: number;     // 技術 — ボールハンドリングのうまさ
  aggression: number;   // 攻撃性 — オフェンス意識の高さ
  mental: number;       // 精神 — 疲労時・劣勢時・4Q終盤の接戦での強さ
  teamwork: number;     // 連携 — チーム戦術の遂行度
}

// Column metadata for the roster editor: short label + full explanation.
// Order here = column order in the pre-game editor.
export const ATTR_META: { key: keyof Attributes; label: string; name: string; tip: string }[] = [
  { key: "offense", label: "OFF", name: "オフェンス",
    tip: "オフェンス時の判断・反応の速さ・視野の広さ。高いほど次の行動の判断が速く、良いパスコース／空いた味方を見つけやすい。" },
  { key: "defense", label: "DEF", name: "ディフェンス",
    tip: "ディフェンス時の判断・反応の良さ・視野の広さ。フェイクに引っかかりにくく、パスコースの読みとポジショニングが良くなる。" },
  { key: "balance", label: "BAL", name: "ボディバランス",
    tip: "接触時の強さ。押し合い・ポストアップ・空中の接触で押し負けにくく、相手を押し下げられる。" },
  { key: "stamina", label: "STA", name: "スタミナ",
    tip: "持久力。高いほど疲労が溜まりにくい。疲労すると移動速度とシュート精度が落ちる（落ち方は「精神」で軽減）。" },
  { key: "speed", label: "SPD", name: "速度",
    tip: "最高速度。走って出せるトップスピード。" },
  { key: "accel", label: "ACC", name: "加速力",
    tip: "最高速度に到達するまでの速さ。高いほど出足が鋭い。" },
  { key: "reaction", label: "REA", name: "反応",
    tip: "とっさの判断や反応。スティール・パスカット・ルーズボール・ブロックへの反応、抜かれた後の対応の速さに影響。" },
  { key: "agility", label: "AGI", name: "敏捷性",
    tip: "クイックネス。切り返しや横の動きの鋭さ。1on1で抜く側にも守る側にも効く。" },
  { key: "dribbleAcc", label: "DRA", name: "D精度",
    tip: "ドリブル時のスティールされにくさと、次の行動に移るまでの滑らかさ。" },
  { key: "dribbleSpd", label: "DRS", name: "D速度",
    tip: "ドリブル中でも速度が落ちない度合い。高いほどボール保持中もトップスピードに近い速さで運べる。" },
  { key: "passAcc", label: "PAS", name: "P精度",
    tip: "パスの精度・視野の広さ。狭いコースでもカットされにくいパスを通せる。" },
  { key: "passSpd", label: "PSP", name: "P速度",
    tip: "パスの速さ。速いパスは滞空が短くカットされにくい。" },
  { key: "threeAcc", label: "3PT", name: "L精度",
    tip: "3Pシュートの精度。" },
  { key: "threeRange", label: "RNG", name: "L速度",
    tip: "3Pシュートを打てる距離。高いほどラインの遠くからでも打ち、距離による精度低下も小さい。" },
  { key: "midAcc", label: "SHT", name: "S精度",
    tip: "ミドルシュートやレイアップの精度。" },
  { key: "shotStrength", label: "PWR", name: "S威力",
    tip: "シュート中に相手ブロッカーの接触があっても精度を落とさずシュートを打てる度合い。" },
  { key: "shotTech", label: "TEC", name: "S技術",
    tip: "態勢が崩れていても（ドライブ中・走りながらでも）精度よくシュートを打てる度合い。" },
  { key: "freeThrow", label: "FTS", name: "FK",
    tip: "フリースローの精度。" },
  { key: "bank", label: "BNK", name: "カーブ",
    tip: "バンクシュート（ボードに当てるシュート）のうまさ。角度のあるミドルシュートで精度が上がる。" },
  { key: "dunk", label: "DNK", name: "ヘッド",
    tip: "ダンクのうまさと、相手のダンク/リム付近のフィニッシュをブロックするうまさ。" },
  { key: "jump", label: "JMP", name: "ジャンプ",
    tip: "ジャンプ力。リバウンド・ブロック・ダンクの高さと、空中のボールへの届きやすさ。" },
  { key: "handling", label: "HND", name: "技術",
    tip: "ボールハンドリングのうまさ。1on1で相手を抜く力・ボールキープ力。" },
  { key: "aggression", label: "AGG", name: "攻撃性",
    tip: "オフェンス意識の高さ。高いほど自分からシュート／ドライブを狙い、カットも積極的に走る。" },
  { key: "mental", label: "MTL", name: "精神",
    tip: "疲れているとき・負けているとき・4Q終盤の接戦での強さ。80が基準で、低いほどその状況で精度が落ち、80より高い選手はむしろ精度が上がる（クラッチ性能）。" },
  { key: "teamwork", label: "TWK", name: "連携",
    tip: "チーム戦術の遂行度。高いほどチーム戦術（ペース・3P志向・ヘルプ等の方針）に忠実にプレーする。" },
];

// ---------------------------------------------------------------------------
// Special abilities (特殊能力) — boolean per player. Each one biases a specific
// behaviour in game.ts; a player either has it or doesn't.
// ---------------------------------------------------------------------------
export type AbilityKey =
  | "driver" | "keepDribble" | "positioning" | "leakOut" | "general"
  | "throughPass" | "striker" | "isoShooter" | "post" | "lineMove"
  | "range" | "sideSpot" | "centerSpot" | "ftKicker" | "oneTouch"
  | "outside" | "manMark" | "interceptor" | "covering" | "dfLine" | "longThrow";

export const ABILITY_META: { key: AbilityKey; label: string; tip: string }[] = [
  { key: "driver", label: "スラッシャー", tip: "ドリブルでリムへ切り込む意識が高い。ドライブを積極的に選ぶ。" },
  { key: "keepDribble", label: "ボールキープ", tip: "ドリブルでキープしチーム全体の動きを整える。保持中はスティールされにくく、味方の動き直しが速くなり、攻め急がない。" },
  { key: "positioning", label: "オフボール", tip: "オフェンス時に良いポジションを取る。空いたスポットを的確に選び、動き直しも速い。" },
  { key: "leakOut", label: "速攻", tip: "トランジションの瞬間、真っ先に相手ゴールへ走り出す（リークアウト）。" },
  { key: "general", label: "フロアジェネラル", tip: "チーム全体のポジショニングがよくなる。味方全員の動き直しが速く・的確になる。" },
  { key: "throughPass", label: "ディッシュ", tip: "イージーシュートを生むラストパス（カッターへのフィード）を高精度で出せる。" },
  { key: "striker", label: "スコアラー", tip: "得点を取る意識が高い。オフェンス優先度とシュート欲求が上がる。" },
  { key: "isoShooter", label: "アイソレーション", tip: "相手が1人ついていてもシュートまでもっていける。単独マーク相手ならコンテストの影響が大きく減る。" },
  { key: "post", label: "ポストアップ", tip: "ポストプレイが上手い。PF/C以外でもポストアップでき、ゴールへの押し込み・キープが強くなる。" },
  { key: "lineMove", label: "カッティング", tip: "ゴール付近でとっさに動いてマークを置き去りにするのが得意。カットが速く、頻度も上がる。" },
  { key: "range", label: "ロングレンジ", tip: "3Pやミドルシュートをより広範囲から打てる。射程が伸び、距離による精度低下も小さい。" },
  { key: "sideSpot", label: "コーナー", tip: "コーナー待機などコートの両サイドにポジションを取りやすい。" },
  { key: "centerSpot", label: "ペイント", tip: "ゴール下などペイント付近にポジションを取りやすく、リバウンドにも強く絡む。" },
  { key: "ftKicker", label: "FTシューター", tip: "フリースローの精度が高い（成功率+8%）。" },
  { key: "oneTouch", label: "キャッチ&シュート", tip: "パスを受けてからのプレーが速く正確。キャッチ直後の判断が速く、キャッチ&シュートの精度が上がる。" },
  { key: "outside", label: "ノールック", tip: "体の向きに縛られない広い範囲へパスの選択肢がある。際どいコースでもカットされにくい。" },
  { key: "manMark", label: "ロックダウン", tip: "対面のマークが上手い。距離を詰め、抜かれにくく、反応も速い。" },
  { key: "interceptor", label: "パスカット", tip: "パスを読んで奪うのが上手い。パスカットとリーチインの成功率が上がり、ロングパスへいち早く反応して飛び出す。" },
  { key: "covering", label: "ヘルプディフェンス", tip: "抜かれた味方のカバーが上手い。マークを捨ててドライブコースへ先回りする。" },
  { key: "dfLine", label: "守備司令塔", tip: "味方全体の守備位置を指示し補正する。チーム全員の守備反応とヘルプ位置が良くなる。" },
  { key: "longThrow", label: "アウトレット", tip: "インバウンドパスを遠くまで速く投げられる。ロングアウトレットで速攻の起点になる。" },
];

export interface PlayerDef {
  name: string;
  role: string;       // PG / SG / SF / PF / C
  height: number;     // metres — 身長。リバウンド・ブロック・ゴール下の届く高さに影響
  attr: Attributes;
  abilities?: AbilityKey[]; // 特殊能力 — 持っているものだけ列挙
  priority?: number;  // explicit offensive priority 0..1 (overrides the role/skill default)
}

// ---------------------------------------------------------------------------
// Team tactics (0..1 each). These bias every player's individual judgement and
// the team's defensive positioning. How faithfully an individual follows the
// plan is his 連携 (teamwork) rating.
// ---------------------------------------------------------------------------
export interface Tactics {
  offense: {
    pace: number;         // low = work the clock, high = shoot early / push
    threeBias: number;    // preference for three-point shots
    driveBias: number;    // preference for attacking the rim
    ballMovement: number; // pass-and-move vs isolation
  };
  defense: {
    pressure: number;     // tight on-ball pressure (closer, gambles more)
    help: number;         // how much off-ball defenders sag to protect the paint
  };
}

// Indexed by team. Two distinct identities so the tactical effect is visible.
export const TACTICS: Tactics[] = [
  // Team 0 — BLAZE: deliberate, attack inside, conservative help defence
  { offense: { pace: 0.35, threeBias: 0.30, driveBias: 0.65, ballMovement: 0.55 },
    defense: { pressure: 0.40, help: 0.70 } },
  // Team 1 — WAVE: fast pace, three-happy, aggressive on-ball pressure
  { offense: { pace: 0.80, threeBias: 0.75, driveBias: 0.45, ballMovement: 0.65 },
    defense: { pressure: 0.80, help: 0.40 } },
];

/** Map a 0..100 rating to a 0..1 factor. */
export const rate = (r: number): number => clamp(r, 0, 100) / 100;

// ---------------------------------------------------------------------------
// Role-based offensive identity. `scoreBase` is how much of a scoring option the
// position usually is (the go-to scorers are the wings/2-guard); `playmaking` is
// how much the position brings the ball up and sets others up (the point guard).
// A player's individual ratings then nudge these per person.
// ---------------------------------------------------------------------------
const ROLE_OFFENSE: Record<string, { scoreBase: number; playmaking: number }> = {
  PG: { scoreBase: 0.55, playmaking: 1.00 },
  SG: { scoreBase: 0.85, playmaking: 0.55 },
  SF: { scoreBase: 0.80, playmaking: 0.45 },
  PF: { scoreBase: 0.55, playmaking: 0.30 },
  C:  { scoreBase: 0.45, playmaking: 0.25 },
};
export function roleOffense(role: string): { scoreBase: number; playmaking: number } {
  return ROLE_OFFENSE[role] ?? { scoreBase: 0.6, playmaking: 0.4 };
}

// A player's scoring-option weight (0..1). An explicit `priority` on the def
// wins (so it can be set in the pre-game editor); otherwise it's derived from
// the position baseline nudged by the player's scoring ratings.
export function computeOffPriority(def: PlayerDef): number {
  if (def.priority !== undefined) return clamp(def.priority, 0, 1);
  const ro = roleOffense(def.role);
  const a = def.attr;
  const scoringSkill = (rate(a.aggression) + rate(a.threeAcc) + rate(a.midAcc)) / 3;
  let base = ro.scoreBase * 0.65 + scoringSkill * 0.35;
  if (def.abilities?.includes("striker")) base += 0.12;  // ストライカー: the go-to guy
  return clamp(base, 0, 1);
}

// Shorthand to keep the roster table readable — args follow ATTR_META order.
const A = (
  offense: number, defense: number, balance: number, stamina: number,
  speed: number, accel: number, reaction: number, agility: number,
  dribbleAcc: number, dribbleSpd: number, passAcc: number, passSpd: number,
  threeAcc: number, threeRange: number, midAcc: number, shotStrength: number,
  shotTech: number, freeThrow: number, bank: number, dunk: number,
  jump: number, handling: number, aggression: number, mental: number, teamwork: number,
): Attributes => ({
  offense, defense, balance, stamina, speed, accel, reaction, agility,
  dribbleAcc, dribbleSpd, passAcc, passSpd, threeAcc, threeRange, midAcc,
  shotStrength, shotTech, freeThrow, bank, dunk, jump, handling, aggression,
  mental, teamwork,
});

const MIN = A(10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10);
const MAX = A(99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99);

// NBA-style 13-man roster indexed [team][idx]: idx 0..4 = starters
// (PG, SG, SF, PF, C), idx 5..12 = the 8-man bench (a full second unit
// PG/SG/SF/PF/C plus a third guard, wing and big).
// NOTE: test setup — RED (BLAZE) is every attribute at the floor, BLUE (WAVE)
// at the ceiling, so the effect of attributes is obvious. Re-tune for a real game.
export const STARTERS = 5;
export const ROSTER_SIZE = 13;
const BENCH_ROLES = ["PG", "SG", "SF", "PF", "C", "SG", "SF", "PF"];

const mk = (name: string, role: string, height: number, attr: Attributes): PlayerDef =>
  ({ name, role, height, attr });

export const ROSTER: PlayerDef[][] = [
  [ // Team 0 — BLAZE (RED) — minimum everything
    mk("Vega",  "PG", 1.85, { ...MIN }),
    mk("Knox",  "SG", 1.85, { ...MIN }),
    mk("Reed",  "SF", 1.85, { ...MIN }),
    mk("Boone", "PF", 1.85, { ...MIN }),
    mk("Sato",  "C",  1.85, { ...MIN }),
    ...["Cole", "Duke", "Finn", "Gray", "Hale", "Iker", "Judd", "Kane"]
      .map((n, i) => mk(n, BENCH_ROLES[i], 1.85, { ...MIN })),
  ],
  [ // Team 1 — WAVE (BLUE) — maximum everything
    mk("Ito",    "PG", 2.10, { ...MAX }),
    mk("Lang",   "SG", 2.10, { ...MAX }),
    mk("Cruz",   "SF", 2.10, { ...MAX }),
    mk("Diaz",   "PF", 2.10, { ...MAX }),
    mk("Okafor", "C",  2.10, { ...MAX }),
    ...["Pena", "Quon", "Ross", "Silva", "Tate", "Umar", "Vidal", "Webb"]
      .map((n, i) => mk(n, BENCH_ROLES[i], 2.10, { ...MAX })),
  ],
];
