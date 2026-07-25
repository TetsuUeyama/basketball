// キャッチ/ギャザー（両手保持）アクションのアニメ。basic/arms のムーバ経由で動く。
import { Vector3 } from "@babylonjs/core";
import { clamp } from "../../util";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    holdBallHands(world: Vector3, sep?: number): void;
  }
}

/** 両手のホールド: 手のひらがボールを両側から包む — ボールの両側に片手ずつ、
 *  ボール1個分の幅を空けて — 両腕が同じ点を狙う（手のひらがボール越しに触れる）
 *  のではなく。キャッチとギャザーに使い、ボールが手の間に収まり腕とともに
 *  動くようにする。 */
Player.prototype.holdBallHands = function(world: Vector3, sep = 0.16): void {
    const dx = world.x - this.pos.x, dz = world.z - this.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    let lx = -dz / l, lz = dx / l;                      // 保持位置に対する水平方向の垂線
    // 手が交差しないよう、横方向を体の右（ローカル +X → ワールド (cosθ, -sinθ)、
    // aimArm が使うのと同じフレーム）に向ける
    const th = this.root.rotation.y + this.torsoTwist;
    if (lx * Math.cos(th) - lz * Math.sin(th) < 0) { lx = -lx; lz = -lz; }
    this.aimArm(this.armPivotR, new Vector3(world.x + lx * sep, world.y, world.z + lz * sep));
    this.aimArm(this.armPivotL, new Vector3(world.x - lx * sep, world.y, world.z - lz * sep));
    // 抱え込み: ボールが体に近いほど肘を曲げ、胸へ抱え込む。前方に出たボール
    // （来るパスへ手を伸ばす）は腕を伸ばしたまま、頭上保持は抱え込まずほぼ真っ直ぐ。
    const overhead = world.y > 1.5;
    const bend = overhead ? 0.1 : clamp(1.2 - l * 1.5, 0, 0.55);
    this.bendElbow(this.elbowR, bend);
    this.bendElbow(this.elbowL, bend);
    // 内側へ: 2つの手が両側からボールを包むよう、各前腕を中央（ボール）へ振る。
    // 前腕は肘のローカル −Y に沿って垂れるので、左右の振りは rotation.Z。左右(X)は
    // numberSide で反転しない（前後(Z)だけが反転する）ので腕ごとに一定の符号。
    // +rot.z は −Y を +X へ振るので、右腕(+X 側)は内側へ来るのに −、左腕は +。
    const inward = overhead ? 0 : bend * 0.7;
    this.elbowR.rotation.z = -inward;
    this.elbowL.rotation.z = inward;
};
