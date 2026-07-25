// 選手の状況クエリ（特殊能力・利き手・体の向き/前方点の算出）。プロトタイプ拡張で Player に紐づけ。
import { Vector3 } from "@babylonjs/core";
import { AbilityKey } from "../../attributes";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    has(key: AbilityKey): boolean;
    strongSide(): number;
    strongSideBias(): number;
    chestFront(dist: number): { x: number; z: number };
    faceDirWorld(): { x: number; z: number };
    dribbleWithRight(world: Vector3): boolean;
  }
}

/** この選手が指定の特殊能力を持つなら true。 */
Player.prototype.has = function(key: AbilityKey): boolean {
  return this.abilities.has(key);
};

/** +1 = 利き手側、-1 = 逆側（driveSide空間）。 */
Player.prototype.strongSide = function(): number { return this.hand === "L" ? -1 : 1; };

/** サイドを自由に選べるときどれだけ利き手側を好むか — 逆手頻度8は両サイドを
 *  使う(50/50)、2は大きく片手寄り(~70/30)。 */
Player.prototype.strongSideBias = function(): number { return 0.5 + (1 - this.offhandFreq / 8) * 0.27; };

/** 胸（番号の反対側）から `dist` メートル真正面へ出たワールド点 — 両手ギャザーが
 *  ボールを保持する位置。aimArm/dribbleWithRightと同じヨー+ツイストのフレームなので、
 *  彼が向きを変えると胴に追随する。 */
Player.prototype.chestFront = function(dist: number): { x: number; z: number } {
  const th = this.root.rotation.y + this.torsoTwist;
  const s = this.numberSide;
  return { x: this.pos.x - s * Math.sin(th) * dist, z: this.pos.z - s * Math.cos(th) * dist };
};

/** 体の中心から顔を通る水平の単位ベクトル — 目メッシュの実際の描画位置（両目の
 *  中点）から取るので、顔を撮らねばならないカメラにとっての真値であり、あらゆる
 *  numberSide/ヨー規約に対して頑健。ワールド行列がまだ計算されていない間
 *  （最初のフレーム、ヘッドレス）は胸のフレームにフォールバックする。 */
Player.prototype.faceDirWorld = function(): { x: number; z: number } {
  if (this.eyeL && this.eyeR && typeof this.eyeL.getAbsolutePosition === "function") {
    const a = this.eyeL.getAbsolutePosition(), b = this.eyeR.getAbsolutePosition();
    const ex = (a.x + b.x) / 2 - this.root.position.x;
    const ez = (a.z + b.z) / 2 - this.root.position.z;
    const l = Math.hypot(ex, ez);
    if (l > 1e-3) return { x: ex / l, z: ez / l };
  }
  const th = this.root.rotation.y + this.torsoTwist;
  const s = this.numberSide;
  return { x: -s * Math.sin(th), z: -s * Math.cos(th) };
};

/** ワールド点が体のどちら側にあるか — +xローカル = 体の右（armPivotR側）。aimArmと
 *  同じヨー+ツイストのフレームを使うので、腕が実際に指す方向と食い違うことはない。 */
Player.prototype.dribbleWithRight = function(world: Vector3): boolean {
  const th = this.root.rotation.y + this.torsoTwist;
  const wx = world.x - this.root.position.x, wz = world.z - this.root.position.z;
  const localX = Math.cos(th) * wx - Math.sin(th) * wz;
  return localX >= 0;
};
