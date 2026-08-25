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
    updateWristTrail(): void;
    /** 肘の遅延段（肩の進みに相当する中間値）。左右で1つずつ。 */
    elbowLagL: number;
    elbowLagR: number;
    /** 手首の末端遅延: 前腕の向きを遅れて追うクォータニオン（胴ローカル）。 */
    foreLagL: Quaternion | null;
    foreLagR: Quaternion | null;
  }
}
Player.prototype.elbowLagL = 0;
Player.prototype.elbowLagR = 0;
Player.prototype.foreLagL = null;
Player.prototype.foreLagR = null;

// ---------------------------------------------------------------------------
// 近位→遠位の連鎖（上腕 → 前腕 → 手首）。
// 肩は指示された速度でそのまま動き、肘は「肩の進みに相当する中間値」を追い、手首は
// 前腕の向きを遅れて追う。速度を落とすだけでなく1段挟むので、動き出しが肩→肘→手の
// 順になる（同じ速度で同時に動かすと腕が一枚板に見える）。
// ⚠️ IK（reachIK / holdBallHands）は肩と肘を**同時に解いて**手先をボールへ乗せる。
//    解いた角度に遅延を掛けると接触が外れるので、遅延は肘のFK経路(bendElbow)と
//    手首だけに掛ける。手首の遅れも IK 中は ikDamp まで薄める。
// ⚠️ 遅延段を1つ挟むぶん、肘が目標に着くまでの時間は伸びる。ボールを掴む系は
//    MOVE_RATE.reach(=30) で動いているので、elbow を下げすぎるとキャッチが目に見えて
//    遅れる。順序の見え方と到達の速さはこの3つで釣り合いを取る。
const CHAIN = {
  elbow: 0.75,    // 肘の追従速度（cap への倍率）
  wrist: 0.40,    // 手首の追従速度（cap への倍率）
  ikDamp: 0.30,   // IKで手先を乗せている間、手首の遅れをどこまで残すか
};
// 手首が前腕から遅れてよい最大角(rad ≈ 17°)。手は剛体のブロックなので、曲げるほど
// 手首の継ぎ目に楔形の隙間が開く（26°で約1.8cm＝ボクセル1個ぶん）。
const WRIST_MAX = 0.30;

  // 腕クォータニオンの共通書き込み。常にレート制限付きで目標へイーズする
  // （armRateCap > 0 ならその速度、未指定は MOVE_RATE.arm）。初期化時
  // （現在の向きが無い）だけ直接セットする。
Player.prototype.easeArm = function(pivot: TransformNode, target: Quaternion): void {
    // 手続きポーズで書いた腕はIK印を落とす（reachIK が書いた直後に立て直す）
    if (pivot === this.armPivotL) this.ikL = false;
    else if (pivot === this.armPivotR) this.ikR = false;
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
  // 肘は目標へ直接向かわず、まず遅延段（肩と同じ速度で目標を追う中間値）を挟み、
  // その中間値を CHAIN.elbow の速度で追う。これで肩が動き出してから肘が動く。
// 肘の最小の曲げ(rad)。**伸ばし切りでもこれだけは残す（約18°）。**
// ⚠️ 人の腕は伸ばしても肘で真っ直ぐにはならない。6°では見た目が一本の棒で、肘が
//    無いように見えた（実測: 腕を広げる/両手を上げるポーズの見た目の肘角が 8.2°）。
//    リーチの損は小さい: 全長は 2L·cos(θ/2) なので 18° でも 1% 未満（約4mm）。
const MIN_ELBOW = 0.32;

Player.prototype.bendElbow = function(node: TransformNode, amount: number): void {
    node.rotationQuaternion = null;   // IKで設定されたクォータニオンを解除しFK(rotation)へ戻す
    node.rotation.y = 0; node.rotation.z = 0;   // 前のポーズから残った抱え込み方向のヨーをクリア
    // ⚠️ 完全に伸ばし切らない。前腕と上腕が一直線だと棒に見えるので、どんな指定でも
    //    最低 MIN_ELBOW だけは曲げておく。
    const target = clampAngle(JOINT.elbow, Math.max(amount, MIN_ELBOW) * this.numberSide);
    const cap = this.armRateCap > 0 ? this.armRateCap : MOVE_RATE.arm;
    const left = node === this.elbowL;
    // 遅延段。IK から FK へ戻った直後は中間値が古いので、実際の曲げから引き継ぐ。
    let lag = left ? this.elbowLagL : this.elbowLagR;
    if (Math.abs(lag - node.rotation.x) > 1.2) lag = node.rotation.x;
    lag = expEase(lag, target, cap, this.lastDt);
    if (left) this.elbowLagL = lag; else this.elbowLagR = lag;
    node.rotation.x = expEase(node.rotation.x, lag, cap * CHAIN.elbow, this.lastDt);
};

const _fore = new Quaternion();
const _armQ = new Quaternion();
const _elbQ = new Quaternion();
const _lead = new Quaternion();
const _IDENT = Quaternion.Identity();   // 毎フレーム26人ぶん回るので確保しない

// ノードのローカル回転をクォータニオンで取り出す（Euler で持っている場合も拾う）。
function localQ(n: TransformNode, out: Quaternion): Quaternion {
  if (n.rotationQuaternion) out.copyFrom(n.rotationQuaternion);
  else Quaternion.FromEulerAnglesToRef(n.rotation.x, n.rotation.y, n.rotation.z, out);
  return out;
}

// 片腕ぶんの手首。前腕の胴ローカル向きを遅れて追い、その「まだ追いつけていない差」を
// 手首のローカル回転として入れる。腕を振ると手が置いていかれ、止まると戻る。
function wristTrail(p: Player, arm: TransformNode, elbow: TransformNode,
                    wrist: TransformNode, left: boolean): void {
  const fore = localQ(arm, _armQ).multiplyToRef(localQ(elbow, _elbQ), _fore);
  let lag = left ? p.foreLagL : p.foreLagR;
  if (!lag) { lag = fore.clone(); if (left) p.foreLagL = lag; else p.foreLagR = lag; }
  const k = 1 - Math.exp(-MOVE_RATE.arm * CHAIN.wrist * p.lastDt);
  Quaternion.SlerpToRef(lag, fore, k, lag);
  // 差分 = 前腕から見た手首のローカル回転
  _fore.conjugateInPlace();
  _fore.multiplyToRef(lag, _lead);
  // 遅れ過ぎは折れて見えるので角度で頭打ち。IK で手先を乗せている間は薄める
  // （手のひらがボールから外れる）。
  const damp = (left ? p.ikL : p.ikR) ? CHAIN.ikDamp : 1;
  const ang = 2 * Math.acos(Math.min(1, Math.abs(_lead.w)));
  const t = Math.min(1, ang > 1e-4 ? WRIST_MAX / ang : 1) * damp;
  if (!wrist.rotationQuaternion) wrist.rotationQuaternion = Quaternion.Identity();
  Quaternion.SlerpToRef(_IDENT, _lead, t, wrist.rotationQuaternion);
}

/** 手首を前腕へ追従させる（毎フレーム、肩・肘を書き終えたあとに1回）。 */
Player.prototype.updateWristTrail = function(): void {
    wristTrail(this, this.armPivotL, this.elbowL, this.wristL, true);
    wristTrail(this, this.armPivotR, this.elbowR, this.wristR, false);
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
