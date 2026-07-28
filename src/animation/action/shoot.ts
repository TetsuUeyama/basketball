// 利き手で放つシュートフォーム。利き手=シュートハンド（伸ばして放つ・フォロースルー）、
// 逆手=添え手（ガイド）。全シュート種別（ダンク/レイアップ/ミドル/3P/FT）共通。
// basic/arms のムーバ経由、速度は MOVE_RATE.reach。
import { Vector3 } from "@babylonjs/core";
import { MOVE_RATE } from "../basic/joints";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    shootArms(world: Vector3, guide: boolean): void;
    gatherHold(world: Vector3): void;
    applyShootLoad(): void;
  }
}

/** ギャザーの構え: ボールを体の前で抱える。利き手を主にボールへ、逆手を添え、
 *  両前腕を内側に曲げて（肘をたたんで）ボールを前で保持する。両手投げに見えない
 *  よう利き手主体。charge 中に毎フレーム呼ぶ。 */
Player.prototype.gatherHold = function(world: Vector3): void {
    // 利き手ノードは numberSide を織り込む: setNumberSide は腕/目のZ(前後)のみ反転しX
    // (左右)は不変。+X は numberSide=+1 の時だけ体の右(armR)、-1 では体の左になる。よって
    // 右利き(hand="R")の実際の右手は numberSide>0 で armR、<0 で armL。
    const R = (this.hand === "R") === (this.numberSide > 0);
    const domP = R ? this.armPivotR : this.armPivotL;   // 利き手
    const domE = R ? this.elbowR : this.elbowL;
    const offP = R ? this.armPivotL : this.armPivotR;   // 添え手
    const offE = R ? this.elbowL : this.elbowR;
    const offside = R ? -1 : 1;                          // 添え手の外側
    this.armRateCap = MOVE_RATE.reach;
    // 利き手: IKで手のひらをボールに乗せる(=必ず触れる)。ボールは懐(手前)にあるのでIKの極ベクトルが
    // 肘を下へ収める。届かない時のみ下向きFKで構える。
    if (!this.reachIK(domP, domE, world)) {
      this.setArmDir(domP, (R ? 1 : -1) * 0.1, -0.8, -this.numberSide * 0.3);
      this.bendElbow(domE, 1.2);
    }
    // 添え手: ボール正面でなく外側の脇へ回す（両手投げに見せない＝利き手主体）。
    // upper を offside・やや上・前へ向け、深く曲げて手だけボール脇に添える。
    this.setArmDir(offP, offside * 0.45, 0.35, -this.numberSide * 0.55);
    this.bendElbow(offE, 0.95);
    this.armRateCap = 0;
};

/** シュートの溜めの姿勢: 前傾（腰ヒンジ）＋沈み込み（体を下げ足を縮める）を
 *  shootLoad(0..1) の深さで適用する。リリースで shootLoad が0へ戻ると自動で
 *  直立に伸び上がる。sync() から毎フレーム呼ぶ。 */
Player.prototype.applyShootLoad = function(): void {
    const L = this.shootLoad;
    // 前傾: 胸を腰の切れ目でヒンジさせて前へ倒す（脚・腰は垂直のまま）。dejected と同規約。
    const Pt = -this.numberSide * 0.30 * L;           // 前傾角（フルで約17°）
    const cut = Player.ACORN_CUT;
    this.torsoNode.rotation.x = Pt;                   // 上半身: 前傾
    this.torsoNode.position.set(0, cut * (1 - Math.cos(Pt)), -cut * Math.sin(Pt));
    // 下半身(腰/尻)を上半身と逆方向(後傾)へ折り、上下でくの字に(座り込むディップ)。
    // waistPivot は torso(Pt)相対なので、-Pt で垂直、更に逆へ折るため係数を1超に。
    this.acornWaistPivot.rotation.x = -Pt * 1.7;      // world下半身 ≈ -0.7*Pt(後傾)
    // 前傾しても顔はゴール方向（水平）へ。頭ノード(胴の根元が軸)でなく頭メッシュ自身を
    // その中心で回すので、頭は体に付いたまま位置は動かず、顔だけ水平に戻る。
    this.head.rotation.x = -Pt;
    // 沈み込み: root を下げ、足を同量持ち上げて接地を保つ（脚が縮んで姿勢が低くなる）。
    const dip = L * 0.15;                             // 沈み込み（フルで約15cm）
    this.root.position.y -= dip;
    this.acornFootL.position.y += dip;
    this.acornFootR.position.y += dip;
    this.syncAcornLegs();                             // 脚を腰-靴に再フィット
};

/** 利き手を `world`（ボール→リム）へ伸ばして放つ。guide=true はギャザー/リリース中で
 *  逆手をボール脇に添える、false はフォロースルーで逆手を下げる。 */
Player.prototype.shootArms = function(world: Vector3, guide: boolean): void {
    // 利き手ノードは numberSide を織り込む: setNumberSide は腕/目のZ(前後)のみ反転しX
    // (左右)は不変。+X は numberSide=+1 の時だけ体の右(armR)、-1 では体の左になる。よって
    // 右利き(hand="R")の実際の右手は numberSide>0 で armR、<0 で armL。
    const R = (this.hand === "R") === (this.numberSide > 0);
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
      // 添え手: ボールの脇に添えるガイド（深く曲げ、押し手にしない＝両手投げに見せない）
      this.aimArm(offP, world);
      this.bendElbow(offE, 0.9);
    } else {
      // フォロースルー: 添え手は横に広げず、下方向に曲げて下ろす
      this.setArmDir(offP, offside * 0.15, -0.95, 0.1);   // ほぼ真下
      this.bendElbow(offE, 0.6);                           // 下方向に曲げる
    }
    this.armRateCap = 0;
};
