// リーチ/ディグ（ルーズボール・こぼれ球へ手を伸ばす）アクションのアニメ。
// basic/arms・basic/torso のムーバ経由で動く。
import { Vector3, Quaternion } from "@babylonjs/core";
import { clamp, normAngle } from "../../util";
import { JOINT, MOVE_RATE } from "../basic/joints";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    reach(world: Vector3, both?: boolean): void;
    digReach(world: Vector3): void;
  }
}

/** 右手（または両手）を伸ばして手のひらが `world` — ボール — に合うようにする。
 *  ⚠️ 届く距離ならIKで手先を `world` に**乗せる**（方向付けだけだと手が腕の長さぶん
 *  先へ行き、ボールが前腕に来る）。届かない目標（ベンチの歓声で頭上3mへ手を上げる等）は
 *  FKで方向だけ向ける。速度は素早いリーチ（MOVE_RATE.reach）。 */
Player.prototype.reach = function(world: Vector3, both = false): void {
    this.reachBall(world, both);
};

/** ディグ(掻き出し): 片手で伸ばし、上半身をボールへ回転させて先行する肩が横切り、
 *  手がボールへ大きく伸びる。反対の腕はバランスのため後ろへ振れる。守備者が
 *  はたき出したルーズボールを突くのに使う — 両手でつかむのではなく、
 *  思い切った踏み込み。 */
Player.prototype.digReach = function(world: Vector3): void {
    // 胴の可動域でキャップしつつ胸をボールへツイスト——これが先行する肩を
    // 前に出し、手をより遠くへ届かせる
    const fx = world.x - this.pos.x, fz = world.z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) > 0.05) {
      const twist = clamp(normAngle(this.worldYawTo(world.x, world.z) - this.root.rotation.y),
        JOINT.chestTwist.min, JOINT.chestTwist.max);
      this.torsoTwist = twist;
      this.torsoNode.rotation.y = twist;
    }
    // ボールが今ある側の手（近い肩）で先行、最大リーチのため肘は真っ直ぐに
    // ロック
    const right = this.dribbleWithRight(world);
    const lead = right ? this.armPivotR : this.armPivotL;
    const leadElbow = right ? this.elbowR : this.elbowL;
    const back = right ? this.armPivotL : this.armPivotR;
    const backElbow = right ? this.elbowL : this.elbowR;
    this.aimArm(lead, world);
    this.bendElbow(leadElbow, 0);
    // 後ろ側の腕は腰の後ろへ引く（踏み込みへのカウンターウェイト）
    this.easeArm(back, Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.6));
    this.bendElbow(backElbow, 0.5);
};
