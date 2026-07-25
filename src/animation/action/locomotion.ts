// 歩く/走るアクションのアニメ: 腕振り(runArms)と脚・足の運び(updateLegs/
// updateAcornFeet)。basic/ の部位ルール（JOINT・setJoint・腕ムーバ）の中で動く。
import { Vector3, Quaternion } from "@babylonjs/core";
import { HUD_OPTS } from "../../config";
import { rate } from "../../util";
import { Player } from "../../objects/player/player";
import { JOINT } from "../basic/joints";
import { setJoint } from "../basic/rotate";

declare module "../../objects/player/player" {
  interface Player {
    runArms(): void;
    updateLegs(dt: number): void;
    updateAcornFeet(dt: number): void;
  }
}

// ボールをハンドリングしていない選手の腕。前へ走るとストライドに合わせて前後に
// 振る（同じ側の脚と逆位相、肘は曲げたまま） — どんぐりのボディも振るが、
// 半分ほどの振り幅（ずんぐりしたペンギンの腕）。バックペダル（胸の向きに逆らって
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
    const human = HUD_OPTS.model === "human";
    const amp = (0.3 + frac * 0.55) * (human ? 1 : 0.5);
    const aL = Math.sin(this.stridePhase + Math.PI) * amp * ns;   // 左腕 ↔ 右脚
    const aR = Math.sin(this.stridePhase) * amp * ns;
    this.easeArm(this.armPivotL, Quaternion.RotationAxis(new Vector3(1, 0, 0), aL));
    this.easeArm(this.armPivotR, Quaternion.RotationAxis(new Vector3(1, 0, 0), aR));
    const carry = (0.6 + frac * 0.5) * (human ? 1 : 0.6);   // ランナーのように肘を曲げて保つ
    this.bendElbow(this.elbowL, carry);
    this.bendElbow(this.elbowR, carry);
};

  // 歩行/走行サイクルの1フレーム: 速度とともに伸びるストライドで腰を
  // 前後に振り（脚ごとに逆位相）、前方への振りで膝を曲げる。歩行ペース
  // 未満では脚は真っ直ぐへイーズで戻る。着席中は静止させる
  // (ポーズは sit() が管理)。
Player.prototype.updateLegs = function(dt: number): void {
    if (this.seated) return;
    if (HUD_OPTS.model !== "human") { this.updateAcornFeet(dt); return; }
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
    this.stridePhase += this.curSpd * dt * 3.4;   // 距離ベース → 速度がケイデンスを決める
    const amp = 0.32 + frac * 0.5;                // スプリントではストライドが長い
    // 前方はローカル -numberSide·Z（腕/つま先と同じ）なので、振りと膝の曲げは
    // numberSide に紐づく——両チームともどちらの端を攻めても前に歩き、膝を後ろへ
    // 曲げる。
    const ns = this.numberSide;
    const sL = Math.sin(this.stridePhase), sR = Math.sin(this.stridePhase + Math.PI);
    setJoint(this.hipL, JOINT.hip, sL * amp * ns);          // + 位相で足を前へ振る
    setJoint(this.hipR, JOINT.hip, sR * amp * ns);
    const bend = 0.5 + frac * 0.6;
    setJoint(this.kneeL, JOINT.knee, -Math.max(0, sL) * bend * ns);   // 前方への振りで脛が後ろへ流れる
    setJoint(this.kneeR, JOINT.knee, -Math.max(0, sR) * bend * ns);
};

  // どんぐりの靴のペンギン歩き: 移動中は足が素早いつま先上げのパタパタを交互に
  // 行う（靴底でピボットするので踵は接地したまま——ケイデンスと持ち上げが速度と
  // ともに増すパタパタ歩き）。空中では両つま先がぶら下がるように下を向く。静止時は
  // フラットへイーズで戻る。stridePhase を共有するので、走行中のモード切り替えでも
  // 歩調が揃う。
Player.prototype.updateAcornFeet = function(dt: number): void {
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    let tL = 0, tR = 0, tw = 0;
    if (this.airborne) {
      tL = tR = -0.55;                              // つま先が床から離れ下を向く
    } else if (frac >= 0.04) {
      // スプリントでケイデンス ~3 歩/s——これより速いと下のイージングで2つの足が
      // 交互ではなく一緒にパタつくようにぼやける
      this.stridePhase += this.curSpd * dt * 3.0;
      const amp = 0.35 + frac * 0.4;
      tL = Math.max(0, Math.sin(this.stridePhase)) * amp;
      tR = Math.max(0, Math.sin(this.stridePhase + Math.PI)) * amp;
      // 体は接地した足へ傾く——持ち上げたつま先から離れる方へ——これがペンギン
      // 歩きそのもの。揺れはペースとともに少し広がる。
      // クイックネス(敏捷性) がこれを安定させる: 機敏な選手はほとんど揺れない
      // (99 ≈ 肩が水平)、足の重い選手は最大限に揺れる。
      // 純粋に見た目だけ——速度やバランスへの影響はない。
      const wobble = 1 - rate(this.attr.agility);
      tw = -Math.sin(this.stridePhase) * (0.07 + frac * 0.06) * wobble;
    } else {
      this.stridePhase = 0;
    }
    const ease = Math.min(1, dt * 22);
    setJoint(this.acornFootL, JOINT.acornFoot, this.acornFootL.rotation.x + (tL - this.acornFootL.rotation.x) * ease);
    setJoint(this.acornFootR, JOINT.acornFoot, this.acornFootR.rotation.x + (tR - this.acornFootR.rotation.x) * ease);
    this.acornWaddle += (tw - this.acornWaddle) * ease;
    // ノード原点ではなく踵を軸にパタつかせる: つま先上げのピッチだけだと踵の後端
    // （ローカル z = heelBotZ 0.18）が床を突き抜けて下がるので、ノードをその沈んだ
    // 深さだけ持ち上げる——つま先が叩き、踵は接地したまま。つま先下げ（空中）は
    // 持ち上げ不要: root が空中にある。
    this.acornFootL.position.y = Math.max(0, Math.sin(this.acornFootL.rotation.x)) * 0.18;
    this.acornFootR.position.y = Math.max(0, Math.sin(this.acornFootR.rotation.x)) * 0.18;
    this.syncAcornLegs();
};
