// 守備の共有部品: エフォート/DENY強度/ゲットバック。オンボール・オフボール・スキームの
// すべてから参照される葉モジュール（ここから他の守備モジュールを import しない）。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";
import { RIM } from "../../config";
import { clamp, dist2D, moveToward2D } from "../../util";
import type { Game } from "../../game";

// この守備者が今どれだけ守備で動くか(0..1)。
export function defEffort(game: Game, d: Player, protect: Vector3): number {
  if (game.quarter >= 4 && Math.abs(game.score[0] - game.score[1]) <= 6) return 1;   // 終盤接戦
  if (d.lockDef) return 1;                                  // 常時全力ロール
  const nearGoal = clamp(1 - dist2D(d.pos, protect) / 9, 0, 1); // リムで1
  // 守備ロールのギア(優先)
  if (d.defEffortGear !== undefined) {
    return clamp(d.defEffortGear + (1 - d.defEffortGear) * nearGoal, 0, 1);
  }
  // フォールバック(defRole未設定): スターは少し流す
  if (d.evalRole === "ロックダウン" || d.evalRole === "スイッチディフェンダー"
    || d.evalRole === "エナジーガイ" || d.evalRole === "3&D") return 1;
  const star = clamp((d.offPriority - 0.45) / 0.4, 0, 1);  // 0=ロール .. 1=スター
  if (star <= 0) return 1;
  const e = 0.68 + (0.9 - 0.68) * nearGoal;   // 流し 0.68 .. ゴール前 0.9
  return 1 - star * (1 - e);
}

// 今どれだけシュートを DENY しているか: ショットクロック終盤ほど deny 戦術値へ近づく。
export function denyIntensity(game: Game, defTeam: number): number {
  const t = Math.max(game.tactics[defTeam].defense.deny, 0.12);
  if (!game.frontT) return 0;
  const late = game.shotClock < 4.5 ? (4.5 - game.shotClock) / 4.5 : 0;
  return t * late;
}

// 強い deny でハンドラーが覆われ、綺麗に撃てない状態か。
export function denySmother(game: Game, h: Player, dDef: number): boolean {
  return denyIntensity(game, 1 - h.team) > 0.18 && dDef < 1.0;
}

// トランジション — まず戻る: 上に残っていた守備者が担当より先に自陣へ全力で戻る。ビッグはリム最優先。
// このフレームの移動を処理したら true。
export function getBackOnDefense(game: Game, dt: number, d: Player, man: Player): boolean {
  const s = game.attackSign(game.possession);  // 守備の自陣: z*s > 0
  const upCourt = d.pos.z * s < 0.5;           // まだハーフを越えていない
  const manBack = man.pos.z * s < 0.5;         // …担当も
  // 取り残された: (a) ボールが自分より自陣リム寄り＝抜かれてボールの後ろに取り残された、または
  // (b) 担当マンから大きく離れマークしていない(プレス/トラップで離れた)。どちらも全力で自陣へ戻る。
  const h = game.handler;
  const behindBall = !!h && s * h.pos.z > s * d.pos.z + 2.5;
  const offMan = dist2D(d.pos, man.pos) > 5;
  const stranded = upCourt && (behindBall || offMan);   // バックコート側に取り残された時だけ(ハーフコートの通常守備では発火しない)
  if (game.isBig(d) && (upCourt || manBack || stranded)) {
    const depth = d.role === "C" ? 1.6 : 3.0;
    const tz = s * (RIM.z - depth);
    const gb = game.steerAround(d, 0, tz);   // 体を避けて全力で戻る
    moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.15) * dt);
    game.clampCourt(d.pos);
    return true;
  }
  if (upCourt || stranded) {
    const gb = game.steerAround(d, man.pos.x * 0.4, s * (RIM.z - 7));
    moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.12) * dt);
    game.clampCourt(d.pos);
    return true;
  }
  return false;
}
