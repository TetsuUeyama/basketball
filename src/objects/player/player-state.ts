// 選手の状態リセットとコンディション回復（ボックススコア/スタミナ）。
// プロトタイプ拡張で Player に紐づけ。
import { Quaternion } from "@babylonjs/core";
import { rate } from "../../util";
import { HUD_OPTS } from "../../config";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    resetStats(): void;
    resetPose(): void;
    benchRecover(dt: number): void;
    breakRecover(amount: number): void;
  }
}

/** この選手のボックススコアとコンディションをゼロにする（試合開始）。 */
Player.prototype.resetStats = function(): void {
  const s = this.stats;
  s.pts = s.reb = s.ast = s.stl = s.blk = s.tov = s.fgm = s.fga = s.min = 0;
  s.tpm = s.tpa = s.ftm = s.fta = 0;
  this.fatigue = 0;
  this.curSpd = 0;
  this.stintT = 0;
};

/** アクション/アニメの一時状態を全て初期化し、直立の休めポーズへ戻す（試合開始/リスタート時）。
 *  前試合のジャンプ・腕の角度・リアクション等が残らないようにする。 */
Player.prototype.resetPose = function(): void {
  // ジャンプ/着地
  this.jumpRemaining = 0; this.jumpDur = 0; this.jumpHeight = 0;
  this.landT = 0; this.leapX = 0; this.leapZ = 0;
  // リアクション/ひるみ
  this.foulReactT = 0; this.defWinT = 0;
  this.flinchPitch = 0; this.flinchRoll = 0;
  this.foulStumble = false; this.foulStaggerX = 0; this.foulStaggerZ = 0;
  // 1対1/ドリブル/クールダウンの一時状態
  this.beatenT = 0; this.powerT = 0; this.jukeT = 0; this.stalledT = 0;
  this.plantT = 0; this.rootT = 0; this.reactT = 0; this.coolT = 0; this.gatherT = 0;
  this.pickupT = 0; this.quickT = 0; this.baitT = 0; this.wallT = 0;
  this.reboundGo = false; this.reboundPutback = false; this.grabTwoHand = true;
  this.postT = 0;
  this.keepShieldT = 0; this.lean = 0;
  this.cutting = false; this.screening = false; this.benchClapT = 0;
  this.shakeOpenT = 0; this.shakeT = 0;
  this.shootLoad = 0; this.shootLoadTarget = 0;   // シュート溜めの前傾/沈み込み
  this.frontRunT = 0;                              // スローイン後の前進
  // アクション3段階
  this.actKind = ""; this.actPhase = ""; this.actT = 0; this.actFired = false;
  // 腕を即座に休めへ（イーズを介さず直接セット）
  this.armPivotL.rotationQuaternion = Quaternion.Identity();
  this.armPivotR.rotationQuaternion = Quaternion.Identity();
  this.armPivotL.scaling.set(1, 1, 1); this.armPivotR.scaling.set(1, 1, 1);
  this.elbowL.rotationQuaternion = null; this.elbowR.rotationQuaternion = null;
  this.elbowL.rotation.set(0.28 * this.numberSide, 0, 0);
  this.elbowR.rotation.set(0.28 * this.numberSide, 0, 0);
  // 脚を直立へ
  this.hipL.rotation.x = this.hipR.rotation.x = 0;
  this.kneeL.rotation.x = this.kneeR.rotation.x = 0;
  this.stridePhase = 0;
};

/** ベンチに座る: ゆっくりとした着実な回復（即座の全回復ではない） —
 *  高いスタミナ能力値は出場間の回復も速いことを意味する。 */
Player.prototype.benchRecover = function(dt: number): void {
  const rec = 0.002 + rate(this.attr.stamina) * 0.004;   // ~0.0024 .. ~0.006 /秒
  this.fatigue = Math.max(0, this.fatigue - rec * dt);
  if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
};

/** ピリオドの区切り（クォーター休憩/ハーフタイム）での一度きりの回復分。 */
Player.prototype.breakRecover = function(amount: number): void {
  this.fatigue = Math.max(0, this.fatigue - amount);
  if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
};
