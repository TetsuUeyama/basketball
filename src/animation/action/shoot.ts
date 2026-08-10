// 利き手で放つシュートフォーム。利き手=シュートハンド（伸ばして放つ・フォロースルー）、
// 逆手=添え手（ガイド）。全シュート種別（ダンク/レイアップ/ミドル/3P/FT）共通。
// basic/arms のムーバ経由、速度は MOVE_RATE.reach。
import { Vector3 } from "@babylonjs/core";
import { MOVE_RATE } from "../basic/joints";
import { Player } from "../../objects/player/player";

// 3P の溜めでボールを構える高さの上げ幅(m)。上腕が少し上がり肘が深く畳まれる。
const DEEP_LIFT = 0.16;

// 溜めの姿勢の角度(rad, shootLoad=1 のとき)。lean=上半身の前傾、thigh=腿を前へ倒す角、
// shin=脛を後ろへ折り返す角。thigh を深く・lean を浅くするほど腰で「く」の字になる。
const POSE = { lean: 0.30, thigh: 0.55, shin: 0.33 };
// 3P: 下半身を前斜めへ深く倒し、上半身はほぼ起こす。
const POSE_3P = { lean: 0.08, thigh: 0.70, shin: 0.30 };

declare module "../../objects/player/player" {
  interface Player {
    shootArms(world: Vector3, guide: boolean): void;
    gatherHold(world: Vector3, deep?: boolean): void;
    applyShootLoad(): void;
  }
}

/** ギャザーの構え: おなかの前で両手にボールを抱える（両肘を程よく曲げる）。
 *  holdBallHands が両手をボールの両側に添える。リリースで shootArms が利き手の
 *  シュートフォームへ引き継ぐ。charge 中に毎フレーム呼ぶ。 */
Player.prototype.gatherHold = function(world: Vector3, deep = false): void {
    this.armRateCap = MOVE_RATE.reach;
    // ⚠️ 肘を胴に寄せる。既定の張り出し 0.70(≒35°) はボールへ手を伸ばす用で、
    //    胸の前で構えると肘が横へ大きく開いてしまう。
    this.elbowOut = deep ? 0.14 : 0.20;
    // 3P の溜め: 上腕を少し上げ、肘を深く畳んでボールを高い位置で構える。
    // 保持点を上げると IK が肩を上げ肘を畳むので、腕の形はここで決まる。
    const w = deep ? new Vector3(world.x, world.y + DEEP_LIFT, world.z) : world;
    this.holdBallHands(w, deep ? 0.10 : 0.13);   // 両手をボールの両側へ（deep は手幅も狭く）
    this.elbowOut = 0.70;                        // 既定へ戻す（他のIK利用へ持ち越さない）
    this.armRateCap = 0;
};

/** シュートの溜めの姿勢: 前傾（腰ヒンジ）＋沈み込み（体を下げ足を縮める）を
 *  shootLoad(0..1) の深さで適用する。3P(gatherDeep) は下半身を前斜めに深く倒し、
 *  上半身を起こして腰で「く」の字を作る。リリースで shootLoad が0へ戻ると自動で
 *  直立に伸び上がる。sync() から毎フレーム呼ぶ。 */
Player.prototype.applyShootLoad = function(): void {
    const L = this.shootLoad;
    const F = this.gatherDeep ? POSE_3P : POSE;
    this.hingePosed = true;   // 胴の腰ヒンジを当てた（sync が戻さないように）
    // 前傾: 胸を腰の切れ目でヒンジさせて前へ倒す（脚・腰は垂直のまま）。dejected と同規約。
    const Pt = -this.numberSide * F.lean * L;
    const cut = Player.WAIST_HINGE;
    this.torsoNode.rotation.x = Pt;                   // 上半身: 前傾
    this.torsoNode.position.set(0, cut * (1 - Math.cos(Pt)), -cut * Math.sin(Pt));
    // 前傾しても顔はゴール方向（水平）へ。頭のピッチで胴の前傾を打ち消す。
    this.headPitch = -Pt;
    // 下半身: 腿を前へ倒し(a)、脛を後ろへ折り返す(b)。腰は root の真上に残るので、
    // 倒すほど膝と足が前へ出て腰との折れ目が深くなる。
    const a = F.thigh * L;                            // 腿のワールド前傾角
    const b = -F.shin * L;                            // 脛のワールド角（負＝後ろへ）
    const ns = this.numberSide;
    this.hipL.rotation.x = this.hipR.rotation.x = a * ns;
    this.kneeL.rotation.x = this.kneeR.rotation.x = (b - a) * ns;
    // root は床のアンカーなので、脚が縮んだぶんだけ下げないと足が床から浮く。
    const leg = (this.vox ? this.vox.hipY : Player.HIP_Y) / 2;   // 腿 ≒ 脛
    this.root.position.y -= 2 * leg - leg * (Math.cos(a) + Math.cos(b));
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
