// 選手の腕・手アニメーション（プロトタイプ拡張で Player に紐づけ）。メソッド本体は
// entities.ts から逐語移動（this は Player インスタンスのまま）。呼び出し側 p.runArms()
// 等は不変。副作用 import で prototype を注入するため、game.ts / main.ts が本ファイルを
// import する。
import { TransformNode, Vector3, Quaternion } from "@babylonjs/core";
import { HUD_OPTS } from "./config";
import { clamp } from "./util";
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

  // elbow bend: forward (toward the chest, -numberSide·Z), matching the arm/leg
  // convention. Straight (0) whenever the hand must reach the ball.
  // The FOREARM (elbow) eases toward its bend at the same rate as the upper arm
  // when a slew is active — so the two segments move independently, the forearm
  // straightening/folding at its own controlled speed rather than snapping.
Player.prototype.bendElbow = function(node: TransformNode, amount: number): void {
    node.rotation.y = 0; node.rotation.z = 0;   // clear any cradle-inward yaw from a prior pose
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
    // measured velocity against the chest direction (local -ns·Z, yawed by the
    // root AND the torso twist): clearly negative = running backwards
    const th = this.root.rotation.y + this.torsoTwist;
    const chestX = -ns * Math.sin(th), chestZ = -ns * Math.cos(th);
    const along = this.velX * chestX + this.velZ * chestZ;   // m/s toward the chest
    this.backArms = this.backArms ? along < -0.2 : along < -0.6;
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
    if (this.backArms) {
      const fl = Math.sin(this.stridePhase) * 0.2;   // small alternating flutter
      this.setArmDir(this.armPivotL, -0.6, -0.85 + fl, -ns * 0.3);
      this.setArmDir(this.armPivotR, 0.6, -0.85 - fl, -ns * 0.3);
      this.bendElbow(this.elbowL, 0.2);              // near-straight, hands ready
      this.bendElbow(this.elbowR, 0.2);
      return;
    }
    const human = HUD_OPTS.model === "human";
    const amp = (0.3 + frac * 0.55) * (human ? 1 : 0.5);
    const aL = Math.sin(this.stridePhase + Math.PI) * amp * ns;   // left arm ↔ right leg
    const aR = Math.sin(this.stridePhase) * amp * ns;
    this.armPivotL.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), aL);
    this.armPivotR.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), aR);
    const carry = (0.6 + frac * 0.5) * (human ? 1 : 0.6);   // elbows carried bent like a runner
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
    // twist the chest toward the ball (capped at the torso's reach) — this is
    // what carries the leading shoulder out and lets the hand reach farther
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
    // lead with the hand on the side the ball now sits (near shoulder), elbow
    // LOCKED STRAIGHT for maximum extension
    const right = this.dribbleWithRight(world);
    const lead = right ? this.armPivotR : this.armPivotL;
    const leadElbow = right ? this.elbowR : this.elbowL;
    const back = right ? this.armPivotL : this.armPivotR;
    const backElbow = right ? this.elbowL : this.elbowR;
    this.aimArm(lead, world);
    leadElbow.rotation.set(0, 0, 0);
    // the trailing arm pulls back behind the hip (counterweight to the lunge)
    back.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.6);
    this.bendElbow(backElbow, 0.5);
};

Player.prototype.holdBallHands = function(world: Vector3, sep = 0.16): void {
    const dx = world.x - this.pos.x, dz = world.z - this.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    let lx = -dz / l, lz = dx / l;                      // horizontal perpendicular to the hold
    // point the lateral toward the body's RIGHT (local +X → world (cosθ, -sinθ),
    // the same frame aimArm uses) so the hands never cross
    const th = this.root.rotation.y + this.torsoTwist;
    if (lx * Math.cos(th) - lz * Math.sin(th) < 0) { lx = -lx; lz = -lz; }
    this.aimArm(this.armPivotR, new Vector3(world.x + lx * sep, world.y, world.z + lz * sep));
    this.aimArm(this.armPivotL, new Vector3(world.x - lx * sep, world.y, world.z - lz * sep));
    // 抱え込み: the CLOSER the ball is to the body, the more the elbows bend so it's
    // CRADLED in to the chest rather than held out on straight arms — a ball out in
    // front (reaching for an incoming pass) keeps the arms extended, then as it
    // arrives the elbows fold and bring it in close. A ball held OVERHEAD (a jump-
    // pass wind-up) stays on near-straight arms, not cradled.
    // MODERATE bend so the elbows are visibly bent yet the HANDS still cup the ball
    // at its sides (ball sits BETWEEN them) — too tight a fold pulls the palms off
    // the ball and it floats out front. Reaching for an incoming pass stays straight.
    const overhead = world.y > 1.5;
    const bend = overhead ? 0.1 : clamp(1.2 - l * 1.5, 0, 0.55);
    this.bendElbow(this.elbowR, bend);
    this.bendElbow(this.elbowL, bend);
    // 内側へ: swing each forearm toward the CENTRE (the ball) so the two hands cup
    // it from the sides. The forearm hangs along the elbow's local −Y, so the
    // left/right swing is rotation.Z (rotation.Y would only roll it about its own
    // length). Left/right (X) does NOT flip with numberSide — only front/back (Z)
    // does — so this is a CONSTANT sign per arm, NOT ×numberSide (that ×numberSide
    // was the team-dependent bug). +rot.z swings −Y toward +X, so the RIGHT arm
    // (at +X) needs − to come in, the LEFT +.
    const inward = overhead ? 0 : bend * 0.7;
    this.elbowR.rotation.z = -inward;
    this.elbowL.rotation.z = inward;
};

