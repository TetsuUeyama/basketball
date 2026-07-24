// 選手のリアクション（ファウル/守備成功/落胆/ベンチ待機）アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { TransformNode, Mesh, Vector3, Quaternion } from "@babylonjs/core";
import { HUD_OPTS } from "./config";
import { clamp, rand, chance } from "./util";
import { Player, aimDownTo } from "./player";

declare module "./player" {
  interface Player {
    benchIdle(dt: number, ballX: number, ballZ: number): void;
    dejectedPose(): void;
    foulReaction(kind: "hurt" | "and1", pushX?: number, pushZ?: number, strength?: number): void;
    poseFoulReaction(): void;
    defWin(kind: "block" | "steal" | "stop"): void;
    poseDefWin(): void;
  }
}

Player.prototype.benchIdle = function(dt: number, ballX: number, ballZ: number): void {
    this.benchGazeT -= dt;
    if (this.benchGazeT <= 0) {
      this.benchGazeT = rand(0.8, 2.5);
      this.benchGazeOff = rand(-0.22, 0.22);
    }
    this.faceToward(ballX, ballZ, this.benchGazeOff);

    this.updateJump(dt);
    if (this.benchArmT > 0) {
      this.benchArmT -= dt;
      if (this.benchArmT <= 0) this.handsRest();  // gesture over — settle down
    }
    this.benchActT -= dt;
    if (this.benchActT <= 0) {
      this.benchActT = rand(2.0, 7.0);
      const roll = Math.random();
      if (roll < 0.35) {
        this.jump(rand(0.06, 0.16), rand(0.25, 0.4));      // a little hop
      } else if (roll < 0.6) {
        this.reach(new Vector3(this.pos.x + rand(-0.4, 0.4), rand(2.1, 2.9),
          this.pos.z + rand(-0.4, 0.4)));                   // one hand comes up
        this.benchArmT = rand(0.4, 1.0);
      } else if (roll < 0.8) {
        this.armsWide();                                    // arms spread wide
        this.benchArmT = rand(0.4, 0.9);
      } else {
        this.reach(new Vector3(this.pos.x, rand(2.6, 3.2), this.pos.z), true);
        this.benchArmT = rand(0.35, 0.8);                   // both hands, briefly
      }
    }
    this.sync();
};

Player.prototype.dejectedPose = function(): void {
    const Pt = -this.numberSide * 0.42;                    // chest tips forward
    const cut = Player.ACORN_CUT;
    this.torsoNode.rotation.x = Pt;
    this.torsoNode.rotation.y = 0;                         // no play-twist while slumped
    this.torsoTwist = 0;
    // hinge the lean at the WAIST cut (not the feet): offset the torso so the
    // point at the waist stays put and only the upper body leans over it — the
    // waist and hips stay straight instead of the whole torso slanting.
    this.torsoNode.position.set(0, cut * (1 - Math.cos(Pt)), -cut * Math.sin(Pt));
    this.flinchPitch = 0;                                  // root (hips/legs) stays upright
    // keep the acorn waist itself vertical under the leaning chest
    this.acornWaistPivot.rotation.x = -Pt;
    // arms hang straight DOWN in world despite the torso lean (compensate the pitch)
    this.setArmDir(this.armPivotL, -0.14, -Math.cos(Pt), Math.sin(Pt));
    this.setArmDir(this.armPivotR, 0.14, -Math.cos(Pt), Math.sin(Pt));
    this.bendElbow(this.elbowL, 0.05);
    this.bendElbow(this.elbowR, 0.05);
};

Player.prototype.foulReaction = function(kind: "hurt" | "and1", pushX = 0, pushZ = 0, strength = 0.5): void {
    this.foulReactKind = kind;
    const s = clamp(strength, 0, 1);
    this.foulStrength = s;
    const pl = Math.hypot(pushX, pushZ);
    if (pl > 0.01) { this.foulPushX = pushX / pl; this.foulPushZ = pushZ / pl; }
    else { this.foulPushX = this.foulPushZ = 0; }        // no direction → back-rock
    // a HARD, off-centre hit can BLOW him back — a little hop off his feet and a
    // big stagger; a lighter one is just a stumble step; most are neither.
    const hard = kind === "hurt" && pl > 0.01;
    const knock = hard && s > 0.45 && chance(0.25 + (s - 0.45) * 1.1);   // blown back
    // most hard contact makes him GIVE GROUND — a stagger of a few steps (the
    // stagger drives real speed, so updateLegs actually steps the feet)
    this.foulStumble = hard && (knock || chance(0.4 + s * 0.5));
    // a harder hit sells longer; the stagger/knockback needs time to step & land
    this.foulReactDur = this.foulReactT =
      kind === "and1" ? 1.1 : knock ? (1.2 + s * 0.5) : (0.85 + s * 0.6);
    if (kind === "and1") this.jump(0.22, 0.4);           // the flex hop
    else if (knock) this.jump(0.16 + s * 0.18, 0.5 + s * 0.2);   // popped off the floor
    if (this.foulStumble) {
      const step = knock ? (1.1 + s * 1.3) : (0.55 + s * 0.8);   // a few steps back
      this.foulStaggerX = this.foulPushX * step;
      this.foulStaggerZ = this.foulPushZ * step;
    } else { this.foulStaggerX = this.foulStaggerZ = 0; }
};

