// 利き手で放つシュートフォーム。利き手=シュートハンド（伸ばして放つ・フォロースルー）、
// 逆手=添え手（ガイド）。全シュート種別（ダンク/レイアップ/ミドル/3P/FT）共通。
// basic/arms のムーバ経由、速度は MOVE_RATE.reach。
import { Vector3 } from "@babylonjs/core";
import { MOVE_RATE } from "../basic/joints";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    shootArms(world: Vector3, guide: boolean): void;
  }
}

/** 利き手を `world`（ボール→リム）へ伸ばして放つ。guide=true はギャザー/リリース中で
 *  逆手をボール脇に添える、false はフォロースルーで逆手を下げる。 */
Player.prototype.shootArms = function(world: Vector3, guide: boolean): void {
    const R = this.hand === "R";
    const domP = R ? this.armPivotR : this.armPivotL;   // 利き手（シュートハンド）
    const domE = R ? this.elbowR : this.elbowL;
    const offP = R ? this.armPivotL : this.armPivotR;   // 逆手（添え手）
    const offE = R ? this.elbowL : this.elbowR;
    const offside = R ? -1 : 1;                          // 添え手の外側
    this.armRateCap = MOVE_RATE.reach;
    // 利き手: 目標へ伸ばす（フォロースルーは肘を伸ばし切る）
    this.aimArm(domP, world);
    this.bendElbow(domE, guide ? 0.15 : 0);
    if (guide) {
      // 添え手: ボールの脇に添える（曲げてガイド）
      this.aimArm(offP, world);
      this.bendElbow(offE, 0.7);
    } else {
      // フォロースルー: 添え手は横に広げず、下方向に曲げて下ろす
      this.setArmDir(offP, offside * 0.15, -0.95, 0.1);   // ほぼ真下
      this.bendElbow(offE, 0.6);                           // 下方向に曲げる
    }
    this.armRateCap = 0;
};
