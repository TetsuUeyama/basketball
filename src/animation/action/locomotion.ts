// 歩く/走るアクションのアニメ: 腕振り(runArms)と脚の運び(updateLegs)。
// basic/ の部位ルール（JOINT・setJoint・腕ムーバ）の中で動く。
import { Vector3, Quaternion } from "@babylonjs/core";
import { Player } from "../../objects/player/player";
import { JOINT } from "../basic/joints";
import { setJoint } from "../basic/rotate";

declare module "../../objects/player/player" {
  interface Player {
    runArms(): void;
    updateLegs(dt: number): void;
  }
}

/** 歩調（1秒あたりの位相の進み / 移動速度）。1周期 = 2π = 一歩の往復。
 *  腕の振りとモーションクリップの脚が同じ値を見るので、ここだけで速さが決まる。 */
export const CADENCE = 1.7;

// ボールをハンドリングしていない選手の腕。前へ走るとストライドに合わせて前後に
// 振る（同じ側の脚と逆位相、肘は曲げたまま）。バックペダル（胸の向きに逆らって
// 動く — 後退する守備者）ではバランスポーズに切り替わる: 両腕を低く少し前へ出し、
// 足に合わせてはためく。歩行/静止では休める。poseHands()が全員にこれを呼び、
// その後でボールの腕を上書きする。
Player.prototype.runArms = function(): void {
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    if (frac < 0.16) { this.backArms = false; this.handsRest(); return; }
    const ns = this.numberSide;
    // 胸の向き（ローカル -ns·Z、root と胴のツイスト両方でヨー）に対する計測速度:
    // 明確に負 = 後ろ向きに走っている
    const th = this.root.rotation.y + this.torsoTwist;
    const chestX = -ns * Math.sin(th), chestZ = -ns * Math.cos(th);
    const along = this.velX * chestX + this.velZ * chestZ;   // 胸方向への m/s
    this.backArms = this.backArms ? along < -0.2 : along < -0.6;
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
    if (this.backArms) {
      const fl = Math.sin(this.stridePhase) * 0.2;   // 小さく交互に揺らす
      this.setArmDir(this.armPivotL, -0.6, -0.85 + fl, -ns * 0.3);
      this.setArmDir(this.armPivotR, 0.6, -0.85 - fl, -ns * 0.3);
      this.bendElbow(this.elbowL, 0.2);              // ほぼ真っ直ぐ、手は構え
      this.bendElbow(this.elbowR, 0.2);
      return;
    }
    const amp = 0.3 + frac * 0.55;
    const aL = Math.sin(this.stridePhase + Math.PI) * amp * ns;   // 左腕 ↔ 右脚
    const aR = Math.sin(this.stridePhase) * amp * ns;
    this.easeArm(this.armPivotL, Quaternion.RotationAxis(new Vector3(1, 0, 0), aL));
    this.easeArm(this.armPivotR, Quaternion.RotationAxis(new Vector3(1, 0, 0), aR));
    const carry = 0.6 + frac * 0.5;   // ランナーのように肘を曲げて保つ
    this.bendElbow(this.elbowL, carry);
    this.bendElbow(this.elbowR, carry);
};

  // 歩行/走行サイクルの1フレーム: 速度とともに伸びるストライドで腰を
  // 前後に振り（脚ごとに逆位相）、前方への振りで膝を曲げる。歩行ペース
  // 未満では脚は真っ直ぐへイーズで戻る。着席中は静止させる
  // (ポーズは sit() が管理)。
Player.prototype.updateLegs = function(dt: number): void {
    if (this.seated) return;
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    if (frac < 0.04) {
      this.stridePhase = 0;
      const ease = Math.min(1, dt * 12);
      this.hipL.rotation.x += -this.hipL.rotation.x * ease;
      this.hipR.rotation.x += -this.hipR.rotation.x * ease;
      this.kneeL.rotation.x += -this.kneeL.rotation.x * ease;
      this.kneeR.rotation.x += -this.kneeR.rotation.x * ease;
      return;
    }
    // 距離ベース → 速度がケイデンスを決める。腕の振り(runArms)とクリップの脚
    // (voxel-motion)の両方がこの位相を見るので、歩調はここ1か所で決まる。
    this.stridePhase += this.curSpd * dt * CADENCE;
    const amp = 0.32 + frac * 0.5;                // スプリントではストライドが長い
    // 前方はローカル -numberSide·Z（腕/つま先と同じ）なので、振りと膝の曲げは
    // numberSide に紐づく——両チームともどちらの端を攻めても前に歩き、膝を後ろへ
    // 曲げる。
    const ns = this.numberSide;
    // 背負い(バックダウン)中は振りを反転し、背中向きのまま後ろへ(リムへ)ステップする。
    const dir = this.postT > 0 ? -ns : ns;
    const sL = Math.sin(this.stridePhase), sR = Math.sin(this.stridePhase + Math.PI);
    setJoint(this.hipL, JOINT.hip, sL * amp * dir);          // + 位相で足を前へ振る(背負い時は後ろへ)
    setJoint(this.hipR, JOINT.hip, sR * amp * dir);
    const bend = 0.5 + frac * 0.6;
    setJoint(this.kneeL, JOINT.knee, -Math.max(0, sL * (this.postT > 0 ? -1 : 1)) * bend * ns);   // 振り脚で脛が流れる
    setJoint(this.kneeR, JOINT.knee, -Math.max(0, sR * (this.postT > 0 ? -1 : 1)) * bend * ns);
};