Player.prototype.poseFoulReaction = function(): void {
    if (this.foulReactT <= 0) {
      this.flinchPitch = this.flinchRoll = 0;   // reaction over (or interrupted) — stand back up
      return;
    }
    const k = this.foulReactDur > 0 ? 1 - this.foulReactT / this.foulReactDur : 1;
    const env = Math.sin(Math.min(1, k * 1.15) * Math.PI);   // swell in, ease out
    if (this.foulReactKind === "and1") {
      // the flex: both fists up beside the head, elbows folded hard
      this.setArmDir(this.armPivotL, -0.7, 0.9, 0);
      this.setArmDir(this.armPivotR, 0.7, 0.9, 0);
      this.bendElbow(this.elbowL, 1.35);
      this.bendElbow(this.elbowR, 1.35);
      this.flinchPitch = this.flinchRoll = 0;
    } else {
      // sold contact: arms fly out low to catch balance
      this.setArmDir(this.armPivotL, -1, -0.5, 0.25);
      this.setArmDir(this.armPivotR, 1, -0.5, 0.25);
      this.elbowL.rotation.set(0, 0, 0); this.elbowR.rotation.set(0, 0, 0);
      if (this.foulPushX !== 0 || this.foulPushZ !== 0) {
        // DIRECTIONAL rock: tip the body in the direction the hit sent him, harder
        // for a stronger contact. World push → yaw-local pitch/roll (same
        // convention as the lean tilt) so the whole figure leans off the hit.
        const th = this.root.rotation.y;
        const c = Math.cos(th), s = Math.sin(th);
        const m = (0.16 + this.foulStrength * 0.34) * env;   // tilt amount
        const wx = this.foulPushX * m, wz = this.foulPushZ * m;
        this.flinchPitch = wx * s + wz * c;                  // tip toward local +Z
        this.flinchRoll = -(wx * c - wz * s);                // and toward local +X
      } else {
        // no direction info → the old straight back-rock
        this.flinchPitch = this.numberSide * 0.22 * env;
        this.flinchRoll = 0;
      }
    }
};

Player.prototype.defWin = function(kind: "block" | "steal" | "stop"): void {
    if (this.foulReactT > 0) return;
    this.defWinKind = kind;
    this.defWinDur = this.defWinT = kind === "block" ? 1.25 : kind === "steal" ? 1.0 : 0.8;
    // a small emphatic hop only if he's grounded — a blocker who is still up on
    // the swat keeps his existing leap (this must not stomp that bigger jump)
    if (kind === "block" && !this.airborne) this.jump(0.14, 0.4);
};

Player.prototype.poseDefWin = function(): void {
    if (this.defWinT <= 0) return;
    const k = this.defWinDur > 0 ? 1 - this.defWinT / this.defWinDur : 1;
    const env = Math.sin(Math.min(1, k * 1.25) * Math.PI);     // swell in, ease out
    const pump = Math.max(0, Math.sin(k * Math.PI * 3));       // a quick double-pump
    if (this.defWinKind === "block") {
      // triumphant: both fists up beside the head (the rejection flex)
      this.setArmDir(this.armPivotL, -0.55, 0.95, 0.05);
      this.setArmDir(this.armPivotR, 0.55, 0.95, 0.05);
      this.bendElbow(this.elbowL, 1.1 + pump * 0.3);
      this.bendElbow(this.elbowR, 1.1 + pump * 0.3);
      this.flinchPitch = this.numberSide * 0.10 * env;          // slight chest-up rock back
      this.flinchRoll = 0;
    } else if (this.defWinKind === "steal") {
      // low double fist-pump — fists clenched at the ribs, a couple of quick pumps
      this.setArmDir(this.armPivotL, -0.35, -0.15 + pump * 0.25, 0.2);
      this.setArmDir(this.armPivotR, 0.35, -0.15 + pump * 0.25, 0.2);
      this.bendElbow(this.elbowL, 1.25);
      this.bendElbow(this.elbowR, 1.25);
      this.flinchPitch = -this.numberSide * 0.12 * env;         // lean into it (forward)
      this.flinchRoll = 0;
    } else {
      // STOP / wall: held his ground — arms out low and forward, chest set, braced
      this.setArmDir(this.armPivotL, -0.9, -0.35, 0.4);
      this.setArmDir(this.armPivotR, 0.9, -0.35, 0.4);
      this.bendElbow(this.elbowL, 0.15);
      this.bendElbow(this.elbowR, 0.15);
      this.flinchPitch = -this.numberSide * 0.14 * env;         // brace forward into the drive
      this.flinchRoll = 0;
    }
};

