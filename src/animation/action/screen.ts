// スクリーン（ピック&ロール）の視覚: スクリーナーは腕を胸の前で組む（ファウル回避）。
// basic/arms のムーバ経由で動く。
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    foldArms(): void;
  }
}

/** 腕組み: 上腕を下ろし気味に前へ、肘を強く曲げて前腕を胸の前で水平に交差させる。
 *  スクリーナーが接触ファウルを避けるための構え。 */
Player.prototype.foldArms = function(): void {
    this.setArmDir(this.armPivotL, -0.35, -0.75, 0.55);
    this.setArmDir(this.armPivotR, 0.35, -0.75, 0.55);
    this.bendElbow(this.elbowL, 1.5);   // 前腕を水平近くまで持ち上げる
    this.bendElbow(this.elbowR, 1.5);
    this.elbowL.rotation.z = 0.6;        // 前腕を内側へ振り左右で交差
    this.elbowR.rotation.z = -0.6;
};
