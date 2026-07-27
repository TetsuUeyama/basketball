// 腕（肩・肘・手）の部位定義と基本ムーバ。肩・肘とも瞬間切替は禁止で、速度は
// armRateCap（能力値由来の上書き、1/s）か MOVE_RATE.arm（既定）のイーズに従い、
// 肘の可動域は JOINT.elbow。各アクションのアニメは必ずこのムーバを通して腕を動かす。
import { TransformNode, Vector3, Quaternion } from "@babylonjs/core";
import { expEase } from "../../util";
import { JOINT, MOVE_RATE } from "./joints";
import { clampAngle } from "./rotate";
import { Player, aimDownTo } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    easeArm(pivot: TransformNode, target: Quaternion): void;
    bendElbow(node: TransformNode, amount: number): void;
    handsRest(): void;
    aimArm(pivot: TransformNode, world: Vector3): void;
    setArmDir(pivot: TransformNode, dx: number, dy: number, dz: number): void;
  }
}

  // 腕クォータニオンの共通書き込み。常にレート制限付きで目標へイーズする
  // （armRateCap > 0 ならその速度、未指定は MOVE_RATE.arm）。初期化時
  // （現在の向きが無い）だけ直接セットする。
Player.prototype.easeArm = function(pivot: TransformNode, target: Quaternion): void {
    const cur = pivot.rotationQuaternion;
    if (!cur) { pivot.rotationQuaternion = target; return; }
    const cap = this.armRateCap > 0 ? this.armRateCap : MOVE_RATE.arm;
    // 指数イーズ——毎フレーム目標へ一定の割合だけ動かすので、大きな切り替え
    // だけでなく小さな目標のジッター（跳ねるボール、ポーズ間でちらつく読み）も
    // ダンプされる。
    const k = 1 - Math.exp(-cap * this.lastDt);
    pivot.rotationQuaternion = Quaternion.Slerp(cur, target, k);
};

  // 肘の曲げ: 前方（胸に向かって、-numberSide·Z）へ、腕/脚の規約に合わせる。
  // 前腕(肘)は上腕と同じレート（armRateCap、未指定は MOVE_RATE.arm）で曲げ目標へ
  // イーズする。
Player.prototype.bendElbow = function(node: TransformNode, amount: number): void {
    node.rotationQuaternion = null;   // IKで設定されたクォータニオンを解除しFK(rotation)へ戻す
    node.rotation.y = 0; node.rotation.z = 0;   // 前のポーズから残った抱え込み方向のヨーをクリア
    const target = clampAngle(JOINT.elbow, amount * this.numberSide);   // 肘の可動域に収める
    const cap = this.armRateCap > 0 ? this.armRateCap : MOVE_RATE.arm;
    node.rotation.x = expEase(node.rotation.x, target, cap, this.lastDt);
};

/** 両腕を脇に垂らし、肘を少し曲げる（既定ポーズ）。 */
Player.prototype.handsRest = function(): void {
    this.easeArm(this.armPivotL, Quaternion.Identity());
    this.easeArm(this.armPivotR, Quaternion.Identity());
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

  // 腕を指定方向（rootローカル）へ向ける。速度は easeArm の規約に従う——
  // 守備の低い選手の手は切り替えで遅れ（armRateCap 小）、上書きが無ければ
  // MOVE_RATE.arm で機敏に動く。
Player.prototype.setArmDir = function(pivot: TransformNode, dx: number, dy: number, dz: number): void {
    // 腕は体より後ろへ行かせない: 前方 = −numberSide·Z なので、後ろ向き(+numberSide·Z)の成分は
    // 肩の面(真上・真横まで)で止める。挙げた腕が背中側へ倒れたり、手/ボールが胴を貫通するのを防ぐ。
    if (dz * this.numberSide > 0) dz = 0;
    const len = Math.hypot(dx, dy, dz) || 1;
    this.easeArm(pivot, aimDownTo(dx / len, dy / len, dz / len));
};