Player.prototype.reachDribble = function(world: Vector3, useRight: boolean, rate = 0): void {
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.armRateCap = rate;   // > 0 → the hand re-places at dribble-accuracy speed
    this.aimArm(near, world);
    this.bendElbow(nearElbow, 0);   // forearm straightens toward the ball, eased
    this.armRateCap = 0;
    far.rotationQuaternion = Quaternion.Identity();
    this.bendElbow(farElbow, 0.28);
};

Player.prototype.armsWide = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -1, -0.35, 0.35);
    this.setArmDir(this.armPivotR, 1, -0.35, 0.35);
    this.bendElbow(this.elbowL, 0);   // forearms straighten out, eased
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
};

Player.prototype.guardDrive = function(world: Vector3, useRight: boolean, rate = 0): void {
    this.armRateCap = rate;
    const near = useRight ? this.armPivotR : this.armPivotL;
    const nearElbow = useRight ? this.elbowR : this.elbowL;
    const far = useRight ? this.armPivotL : this.armPivotR;
    const farElbow = useRight ? this.elbowL : this.elbowR;
    this.aimArm(near, world);                 // front hand on the ball
    this.bendElbow(nearElbow, 0);             // forearm straightens, eased
    this.setArmDir(far, useRight ? -0.75 : 0.75, -0.55, 0.15);   // off hand low & out
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
    this.setArmDir(near, s * 0.85, 0.35, -0.4);   // out, up, angled behind him
    this.bendElbow(nearElbow, 0);                  // deny arm straightens, eased
    this.setArmDir(far, -s * 0.3, -0.5, 0.1);      // trail arm relaxed and low
    this.bendElbow(farElbow, 0.2);
    this.armRateCap = 0;
};

Player.prototype.handsUp = function(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -0.14, 1, 0.06);
    this.setArmDir(this.armPivotR, 0.14, 1, 0.06);
    this.bendElbow(this.elbowL, 0);   // forearms straighten up, eased
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
};

  // Point an arm from its shoulder toward a world point — direction only, so the
  // arm keeps its fixed length. The root may now carry a yaw (players turn to face
  // the play), so the shoulder's world position rotates with the body, and the
  // desired reach — computed in world space — is converted back into the root's
  // local frame before it becomes the arm's (local) aim. R_y(θ): local +Z →
  // (sinθ,0,cosθ), local +X → (cosθ,0,-sinθ). At θ=0 this is the old direct maths.
Player.prototype.aimArm = function(pivot: TransformNode, world: Vector3): void {
    // shoulders ride the twisting torso — their frame is the root yaw + twist
    const th = this.root.rotation.y + this.torsoTwist;
    const c = Math.cos(th), s = Math.sin(th);
    const px = pivot.position.x, py = pivot.position.y * this.root.scaling.y, pz = pivot.position.z;
    // shoulder world = root + R_y(θ)·(local shoulder offset)
    const sx = this.root.position.x + (c * px + s * pz);
    const sy = this.root.position.y + py;
    const sz = this.root.position.z + (-s * px + c * pz);
    // reach direction in world → rotate into the root's local frame (R_y(-θ))
    const wx = world.x - sx, wy = world.y - sy, wz = world.z - sz;
    this.setArmDir(pivot, c * wx - s * wz, wy, s * wx + c * wz);
};

Player.prototype.setArmDir = function(pivot: TransformNode, dx: number, dy: number, dz: number): void {
    const len = Math.hypot(dx, dy, dz) || 1;
    const target = aimDownTo(dx / len, dy / len, dz / len);
    const cur = pivot.rotationQuaternion;
    // Rate-limited (defensive) re-orient: ease the arm toward the target no faster
    // than armRateCap rad/s, so a low-defence player's hands lag on the switch. A
    // snap write (armRateCap 0, or no current orientation) keeps ball arms crisp.
    if (this.armRateCap > 0 && cur) {
      // Exponential ease — move a fixed FRACTION toward the target each frame, so
      // small target jitter (a bouncing ball, a read flickering between poses) is
      // damped too, not only big switches. The fraction (settling speed) scales
      // with defence: a weak defender's hands drift, an elite one's snap in.
      const k = 1 - Math.exp(-this.armRateCap * this.lastDt);
      pivot.rotationQuaternion = Quaternion.Slerp(cur, target, k);
    } else {
      pivot.rotationQuaternion = target;
    }
};

