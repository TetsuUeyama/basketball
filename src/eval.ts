// 純粋な「評価プリミティブ」群 — コンテストの質、シュート射程、反応時間、溜め時間
// などを算出する。ゲーム状態は一切持たず、入力は全て引数で受け取る。これにより
// 認知層(decide*)と効果層(シュート成否・コンテスト)が同一の計算式を共有できる。
// game.ts からレイヤ分割の第一弾として抽出（workPlan.md 参照）。
import { Player } from "./player";
import { RIM, THREE_DIST } from "./config";
import { rate } from "./attributes";
import { clamp, rand } from "./util";

// L速度(3P射程)の基準点: 75 → 3Pライン、95 → センターライン（これが上限）。
const SHOOT_ARC = THREE_DIST;   // 6.75m（3Pライン）
const SHOOT_HALF = RIM.z;       // 13.0m（リング→センターライン）

// この守備者が「このシューター」に対してどれだけリムを守れるか — ロールラベルに
// 依らず、位置と体格のみ: シューターに対する高さ、ヘッド(リム保護)、ジャンプ、守備。
// 長身のショットブロッカーは高スコア、スイッチした小さいガードは低スコア。平均的な
// コンテストが ≈0 になるよう中心化。
export function rimProtect(d: Player, shooter: Player): number {
  return clamp(
    (d.height - shooter.height) * 0.5
    + rate(d.attr.dunk) * 0.35            // ヘッド = リム保護 / ショットブロック
    + rate(d.attr.jump) * 0.25
    + rate(d.attr.defense) * 0.35
    - 0.505,                              // 基準: 平均的なコンテストが0付近になるよう
    -0.4, 0.6);
}

// この守備者がジャンパーをどれだけコンテストできるか — クローズアウトの速さ(反応/敏捷)、
// 守備、わずかな高さ。平均的なコンテストが ≈0 になるよう中心化。
export function perimContest(d: Player, shooter: Player): number {
  return clamp(
    rate(d.attr.reaction) * 0.35 + rate(d.attr.agility) * 0.3 + rate(d.attr.defense) * 0.5
    + (d.height - shooter.height) * 0.15
    - 0.64,
    -0.35, 0.4);
}

// 手のひらの「当たり判定」半径(m): 基準 + (守備者の守備 − 攻撃者のオフェンス)。
// 守備者が上なら大きく、攻撃者が上回れば小さくなる。
export function palmRadius(def: Player, att: Player): number {
  return clamp(1.5 + 1.7 * (rate(def.attr.defense) - rate(att.attr.offense)), 0.5, 2.6);
}

// 連携: チーム戦術をどれだけ忠実に遂行するか — 判断内の戦術由来の項に掛ける係数。
export function twWeight(p: Player): number {
  return 0.35 + rate(p.attr.teamwork) * 0.65;
}

// この守備者が攻撃アクションに「反応」するまでの時間(秒) — 守備(ディフェンス)と
// レスポンス(反応)が等しく効き、両方エリートで ≈0.2秒、両方低いと ≈1.2秒、
// 小さな揺らぎ付き。
export function reactionLag(p: Player): number {
  const ability = (rate(p.attr.defense) + rate(p.attr.reaction)) / 2;   // 1 = 両方エリート
  return clamp((0.2 + (1 - ability) * 1.0) * rand(0.9, 1.1), 0.2, 1.2);
}

// L速度(3P射程) → この選手が無理なく打てる距離。75=3Pライン、95=センターライン(上限)。
// 75未満は快適射程がライン内側に入る(それより外も打てるが溜め時間が要る — gatherFor 参照)。
export function shootRangeOf(p: Player): number {
  const r = SHOOT_ARC + (p.attr.threeRange - 75)
    * (SHOOT_HALF - SHOOT_ARC) / 20;   // 75→ライン, 95→ハーフ, 線形
  return clamp(r, 4.5, SHOOT_HALF) + (p.has("range") ? 1.0 : 0);
}

// 快適射程を超えた距離から打つのに必要な溜め(秒): shootRangeOf を超えるほど長くなる。
export function gatherFor(p: Player, dHoop: number): number {
  const over = dHoop - shootRangeOf(p);
  return over <= 0 ? 0 : over * 0.22;   // 射程超過1mあたり約0.22秒
}

// ディープ3の資格: L精度とL速度がともに90以上のエリートだけがラインの遥か外から
// 放つ価値がある。それ以外の深い3は確率を捨てるだけ。
export function deepThreeOK(p: Player): boolean {
  return p.attr.threeAcc >= 90 && p.attr.threeRange >= 90;
}

// エリート(90/90)はラインの遥か外まで射程。それ以外は全員ライン際(THREE_DIST+0.5)までは
// オープンなら打つ（深いヒーブはエリート限定）。
export function effShootRange(p: Player): number {
  const r = shootRangeOf(p);
  if (deepThreeOK(p)) return r;
  return THREE_DIST + 0.5;
}

// この選手がこのシュートで要する溜め時間(リリース前のオーバーヘッドの構え)。
export function shotWindupFor(h: Player, dHoop: number): number {
  let w = 0.16 + gatherFor(h, dHoop) + (1 - rate(h.attr.shotTech)) * 0.12;
  if (h.quickT > 0 && h.has("oneTouch")) w *= 0.55;   // ダイレクト: クイックリリース
  return w;
}

// 打つべきでないシュート: 長い溜めをしている最中に守備者が射程内にいると、上がる前に
// 剥がされ/ブロックされる可能性が高い。
export function wontLoadUp(h: Player, dHoop: number, dDef: number): boolean {
  return shotWindupFor(h, dHoop) > 0.45 && dDef < 1.7 && h.beatenT <= 0;
}

// ドリブルの揺さぶり量: 敏捷性/D精度/技術＋ドリブラー特能（攻め側の deception）。
export function jukeDeception(h: Player): number {
  return rate(h.attr.agility) * 0.45 + rate(h.attr.dribbleAcc) * 0.4
    + rate(h.attr.handling) * 0.15 + (h.has("driver") ? 0.1 : 0);
}

// 守備が前に留まり食いつかない度合い: 守備＋バースト（守り側の discipline）。
export function jukeDiscipline(d: Player): number {
  return rate(d.attr.defense) * 0.4 + rate(d.attr.agility) * 0.35
    + rate(d.attr.reaction) * 0.25 + (d.has("manMark") ? 0.1 : 0);
}

// 剥がしの優位度 = 守備の手(反応/敏捷/守備＋スライディング) − ハンドラーの保持力
// (D精度/技術＋ドリブルキープ)。正なら守備有利。スティール/ディグ確率のベースに使う。
export function stripEdge(d: Player, h: Player): number {
  const hands = rate(d.attr.reaction) * 0.45 + rate(d.attr.agility) * 0.35 + rate(d.attr.defense) * 0.2
    + (d.has("interceptor") ? 0.15 : 0);
  const secure = rate(h.attr.dribbleAcc) * 0.62 + rate(h.attr.handling) * 0.38
    + (h.has("keepDribble") ? 0.28 : 0);
  return hands - secure;
}
