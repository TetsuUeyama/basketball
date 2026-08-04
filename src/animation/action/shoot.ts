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

/** ギャザーの構え: おなかの前で両手にボールを抱える（両肘を程よく曲げる）。
 *  holdBallHands が両手をボールの両側に添える。リリースで shootArms が利き手の
 *  シュートフォームへ引き継ぐ。charge 中に毎フレーム呼ぶ。 */
Player.prototype.gatherHold = function(world: Vector3): void {
    this.armRateCap = MOVE_RATE.reach;
    this.holdBallHands(world);   // 両手でボールをおなかの前に抱える（両肘を曲げて包む）
    this.armRateCap = 0;
};

/** シュートの溜めの姿勢: 前傾（腰ヒンジ）＋沈み込み（体を下げ足を縮める）を
 *  shootLoad(0..1) の深さで適用する。リリースで shootLoad が0へ戻ると自動で
 *  直立に伸び上がる。sync() から毎フレーム呼ぶ。 */
Player.prototype.applyShootLoad = function(): void {
    const L = this.shootLoad;
    this.hingePosed = true;   // 胴の腰ヒンジを当てた（sync が戻さないように）
    // 前傾: 胸を腰の切れ目でヒンジさせて前へ倒す（脚・腰は垂直のまま）。dejected と同規約。
    const Pt = -this.numberSide * 0.30 * L;           // 前傾角（フルで約17°）
    const cut = Player.WAIST_HINGE;
    this.torsoNode.rotation.x = Pt;                   // 上半身: 前傾
    this.torsoNode.position.set(0, cut * (1 - Math.cos(Pt)), -cut * Math.sin(Pt));
    // 前傾しても顔はゴール方向（水平）へ。頭のピッチで胴の前傾を打ち消す。
    this.headPitch = -Pt;
    // 沈み込み: 股関節と膝を曲げて屈む。root は床のアンカーなので、脚が縮んだぶんだけ
    // 下げないと足が床から浮く（縮み量は腿・脛の投影長から出す）。
    const dip = L * 0.55;                             // 曲げ角(rad)。フルで約31°
    const ns = this.numberSide;
    this.hipL.rotation.x = this.hipR.rotation.x = dip * ns;
    this.kneeL.rotation.x = this.kneeR.rotation.x = -dip * 1.6 * ns;
    const leg = (this.vox ? this.vox.hipY : Player.HIP_Y) / 2;   // 腿 ≒ 脛
    this.root.position.y -= 2 * leg - leg * (Math.cos(dip) + Math.cos(0.6 * dip));
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
    // guide 中の `world` はボールそのもの。⚠️ 手のひらをIKでボールの面に乗せる
    // （FKで方向付けするだけだと手が腕の長さぶん通り越し、ボールが前腕に来る）。
    // 掴む位置は片手シュートの形: 利き手はボールの後ろ（体側）・やや下、添え手は横。
    let okDom = false, okOff = false;
    if (guide) {
      const th = this.root.rotation.y + this.torsoTwist;
      const bx = this.pos.x - world.x, bz = this.pos.z - world.z;   // ボール→体（後ろ側）
      const bl = Math.hypot(bx, bz) || 1;
      const back = new Vector3(world.x + (bx / bl) * 0.10, world.y - 0.04, world.z + (bz / bl) * 0.10);
      // ローカル +X（体の右）のワールド方向。添え手はその外側へ
      const sx = Math.cos(th) * offside, sz = -Math.sin(th) * offside;
      const sideP = new Vector3(world.x + sx * 0.13, world.y, world.z + sz * 0.13);
      okDom = this.reachIK(domP, domE, back);
      okOff = this.reachIK(offP, offE, sideP);
    }
    if (!okDom) {
      this.aimArm(domP, world);
      this.bendElbow(domE, guide ? 0.15 : 0);
    }
    if (guide) {
      // 添え手: ボールの脇に添えるガイド（深く曲げ、押し手にしない＝両手投げに見せない）
      if (!okOff) {
        this.aimArm(offP, world);
        this.bendElbow(offE, 0.9);
      }
    } else {
      // フォロースルー: 添え手は横に広げず、下方向に曲げて下ろす
      this.setArmDir(offP, offside * 0.15, -0.95, 0.1);   // ほぼ真下
      this.bendElbow(offE, 0.6);                           // 下方向に曲げる
    }
    this.armRateCap = 0;
};
