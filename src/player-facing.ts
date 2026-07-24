// 選手の向き/ツイスト（胸・頭・体の向き）アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { clamp } from "./util";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    twistToward(x: number, z: number, dt: number, maxTwist?: number, rate?: number): void;
    lookToward(x: number, z: number, dt: number, rate?: number): void;
    faceChestToward(x: number, z: number): void;
    relativeChestAngle(x: number, z: number): number;
    resetTwist(): void;
    faceToward(x: number, z: number, yawOffset?: number): void;
    faceSmooth(x: number, z: number, maxStep: number): void;
    resetFacing(): void;
  }
}

Player.prototype.twistToward = function(x: number, z: number, dt: number, maxTwist = Player.TWIST_MAX, rate = 10): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      let d = Math.atan2(-s * fx, -s * fz) - this.root.rotation.y;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      want = clamp(d, -maxTwist, maxTwist);
    }
    const step = rate * 0.5 * dt;   // 上半身は半分のレートで回る——胸を新しい向きへ
                                     // ツイストするのに2倍の時間がかかる
    this.torsoTwist += clamp(want - this.torsoTwist, -step, step);
    this.torsoNode.rotation.y = this.torsoTwist;
};

Player.prototype.lookToward = function(x: number, z: number, dt: number, rate = 11): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      let d = Math.atan2(-s * fx, -s * fz) - this.root.rotation.y - this.torsoTwist;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      want = clamp(d, -Player.HEAD_MAX, Player.HEAD_MAX);
    }
    this.headYaw += clamp(want - this.headYaw, -rate * dt, rate * dt);
    this.headNode.rotation.y = this.headYaw;
};

Player.prototype.faceChestToward = function(x: number, z: number): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;
    const want = Math.atan2(-s * fx, -s * fz);       // 目標とする胸のワールドヨー
    let twist = want - this.root.rotation.y;
    while (twist > Math.PI) twist -= 2 * Math.PI;
    while (twist < -Math.PI) twist += 2 * Math.PI;
    if (Math.abs(twist) > Player.TWIST_MAX) {          // 胴の可動域を超える → 超過分は足を回す
      this.root.rotation.y += twist - Math.sign(twist) * Player.TWIST_MAX;
      twist = Math.sign(twist) * Player.TWIST_MAX;
    }
    this.torsoTwist = twist;
    this.torsoNode.rotation.y = twist;
};

Player.prototype.relativeChestAngle = function(x: number, z: number): number {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 1e-4) return 0;
    const want = Math.atan2(-s * fx, -s * fz);         // 目標を向くためのワールドヨー
    const chest = this.root.rotation.y + this.torsoTwist;
    let d = want - chest;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
};

Player.prototype.resetTwist = function(): void {
    this.torsoTwist = 0;
    this.torsoNode.rotation.y = 0;
    this.headYaw = 0;                                   // 頭も真っ直ぐにする
    if (this.headNode) this.headNode.rotation.y = 0;
    this.torsoNode.rotation.x = 0;   // 落胆で前かがみになった分をクリア
    this.torsoNode.position.set(0, 0, 0);   // 落胆の腰ヒンジオフセットも
    if (!this.seated) this.acornWaistPivot.rotation.x = 0;   // 腰を垂直に戻す
};

Player.prototype.faceToward = function(x: number, z: number, yawOffset = 0): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.01) return;
    const s = this.numberSide;
    // RotationY(θ) はローカル +Z を (sinθ, 0, cosθ) へ写す。胸はローカル -s·Z
    this.root.rotation.y = Math.atan2(-s * fx, -s * fz) + yawOffset;
};

Player.prototype.faceSmooth = function(x: number, z: number, maxStep: number): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;   // 目標が自分の真上——向きを保持
    const s = this.numberSide;
    const target = Math.atan2(-s * fx, -s * fz);
    let d = target - this.root.rotation.y;
    while (d > Math.PI) d -= 2 * Math.PI;             // 最短の角度経路
    while (d < -Math.PI) d += 2 * Math.PI;
    this.root.rotation.y += clamp(d, -maxStep, maxStep);
};

Player.prototype.resetFacing = function(): void {
    this.root.rotation.y = 0;
    this.root.rotation.x = this.root.rotation.z = 0;   // 直立もさせる
    this.tiltX = this.tiltZ = 0;
    this.lean = 0;
    this.flinchPitch = 0;
    this.resetTwist();
};

