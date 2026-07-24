// 選手の腕・手アニメーション（プロトタイプ拡張で Player に紐づけ）。メソッド本体は
// entities.ts から逐語移動（this は Player インスタンスのまま）。呼び出し側 p.runArms()
// 等は不変。副作用 import で prototype を注入するため、game.ts / main.ts が本ファイルを
// import する。
import { TransformNode, Vector3, Quaternion } from "@babylonjs/core";
import { HUD_OPTS } from "../../config";
import { clamp } from "../../util";
import { Player, aimDownTo } from "./player";

declare module "./player" {
  interface Player {
    bendElbow(node: TransformNode, amount: number): void;
    handsRest(): void;
    runArms(): void;
    reach(world: Vector3, both?: boolean): void;
    digReach(world: Vector3): void;
    holdBallHands(world: Vector3, sep?: number): void;
    reachDribble(world: Vector3, useRight: boolean, rate?: number): void;
    armsWide(rate?: number): void;
    guardDrive(world: Vector3, useRight: boolean, rate?: number): void;
    denyLane(useRight: boolean, rate?: number): void;
    handsUp(rate?: number): void;
    aimArm(pivot: TransformNode, world: Vector3): void;
    setArmDir(pivot: TransformNode, dx: number, dy: number, dz: number): void;
  }
}

  // 肘の曲げ: 前方（胸に向かって、-numberSide·Z）へ、腕/脚の規約に合わせる。
  // 手がボールに届く必要があるときは常に真っ直ぐ(0)。
  // スルー(slew)が有効なとき、前腕(肘)は上腕と同じレートで曲げ目標へイーズする——
  // 2つのセグメントは独立して動き、前腕はスナップせず自身の制御された速度で
  // 伸展/屈曲する。
Player.prototype.bendElbow = function(node: TransformNode, amount: number): void {
    node.rotation.y = 0; node.rotation.z = 0;   // 前のポーズから残った抱え込み方向のヨーをクリア
    const target = amount * this.numberSide;
    if (this.armRateCap > 0) {
      const k = 1 - Math.exp(-this.armRateCap * this.lastDt);
      node.rotation.x += (target - node.rotation.x) * k;
    } else {
      node.rotation.x = target;
    }
};

Player.prototype.handsRest = function(): void {
    this.armPivotL.rotationQuaternion = Quaternion.Identity();
    this.armPivotR.rotationQuaternion = Quaternion.Identity();
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
    this.bendElbow(this.elbowL, 0.28);
    this.bendElbow(this.elbowR, 0.28);
};

Player.prototype.runArms = function(): void {
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    if (frac < 0.16) { this.backArms = false; this.handsRest(); return; }
    const ns = this.numberSide;
    // 胸の向き（ローカル -ns·Z、root と胴のツイスト両方でヨー）に対する計測速度:
    // 明確に負 = 後ろ向きに走っている
    const th = this.root.rotation.y + this.torsoTwist;
    const chestX = -ns * Math.sin(th), chestZ = -ns * Math.cos(th);
    const along = this.velX * chestX + this.velZ * chestZ;   // 胸方向への m/s
    this.backArms = this.backArms ? along < -0.2 : along < -0.6;
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
    if (this.backArms) {
      const fl = Math.sin(this.stridePhase) * 0.2;   // 小さく交互に揺らす
      this.setArmDir(this.armPivotL, -0.6, -0.85 + fl, -ns * 0.3);
      this.setArmDir(this.armPivotR, 0.6, -0.85 - fl, -ns * 0.3);
      this.bendElbow(this.elbowL, 0.2);              // ほぼ真っ直ぐ、手は構え
      this.bendElbow(this.elbowR, 0.2);
      return;
    }
    const human = HUD_OPTS.model === "human";
    const amp = (0.3 + frac * 0.55) * (human ? 1 : 0.5);
    const aL = Math.sin(this.stridePhase + Math.PI) * amp * ns;   // 左腕 ↔ 右脚
    const aR = Math.sin(this.stridePhase) * amp * ns;
    this.armPivotL.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), aL);
    this.armPivotR.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), aR);
    const carry = (0.6 + frac * 0.5) * (human ? 1 : 0.6);   // ランナーのように肘を曲げて保つ
    this.bendElbow(this.elbowL, carry);
    this.bendElbow(this.elbowR, carry);
};

Player.prototype.reach = function(world: Vector3, both = false): void {
    this.aimArm(this.armPivotR, world);
    this.elbowR.rotation.set(0, 0, 0);
    if (both) { this.aimArm(this.armPivotL, world); this.elbowL.rotation.set(0, 0, 0); }
    else { this.armPivotL.rotationQuaternion = Quaternion.Identity(); this.bendElbow(this.elbowL, 0.28); }
};

