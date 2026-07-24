// ブロックの「効果」= 誰がどれだけ止められるか、をかわせるか、の確率算出（判定ルール）。
// 状態は変更しない純粋関数。抽選(chance)と状態変更(evade/jump/shotMade)は game.ts 側に残す。
import { Player } from "../player";
import { rate } from "../attributes";
import { clamp, dist2D } from "../util";
import { palmRadius } from "../eval";

// このショットを最も止められる守備者とそのブロック確率を返す（抽選はしない）。
// isFinish=リム下フィニッシュか / shotWindup=溜め時間 / palmHitbox=手のひら判定モデルの有効フラグ。
export function bestBlocker(
  defenders: Player[], shooter: Player, isFinish: boolean,
  shotWindup: number, palmHitbox: boolean,
): { def: Player; p: number } | null {
  const baseRange = isFinish ? 2.1 : 1.7;
  // 長い溜め（深い遠投 / 遅く低S技術のリリース）は格好の的: 守備は構えて跳べるので
  // 溜めに応じてブロック確率が上がる。素早いキャッチ&シュートはほぼ窓を与えない。
  const windupEdge = isFinish ? 0 : clamp(shotWindup - 0.3, 0, 0.8);
  let best: Player | null = null;
  let bestP = 0;
  for (const d of defenders) {
    const dd = dist2D(d.pos, shooter.pos);
    // スワットのリーチ = この守備者の手のひら当たり判定（守備 vs シューターのオフェンスで
    // サイズ可変）。上回るリムプロテクターは遠くから届く。動作ごとにスケール、無効時は固定。
    const range = palmHitbox
      ? (isFinish ? 1.35 : 1.05) * palmRadius(d, shooter)
      : baseRange;
    if (dd > range) continue;
    const blk = isFinish
      ? rate(d.attr.jump) * 0.4 + rate(d.attr.dunk) * 0.35 + rate(d.attr.defense) * 0.25
      : rate(d.attr.jump) * 0.42 + rate(d.attr.reaction) * 0.3 + rate(d.attr.defense) * 0.28;
    const close = 1 - dd / range;              // 1 = 密着, 0 = 端
    // 身長は本物のリム保護のエッジ: 長さが低い守備の届かないショットを叩く
    const heightAdv = clamp((d.height - shooter.height) * 0.9, -0.25, 0.4);
    let p = (isFinish ? 0.30 : 0.23) * (0.2 + blk * 1.35) * close + heightAdv * close;
    p += windupEdge * (0.18 + blk * 0.2) * close;   // 遅い溜めほど止められやすい
    // 既に空中（溜めを読んで跳ね上がった）: 手がシュートポケットの真上でピーク
    if (d.airborne) p += 0.18 * close;
    // …早く跳びすぎた男は落ち/構え直し中で、ほぼコンテストにならない（ギャンブルの裏目）
    else if (d.landT > 0) p *= 0.3;
    // 弾道高さ: 高い虹のジャンパーはコンテストを越え、フラットは叩かれる（リム下は別動作で対象外）
    if (!isFinish) p *= clamp(1.5 - rate(shooter.attr.bank), 0.5, 1.5);
    p = clamp(p, 0, 0.7);
    if (p > bestP) { bestP = p; best = d; }
  }
  return best ? { def: best, p: bestP } : null;
}

// イベイド（ダブルクラッチ）でブロックをかわす確率 — フィニッシュ限定。S技術(空中で
// 打ち直す技巧)＋敏捷性が高いほど成功し、ブロッカーのヘッドと身長差が高い壁になる。
export function evadeBlockProbability(shooter: Player, blocker: Player): number {
  return clamp(
    rate(shooter.attr.shotTech) * 0.5 + rate(shooter.attr.agility) * 0.25
    - rate(blocker.attr.dunk) * 0.2
    - Math.max(0, blocker.height - shooter.height) * 0.5
    - 0.12,
    0.03, 0.7);
}
