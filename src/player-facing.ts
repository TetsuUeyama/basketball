// 選手の向き/ツイスト（胸・頭・体の向き）アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { TransformNode, Mesh, Vector3, Quaternion } from "@babylonjs/core";
import { HUD_OPTS } from "./config";
import { clamp, rand } from "./util";
import { Player, aimDownTo } from "./player";

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
    const step = rate * 0.5 * dt;   // the upper body turns at HALF rate — it takes twice
                                     // as long to twist the chest to a new facing
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
    const want = Math.atan2(-s * fx, -s * fz);       // desired chest world yaw
    let twist = want - this.root.rotation.y;
    while (twist > Math.PI) twist -= 2 * Math.PI;
    while (twist < -Math.PI) twist += 2 * Math.PI;
    if (Math.abs(twist) > Player.TWIST_MAX) {          // beyond the torso's reach → turn the feet the excess
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
    const want = Math.atan2(-s * fx, -s * fz);         // world yaw to face the target
    const chest = this.root.rotation.y + this.torsoTwist;
    let d = want - chest;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
};

Player.prototype.resetTwist = function(): void {
    this.torsoTwist = 0;
    this.torsoNode.rotation.y = 0;
    this.headYaw = 0;                                   // straighten the head too
    if (this.headNode) this.headNode.rotation.y = 0;
    this.torsoNode.rotation.x = 0;   // clear any dejected forward hunch
    this.torsoNode.position.set(0, 0, 0);   // and the dejected waist-hinge offset
    if (!this.seated) this.acornWaistPivot.rotation.x = 0;   // waist back to vertical
};

Player.prototype.faceToward = function(x: number, z: number, yawOffset = 0): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.01) return;
    const s = this.numberSide;
    // RotationY(θ) maps local +Z to (sinθ, 0, cosθ); the chest is local -s·Z
    this.root.rotation.y = Math.atan2(-s * fx, -s * fz) + yawOffset;
};

Player.prototype.faceSmooth = function(x: number, z: number, maxStep: number): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;   // target on top of us — hold facing
    const s = this.numberSide;
    const target = Math.atan2(-s * fx, -s * fz);
    let d = target - this.root.rotation.y;
    while (d > Math.PI) d -= 2 * Math.PI;             // shortest angular path
    while (d < -Math.PI) d += 2 * Math.PI;
    this.root.rotation.y += clamp(d, -maxStep, maxStep);
};

Player.prototype.resetFacing = function(): void {
    this.root.rotation.y = 0;
    this.root.rotation.x = this.root.rotation.z = 0;   // stand up straight, too
    this.tiltX = this.tiltZ = 0;
    this.lean = 0;
    this.flinchPitch = 0;
    this.resetTwist();
};

