// 着席/起立（ベンチ）アクションの姿勢アニメ。脚は basic/ の JOINT・setJoint、
// 腕は basic/arms のムーバ経由で動く。
import { Player } from "../../objects/player/player";
import { setPlayerShadow } from "../../scene-setup";
import { JOINT } from "../basic/joints";
import { setJoint } from "../basic/rotate";

declare module "../../objects/player/player" {
  interface Player {
    foldSeatedLegs(): void;
    sit(): void;
    stand(): void;
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
    this.foldSeatedLegs();
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
