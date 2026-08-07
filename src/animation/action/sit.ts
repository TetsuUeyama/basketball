// 着席/起立（ベンチ）アクションの姿勢アニメ。脚は basic/ の JOINT・setJoint、
// 腕は basic/arms のムーバ経由で動く。寸法はボクセル素体の実測値（vox）から解く。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";
import { setPlayerShadow } from "../../scene-setup";
import { clamp } from "../../util";
import { JOINT, MOVE_RATE } from "../basic/joints";
import { setJoint } from "../basic/rotate";

declare module "../../objects/player/player" {
  interface Player {
    seatHipY(): number;
    foldSeatedLegs(): void;
    seatedHands(): void;
    sit(): void;
    stand(): void;
  }
}

/** 着席時の股関節の高さ（座面の天面に尻を置く）。sync が root を下げる基準と同じ値。 */
Player.prototype.seatHipY = function(): number {
  return Player.SEAT_HIP;
};

  // 腿を前（体の正面 = コート側）へ水平に畳み、脛を倒して足首を立位と同じ高さ（床）へ
  // 着ける。脛の長さは選手ごとに違うので、垂直に下ろすだけだと長身は床へめり込む
  // （実測: 6〜16cm）。倒す角は 脛の垂直成分 = 股の高さ − 立位の足首高 から解く。
Player.prototype.foldSeatedLegs = function(): void {
    const ns = this.numberSide;
    const shin = this.vox ? this.vox.kneeY - this.vox.ankleY : Player.HIP_Y * 0.45;
    const ankle = this.vox ? this.vox.ankleY : 0.12;
    const drop = clamp((this.seatHipY() - ankle) / Math.max(0.05, shin), -1, 1);
    const tilt = Math.acos(drop);          // 脛を垂直から前へ倒す角（脛が短いほど大きい）
    setJoint(this.hipL, JOINT.hip, Player.SIT_HIP * ns);
    setJoint(this.hipR, JOINT.hip, Player.SIT_HIP * ns);
    setJoint(this.kneeL, JOINT.knee, -(Math.PI / 2 - tilt) * ns);
    setJoint(this.kneeR, JOINT.knee, -(Math.PI / 2 - tilt) * ns);
};

/** 着席時の手: 前腕を腿の上に置く。体側に垂らすと座面／背もたれに埋まる。
 *  ⚠️ 基準は root のヨー（＝畳んだ脚の向き）。胸のツイストを混ぜるとボールを追った
 *  ぶんだけ手が横へ流れ、またベンチへ入る。 */
Player.prototype.seatedHands = function(): void {
    const th = this.root.rotation.y, s = this.numberSide;
    const fx = -s * Math.sin(th), fz = -s * Math.cos(th);   // 腿が伸びる方向
    const rx = Math.cos(th), rz = -Math.sin(th);            // 体の右（ローカル+X）
    const cx = this.pos.x + fx * 0.30, cz = this.pos.z + fz * 0.30;   // 腿の中ほど
    const y = this.seatHipY() + 0.10;                       // 腿の上面
    this.armRateCap = MOVE_RATE.arm;
    for (const [pivot, elbow, side] of [
      [this.armPivotR, this.elbowR, 1], [this.armPivotL, this.elbowL, -1],
    ] as const) {
      const t = new Vector3(cx + rx * 0.16 * side, y, cz + rz * 0.16 * side);
      if (!this.reachIK(pivot, elbow, t)) { this.aimArm(pivot, t); this.bendElbow(elbow, 0.9); }
    }
    this.armRateCap = 0;
};

  // ベンチへの着席 / 起立。着席はリグ全体を下げて腰を座面に
  // 合わせ、脚を畳む（太ももを前、脛を下）。起立は歩行サイクルへ
  // 戻す。
Player.prototype.sit = function(): void {
    this.seated = true;
    this.resetTwist();   // ベンチに正対して座る
    this.foulReactT = 0;
    this.defWinT = 0;
    this.flinchPitch = 0;
    this.foldSeatedLegs();
    this.seatedHands();
    setPlayerShadow(this, false);   // ベンチは影を落とさない（描画量の57%がベンチのため）
};

Player.prototype.stand = function(): void {
    if (!this.seated) return;
    this.seated = false;
    this.root.rotation.x = 0;
    this.hipL.rotation.x = this.hipR.rotation.x = 0;   // 脚が真っ直ぐになる
    this.kneeL.rotation.x = this.kneeR.rotation.x = 0;
    setPlayerShadow(this, true);
};
