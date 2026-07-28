// 守備成功（ブロック/スティール/ストップ）の演出アニメ。basic/arms のムーバ
// 経由で動く。純粋に見た目のみ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../objects/player/player";

type DefWinKind = "block" | "steal" | "stop" | "cheer" | "clap" | "highfive";

declare module "../../objects/player/player" {
  interface Player {
    defWin(kind: DefWinKind): void;
    poseDefWin(): void;
  }
}

/** 守備成功の演出を開始する（純粋に見た目のみ）。ファウルリアクションが既に
 *  動いている場合は無視する（ブロックからのファウルは接触の演出を保つ）。 */
Player.prototype.defWin = function(kind: DefWinKind): void {
    if (this.foulReactT > 0) return;
    this.defWinKind = kind;
    this.defWinDur = this.defWinT = kind === "block" ? 1.25 : kind === "steal" ? 1.0 : 0.8;
    // 接地しているときだけ小さく力強いホップ——スワットでまだ上にいるブロッカーは
    // 既存のジャンプを保つ（この処理がそのより大きいジャンプを踏み潰してはならない）
    if ((kind === "block" || kind === "cheer" || kind === "highfive") && !this.airborne) this.jump(0.14, 0.4);
};

/** 守備成功のポーズの1フレーム。runArms/poseFoulReactionの後に呼ぶ（動いている間は
 *  腕+ひるみの傾きを占有する）。減算はtickCooldownで行う。呼び出し側は、選手が
 *  アクティブなボールの仕事（ハンドリング、シュート、まだ空中、ルーズボールへの
 *  スクランブル）を持つ間はこれを抑止する。 */
Player.prototype.poseDefWin = function(): void {
    if (this.defWinT <= 0) return;
    const k = this.defWinDur > 0 ? 1 - this.defWinT / this.defWinDur : 1;
    const env = Math.sin(Math.min(1, k * 1.25) * Math.PI);     // 立ち上がり、緩やかに収まる
    const pump = Math.max(0, Math.sin(k * Math.PI * 3));       // 素早いダブルパンプ
    if (this.defWinKind === "block") {
      // 勝ち誇る: 両拳を頭の横に上げる（拒否のフレックス）
      this.setArmDir(this.armPivotL, -0.55, 0.95, 0.05);
      this.setArmDir(this.armPivotR, 0.55, 0.95, 0.05);
      this.bendElbow(this.elbowL, 1.1 + pump * 0.3);
      this.bendElbow(this.elbowR, 1.1 + pump * 0.3);
      this.flinchPitch = this.numberSide * 0.10 * env;          // 胸を上げて後ろへ軽く揺れる
      this.flinchRoll = 0;
    } else if (this.defWinKind === "steal") {
      // 低いダブル拳パンプ——拳を肋骨のあたりで握り、素早く数回パンプ
      this.setArmDir(this.armPivotL, -0.35, -0.15 + pump * 0.25, 0.2);
      this.setArmDir(this.armPivotR, 0.35, -0.15 + pump * 0.25, 0.2);
      this.bendElbow(this.elbowL, 1.25);
      this.bendElbow(this.elbowR, 1.25);
      this.flinchPitch = -this.numberSide * 0.12 * env;         // 前へ乗り込む（前方）
      this.flinchRoll = 0;
    } else if (this.defWinKind === "cheer") {
      // 大きな喜び: 両手を高く真上に伸ばし、繰り返しホップして弾む
      this.setArmDir(this.armPivotL, -0.32, 1.0, 0.02);
      this.setArmDir(this.armPivotR, 0.32, 1.0, 0.02);
      this.bendElbow(this.elbowL, 0.12 + pump * 0.18);
      this.bendElbow(this.elbowR, 0.12 + pump * 0.18);
      this.flinchPitch = this.numberSide * 0.12 * env;
      this.flinchRoll = 0;
      if (!this.airborne && this.landT <= 0) this.jump(0.17, 0.42);   // 着地毎に弾む
    } else if (this.defWinKind === "clap") {
      // 頭の上で拍手: 両手を頭上に上げて合わせ/開くを繰り返す
      const cphase = Math.abs(Math.sin((this.defWinDur - this.defWinT) * 14));
      this.holdBallHands(new Vector3(this.root.position.x, 2.0, this.root.position.z), 0.03 + cphase * 0.16);
      this.flinchPitch = this.numberSide * 0.05 * env;
      this.flinchRoll = 0;
    } else if (this.defWinKind === "highfive") {
      // ハイタッチ: 相手を向き、両手を高く前へ上げて叩き合う(相手も同じ方向を向いて合わせる)
      this.faceToward(this.defWinToward.x, this.defWinToward.z);
      const slap = 0.92 + Math.sin((this.defWinDur - this.defWinT) * 11) * 0.10;
      this.setArmDir(this.armPivotL, -0.28, slap, -this.numberSide * 0.3);
      this.setArmDir(this.armPivotR, 0.28, slap, -this.numberSide * 0.3);
      this.bendElbow(this.elbowL, 0.28);
      this.bendElbow(this.elbowR, 0.28);
      this.flinchPitch = -this.numberSide * 0.08 * env;             // 相手へ少し前傾
      this.flinchRoll = 0;
    } else {
      // STOP / 壁: 踏ん張った——腕を低く前へ、胸を構え、身構える
      this.setArmDir(this.armPivotL, -0.9, -0.35, 0.4);
      this.setArmDir(this.armPivotR, 0.9, -0.35, 0.4);
      this.bendElbow(this.elbowL, 0.15);
      this.bendElbow(this.elbowR, 0.15);
      this.flinchPitch = -this.numberSide * 0.14 * env;         // ドライブに向かって前へ身構える
      this.flinchRoll = 0;
    }
};
