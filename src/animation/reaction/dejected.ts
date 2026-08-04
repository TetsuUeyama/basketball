// うなだれ（交代時など）の姿勢アニメ。basic/arms のムーバ経由で動く。
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    dejectedPose(): void;
  }
}

/** うなだれ: 腰と脚は直立のまま — 上半身だけが前へかがみ（胴のピッチ）、腕は
 *  だらりと垂れる。とぼとぼとベンチへ戻る間もこの姿勢を保つ（脚は下で歩き続ける）。
 *  毎フレーム呼んで保持する。resetTwist()/sit()/resetFacing()が体をまっすぐに戻す。 */
Player.prototype.dejectedPose = function(): void {
    this.hingePosed = true;   // 胴の腰ヒンジを当てた（sync が戻さないように）
    const Pt = -this.numberSide * 0.42;                    // 胸が前へ傾く
    const cut = Player.WAIST_HINGE;
    this.torsoNode.rotation.x = Pt;
    this.torsoNode.rotation.y = 0;                         // うなだれている間はプレーツイストなし
    this.torsoTwist = 0;
    // 前傾を（足ではなく）腰の切れ目でヒンジさせる: 胴をオフセットして腰の点は
    // 動かず上半身だけがその上で前傾するようにする——胴全体が傾くのではなく
    // 腰とヒップは真っ直ぐのまま。
    this.torsoNode.position.set(0, cut * (1 - Math.cos(Pt)), -cut * Math.sin(Pt));
    this.flinchPitch = 0;                                  // root（腰/脚）は直立のまま
    // 胴の前傾にかかわらず腕をワールドで真下に垂らす（ピッチを補正）
    this.setArmDir(this.armPivotL, -0.14, -Math.cos(Pt), Math.sin(Pt));
    this.setArmDir(this.armPivotR, 0.14, -Math.cos(Pt), Math.sin(Pt));
    this.bendElbow(this.elbowL, 0.05);
    this.bendElbow(this.elbowR, 0.05);
};
