// ファウルの「効果」= 発生確率の算出（判定ルール）。抽選(chance)と発生時の処理
// (フリースロー移行・演出など)は game.ts 側に残す。純粋関数のみ。
import { Player } from "../../objects/player/player";
import { clamp, dist2D } from "../../util";

// シューティングファウルの発生確率。レイアップは接触が多く、密着コンテストほど増える。
// 早跳びして空中にいる守備者はシューターに突っ込みやすい。
export function shootingFoulChance(
  h: Player, dDef: number, layup: boolean, onBallDef: Player | undefined,
): number {
  let base = layup ? 0.20 : 0.05;
  if (onBallDef && onBallDef.airborne && dist2D(onBallDef.pos, h.pos) < 1.3) base += 0.08;
  return base * clamp(1.3 - dDef, 0, 1.3);   // 密着ほど接触が増える
}

// リーチイン（守備の手が出て起こすファウル）の毎秒発生レート。呼び出し側で dt を
// 掛けて抽選する。press=守備の圧力、close=密着度。
export function reachInFoulRate(press: number, close: number): number {
  return (0.02 + press * 0.045) * close;
}
