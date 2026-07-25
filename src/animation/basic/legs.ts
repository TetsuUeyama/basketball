// 脚・足の部位定義。可動域・速度の規約は JOINT.hip / knee / acornFoot（適用は
// rotate.ts の setJoint）。ストライドのアクションは ../locomotion.ts、着席姿勢は
// ../sit.ts が、いずれもこの規約の中で動く。
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    syncAcornLegs(): void;
  }
}

  // 素肌の脚シリンダーを腰と靴の間に固定し続ける: 脚は垂直を保ち
  // （足のつま先パタつきの傾きを継承しない）、足の持ち上げ/スタンスに
  // y と z で乗るだけなので、足がパタつく間も上端は腰に収まり、下端は
  // 靴の中に留まる。
Player.prototype.syncAcornLegs = function(): void {
    this.acornLegL.position.y = this.acornFootL.position.y;
    this.acornLegL.position.z = this.acornFootL.position.z;
    this.acornLegR.position.y = this.acornFootR.position.y;
    this.acornLegR.position.z = this.acornFootR.position.z;
};
