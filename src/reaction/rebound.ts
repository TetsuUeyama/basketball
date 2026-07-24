// ルーズボール/リバウンドの「効果」= 確保成功率の算出（判定ルール）。抽選(chance)と
// 確保時/はじき時の処理は game.ts 側に残す。純粋関数のみ。
import { Player } from "../objects/player/player";
import { rate } from "../attributes";
import { clamp } from "../util";

// ルーズボールに触れた選手がそのまま確保する確率。ジャンプ/反応/バランスのリバウンド
// 技量＋身長で上がり、守備側はボックスアウト分の補正。何度も弾き続けないよう、既に
// 3回以上はじかれていたら必ず確保(1)。defending=p が守備側(looseOff と別)か。
export function looseSecureChance(p: Player, defending: boolean, looseTips: number): number {
  const rebSkill = rate(p.attr.jump) * 0.3 + rate(p.attr.reaction) * 0.25
    + rate(p.attr.balance) * 0.2;
  const heightEdge = clamp((p.height - 1.95) * 0.25, -0.1, 0.12);
  let secure = 0.28 + rebSkill * 0.55 + heightEdge;
  if (defending) secure += 0.05 + rate(p.attr.defense) * 0.06;  // ボックスアウト
  if (looseTips >= 3) secure = 1;      // ピンボール化させない
  return clamp(secure, 0.1, 0.96);
}
