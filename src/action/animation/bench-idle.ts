// ベンチ待機アクションのアニメ（視線・そわそわ）。basic/torso・basic/arms の
// ムーバ経由で動く。
import { Vector3 } from "@babylonjs/core";
import { rand } from "../../util";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    benchIdle(dt: number, ballX: number, ballZ: number): void;
  }
}

/**
 * ベンチに座ってボールを眺める1フレーム: 視線は数秒ごとに漂う個人的な
 * オフセットとともにボールを追い、数秒ごとに小さなランダムなそわそわが発火する
 * — 小さなホップ、片手を半分上げる、腕を広げる。自身のジャンプ減算とメッシュ
 * 同期を処理する（ベンチの選手はコート上の毎フレーム更新を受けない）。
 */
Player.prototype.benchIdle = function(dt: number, ballX: number, ballZ: number): void {
    this.benchGazeT -= dt;
    if (this.benchGazeT <= 0) {
      this.benchGazeT = rand(0.8, 2.5);
      this.benchGazeOff = rand(-0.22, 0.22);
    }
    this.faceToward(ballX, ballZ, this.benchGazeOff);

    this.updateJump(dt);
    if (this.benchArmT > 0) {
      this.benchArmT -= dt;
      if (this.benchArmT <= 0) this.handsRest();  // ジェスチャー終了——落ち着く
    }
    this.benchActT -= dt;
    if (this.benchActT <= 0) {
      this.benchActT = rand(2.0, 7.0);
      const roll = Math.random();
      if (roll < 0.35) {
        this.jump(rand(0.06, 0.16), rand(0.25, 0.4));      // 小さなホップ
      } else if (roll < 0.6) {
        this.reach(new Vector3(this.pos.x + rand(-0.4, 0.4), rand(2.1, 2.9),
          this.pos.z + rand(-0.4, 0.4)));                   // 片手が上がる
        this.benchArmT = rand(0.4, 1.0);
      } else if (roll < 0.8) {
        this.armsWide();                                    // 腕を大きく広げる
        this.benchArmT = rand(0.4, 0.9);
      } else {
        this.reach(new Vector3(this.pos.x, rand(2.6, 3.2), this.pos.z), true);
        this.benchArmT = rand(0.35, 0.8);                   // 両手を、短く
      }
    }
    this.sync();
};
