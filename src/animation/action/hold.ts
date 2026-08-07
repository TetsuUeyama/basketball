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
 *  動くようにする。
 *
 *  ⚠️ **手先の位置はIKで解く。** 方向付け(FK)だけだと手が腕の長さぶん先まで行くので、
 *  ボールが手ではなく前腕・上腕の間に来る（実測: 手のひらがボールを 0.3m 通り越し、
 *  肘の方がボールに近かった）。届かないときだけ従来のFKへ落ちる。
 *  `sep` は手のひらを置くボール中心からの距離。既定はボール半径 0.12m のすぐ外側。 */
Player.prototype.holdBallHands = function(world: Vector3, sep = 0.13): void {
    const dx = world.x - this.pos.x, dz = world.z - this.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    let lx = -dz / l, lz = dx / l;                      // 保持位置に対する水平方向の垂線
    // 手が交差しないよう、横方向を体の右（ローカル +X → ワールド (cosθ, -sinθ)、
    // aimArm が使うのと同じフレーム）に向ける
    const th = this.root.rotation.y + this.torsoTwist;
    if (lx * Math.cos(th) - lz * Math.sin(th) < 0) { lx = -lx; lz = -lz; }
    const tR = new Vector3(world.x + lx * sep, world.y, world.z + lz * sep);
    const tL = new Vector3(world.x - lx * sep, world.y, world.z - lz * sep);
    // ⚠️ 両手で胸の前に抱える形なので、肘は胴に寄せる。IK の既定の張り出し 0.70
    //    (≒35°) は「遠くのボールへ手を伸ばす」用で、ここで使うと肘が横へ大きく開く。
    //    キャッチ・確保・溜め・スローインの保持が全部ここを通る。
    const keepOut = this.elbowOut;
    this.elbowOut = Math.min(keepOut, 0.20);
    const okR = this.reachIK(this.armPivotR, this.elbowR, tR);
    const okL = this.reachIK(this.armPivotL, this.elbowL, tL);
    this.elbowOut = keepOut;
    if (okR && okL) return;
    // 届かない（体から遠い / 近すぎる）→ 方向付け＋抱え込みのFK
    if (!okR) this.aimArm(this.armPivotR, tR);
    if (!okL) this.aimArm(this.armPivotL, tL);
    // 抱え込み: ボールが体に近いほど肘を曲げ、胸へ抱え込む。前方に出たボール
    // （来るパスへ手を伸ばす）は腕を伸ばしたまま、頭上保持は抱え込まずほぼ真っ直ぐ。
    // ⚠️ 床際のボール(すくい上げ)は抱え込まない。肘を曲げると手が届かず、体の前で
    //    止まって見える。頭上保持と同じく腕を伸ばして下ろす。
    const overhead = world.y > 1.5;
    const low = world.y < 0.55;
    const bend = overhead || low ? 0.1 : clamp(1.2 - l * 1.5, 0, 0.55);
    // 内側へ: 2つの手が両側からボールを包むよう、各前腕を中央（ボール）へ振る。
    // 前腕は肘のローカル −Y に沿って垂れるので、左右の振りは rotation.Z。左右(X)は
    // numberSide で反転しない（前後(Z)だけが反転する）ので腕ごとに一定の符号。
    // +rot.z は −Y を +X へ振るので、右腕(+X 側)は内側へ来るのに −、左腕は +。
    const inward = overhead || low ? 0 : bend * 0.7;
    if (!okR) { this.bendElbow(this.elbowR, bend); this.elbowR.rotation.z = -inward; }
    if (!okL) { this.bendElbow(this.elbowL, bend); this.elbowL.rotation.z = inward; }
};
