// 腕（肩・肘・手）の部位定義と基本ムーバ。肩の向け直しは armRateCap(rad/s) の
// レート制限、肘の曲げは JOINT.elbow の可動域に従う。各アクションのアニメは
// 必ずこのムーバを通して腕を動かす。
import { TransformNode, Vector3, Quaternion } from "@babylonjs/core";
import { expEase } from "../../../util";
import { JOINT } from "./joints";
import { clampAngle } from "./rotate";
import { Player, aimDownTo } from "../../../objects/player/player";

declare module "../../../objects/player/player" {
  interface Player {
    bendElbow(node: TransformNode, amount: number): void;
    handsRest(): void;
    aimArm(pivot: TransformNode, world: Vector3): void;
    setArmDir(pivot: TransformNode, dx: number, dy: number, dz: number): void;
  }
}

  // 肘の曲げ: 前方（胸に向かって、-numberSide·Z）へ、腕/脚の規約に合わせる。
  // 手がボールに届く必要があるときは常に真っ直ぐ(0)。スルー(slew)が有効なとき、
  // 前腕(肘)は上腕と同じレートで曲げ目標へイーズする。
Player.prototype.bendElbow = function(node: TransformNode, amount: number): void {
    node.rotation.y = 0; node.rotation.z = 0;   // 前のポーズから残った抱え込み方向のヨーをクリア
    const target = clampAngle(JOINT.elbow, amount * this.numberSide);   // 肘の可動域に収める
    node.rotation.x = expEase(node.rotation.x, target, this.armRateCap, this.lastDt);
};

/** 両腕を脇に垂らし、肘を少し曲げる（既定ポーズ）。 */
Player.prototype.handsRest = function(): void {
    this.armPivotL.rotationQuaternion = Quaternion.Identity();
    this.armPivotR.rotationQuaternion = Quaternion.Identity();
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
    this.bendElbow(this.elbowL, 0.28);
    this.bendElbow(this.elbowR, 0.28);
};

  // 肩からワールド座標の点へ腕を向ける——方向のみなので腕は固定長を保つ。
  // root はヨーを持ちうる（選手はプレーへ向き直る）ため、肩のワールド位置は
  // 体とともに回転し、目標のリーチ（ワールド空間で計算）を腕の（ローカル）照準に
  // する前に root のローカルフレームへ変換し直す。R_y(θ): ローカル +Z →
  // (sinθ,0,cosθ)、ローカル +X → (cosθ,0,-sinθ)。
Player.prototype.aimArm = function(pivot: TransformNode, world: Vector3): void {
    // 肩はツイストする胴に乗る——そのフレームは root ヨー + ツイスト
    const th = this.root.rotation.y + this.torsoTwist;
    const c = Math.cos(th), s = Math.sin(th);
    const px = pivot.position.x, py = pivot.position.y * this.root.scaling.y, pz = pivot.position.z;
    // 肩ワールド = root + R_y(θ)·(ローカル肩オフセット)
    const sx = this.root.position.x + (c * px + s * pz);
    const sy = this.root.position.y + py;
    const sz = this.root.position.z + (-s * px + c * pz);
    // ワールドでのリーチ方向 → root のローカルフレームへ回転 (R_y(-θ))
    const wx = world.x - sx, wy = world.y - sy, wz = world.z - sz;
    this.setArmDir(pivot, c * wx - s * wz, wy, s * wx + c * wz);
};

Player.prototype.setArmDir = function(pivot: TransformNode, dx: number, dy: number, dz: number): void {
    const len = Math.hypot(dx, dy, dz) || 1;
    const target = aimDownTo(dx / len, dy / len, dz / len);
    const cur = pivot.rotationQuaternion;
    // レート制限（守備）付きの向き直し: armRateCap rad/s を超えない速度で腕を目標へ
    // イーズさせるので、守備の低い選手の手は切り替えで遅れる。スナップ書き込み
    // （armRateCap 0、または現在の向きなし）はボールを扱う腕をキビキビ保つ。
    if (this.armRateCap > 0 && cur) {
      // 指数イーズ——毎フレーム目標へ一定の割合だけ動かすので、大きな切り替え
      // だけでなく小さな目標のジッター（跳ねるボール、ポーズ間でちらつく読み）も
      // ダンプされる。割合（収束速度）は守備でスケールする: 弱い守備者の手は
      // 漂い、エリートの手はキビッと収まる。
      const k = 1 - Math.exp(-this.armRateCap * this.lastDt);
      pivot.rotationQuaternion = Quaternion.Slerp(cur, target, k);
    } else {
      pivot.rotationQuaternion = target;
    }
};