Player.prototype.digReach = function(world: Vector3): void {
    // 胴の可動域でキャップしつつ胸をボールへツイスト——これが先行する肩を
    // 前に出し、手をより遠くへ届かせる
    const s = this.numberSide;
    const fx = world.x - this.pos.x, fz = world.z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) > 0.05) {
      const want = Math.atan2(-s * fx, -s * fz);
      let twist = want - this.root.rotation.y;
      while (twist > Math.PI) twist -= 2 * Math.PI;
      while (twist < -Math.PI) twist += 2 * Math.PI;
      twist = clamp(twist, -Player.TWIST_MAX, Player.TWIST_MAX);
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
    leadElbow.rotation.set(0, 0, 0);
    // 後ろ側の腕は腰の後ろへ引く（踏み込みへのカウンターウェイト）
    back.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.6);
    this.bendElbow(backElbow, 0.5);
};

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
    // 抱え込み: ボールが体に近いほど肘を曲げ、真っ直ぐな腕で
    // 前に持つのではなく胸へ抱え込む——前方に出たボール
    // （来るパスへ手を伸ばす）は腕を伸ばしたまま、到達すると
    // 肘が畳まれて近くへ引き寄せる。頭上に保持したボール
    // （ジャンプパスの振りかぶり）は抱え込まず、ほぼ真っ直ぐな腕の
    // まま。肘が目に見えて曲がりつつ手はボールの両側を包む
    // （ボールは手の間に収まる）ように中程度の曲げ——畳みすぎると
    // 手のひらがボールから離れて前に浮く。来るパスへ手を伸ばすときは真っ直ぐのまま。
    const overhead = world.y > 1.5;
    const bend = overhead ? 0.1 : clamp(1.2 - l * 1.5, 0, 0.55);
    this.bendElbow(this.elbowR, bend);
    this.bendElbow(this.elbowL, bend);
    // 内側へ: 2つの手が両側からボールを包むよう、各前腕を中央
    // （ボール）へ振る。前腕は肘のローカル −Y に沿って垂れるので、
    // 左右の振りは rotation.Z（rotation.Y では自身の長さ軸で転がるだけ）。
    // 左右(X)は numberSide で反転しない——前後(Z)だけが反転する——ので
    // 腕ごとに一定の符号で、×numberSide ではない（その ×numberSide が
    // チーム依存のバグだった）。+rot.z は −Y を +X へ振るので、右腕
    // (+X 側) は内側へ来るのに −、左腕は + が必要。
    const inward = overhead ? 0 : bend * 0.7;
    this.elbowR.rotation.z = -inward;
    this.elbowL.rotation.z = inward;
};

Player.prototype.reachDribble = function(world: Vector3, useRight: boolean, rate = 0): void {
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.armRateCap = rate;   // > 0 → 手はドリブル精度の速度で置き直す
    this.aimArm(near, world);
    this.bendElbow(nearElbow, 0);   // 前腕がボールへ向かって伸びる、イーズ
    this.armRateCap = 0;
    far.rotationQuaternion = Quaternion.Identity();
    this.bendElbow(farElbow, 0.28);
};

Player.prototype.armsWide = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -1, -0.35, 0.35);
    this.setArmDir(this.armPivotR, 1, -0.35, 0.35);
    this.bendElbow(this.elbowL, 0);   // 前腕が外へ伸びる、イーズ
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
};

Player.prototype.guardDrive = function(world: Vector3, useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.aimArm(near, world);                 // 前の手をボールに
    this.bendElbow(nearElbow, 0);             // 前腕が伸びる、イーズ
    this.setArmDir(far, useRight ? -0.75 : 0.75, -0.55, 0.15);   // 逆の手は低く外へ
    this.bendElbow(farElbow, 0);
    this.armRateCap = 0;
};

Player.prototype.denyLane = function(useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const s = useRight ? 1 : -1;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.setArmDir(near, s * 0.85, 0.35, -0.4);   // 外へ、上へ、後方へ角度をつける
    this.bendElbow(nearElbow, 0);                  // ディナイの腕が伸びる、イーズ
    this.setArmDir(far, -s * 0.3, -0.5, 0.1);      // 後ろ側の腕はリラックスして低く
    this.bendElbow(farElbow, 0.2);
    this.armRateCap = 0;
};

Player.prototype.handsUp = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -0.14, 1, 0.06);
    this.setArmDir(this.armPivotR, 0.14, 1, 0.06);
    this.bendElbow(this.elbowL, 0);   // 前腕が上へ伸びる、イーズ
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
};

  // 肩からワールド座標の点へ腕を向ける——方向のみなので腕は固定長を保つ。
  // root はヨーを持ちうる（選手はプレーへ向き直る）ため、肩のワールド位置は
  // 体とともに回転し、目標のリーチ——ワールド空間で計算——を腕の（ローカル）
  // 照準にする前に root のローカルフレームへ変換し直す。R_y(θ): ローカル +Z →
  // (sinθ,0,cosθ)、ローカル +X → (cosθ,0,-sinθ)。θ=0 では従来の直接計算に
  // なる。
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

