// ドリブルアクションのアニメ: ボール側の手で運ぶ。basic/arms のムーバ経由で動く。
import { Vector3, Quaternion } from "@babylonjs/core";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    reachDribble(world: Vector3, useRight: boolean, rate?: number): void;
  }
}

/** ボールがある側と同じ側の手でドリブル/保持する — 左腰へ運んだボールは右腕を
 *  体を横切って（越えて）伸ばすのではなく左手で持つ、そしてその逆も。 */
Player.prototype.reachDribble = function(world: Vector3, useRight: boolean, rate = 0): void {
    this.dribbleArm = useRight ? "R" : "L";
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.armRateCap = rate;   // > 0 → 手はドリブル精度の速度で置き直す
    this.aimArm(near, world);
    this.bendElbow(nearElbow, 0);   // 前腕がボールへ向かって伸びる、イーズ
    this.armRateCap = 0;
    this.easeArm(far, Quaternion.Identity());
    this.bendElbow(farElbow, 0.28);
};
