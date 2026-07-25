// 着席/起立（ベンチ）アクションの姿勢アニメ。脚は basic/ の JOINT・setJoint、
// 腕は basic/arms のムーバ経由で動く。
import { HUD_OPTS } from "../../config";
import { Player } from "../../objects/player/player";
import { JOINT } from "../basic/joints";
import { setJoint } from "../basic/rotate";

declare module "../../objects/player/player" {
  interface Player {
    foldSeatedLegs(): void;
    sit(): void;
    stand(): void;
    foldAcornSeat(): void;
    unfoldAcornSeat(): void;
  }
}

  // 太ももを前（コート側、ベンチの選手はボールを向くため）へ畳み、脛を床へ
  // 落とす——numberSide に紐づくので、両ベンチとも片方がベンチを突き抜けて後ろへ
  // 畳むのではなく前へ（座面の上へ）畳む。
Player.prototype.foldSeatedLegs = function(): void {
    const ns = this.numberSide;
    setJoint(this.hipL, JOINT.hip, Player.SIT_HIP * ns);
    setJoint(this.hipR, JOINT.hip, Player.SIT_HIP * ns);
    setJoint(this.kneeL, JOINT.knee, Player.SIT_KNEE * ns);
    setJoint(this.kneeR, JOINT.knee, Player.SIT_KNEE * ns);
};

  // ベンチへの着席 / 起立。着席はリグ全体を下げて腰を座面に
  // 合わせ、脚を畳む（太ももを前、脛を下）。起立は歩行サイクルへ
  // 戻す。
Player.prototype.sit = function(): void {
    this.seated = true;
    this.handsRest();
    this.resetTwist();   // ベンチに正対して座る
    this.foulReactT = 0;
    this.defWinT = 0;
    this.flinchPitch = 0;
    this.foldSeatedLegs();   // どんぐりモードでは隠れるが、ポーズの一貫性を保つ
    if (HUD_OPTS.model === "acorn") this.foldAcornSeat();
};

Player.prototype.stand = function(): void {
    if (!this.seated) return;
    this.seated = false;
    this.root.rotation.x = 0;
    this.hipL.rotation.x = this.hipR.rotation.x = 0;   // 脚が真っ直ぐになる
    this.kneeL.rotation.x = this.kneeR.rotation.x = 0;
    this.unfoldAcornSeat();  // 腰を下ろし直し、靴を立ち姿勢へ戻す
};

Player.prototype.foldAcornSeat = function(): void {
    const ns = this.numberSide;
    const fold = Player.SIT_FOLD;                 // きつい 90° より緩やか
    this.acornWaistPivot.rotation.x = fold * ns;
    const s = this.height / 1.95;
    // 床に接地したより平らな足は、急なつま先下げより座っているように見える。
    // `lift` は座面の下げとつま先ピッチに対して床接地を自己補正する。z は水平なので、
    // どちらにせよ足は接地したまま。
    const TILT = 0.30;                     // つま先下げのピッチ（ローカルの踵上げは両側とも -x）
    const toeDrop = 0.28 * Math.sin(TILT); // ピッチしたつま先（z -0.28）がノードよりこれだけ下がる
    const RAISE = 0.24;                    // 足を床から持ち上げる（ぶら下がった見た目）
    const lift = Player.acornSeatDrop() - Player.SEAT_SURF / s + toeDrop + RAISE;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = -TILT;
    this.acornFootL.position.y = this.acornFootR.position.y = lift;
    // 足は腰の底の真下から生え（緩い畳みでは前方への張り出しが縮む）、真っ直ぐ
    // 床へ落ちる
    const footZ = -ns * Player.ACORN_WAIST_LEN * Math.sin(fold) * 0.7;
    this.acornFootL.position.z = this.acornFootR.position.z = footZ;
    this.syncAcornLegs();
};

  // 立ち姿勢の配置へ戻す（ヒューマンモードで呼んでも安全）。
Player.prototype.unfoldAcornSeat = function(): void {
    this.acornWaistPivot.rotation.x = 0;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = 0;
    this.acornFootL.position.y = this.acornFootR.position.y = 0;
    this.acornFootL.position.z = this.acornFootR.position.z =
      -this.numberSide * Player.ACORN_FOOT_Z;
    this.syncAcornLegs();
};
