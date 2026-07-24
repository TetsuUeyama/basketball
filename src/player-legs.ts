// 選手の脚・ジャンプ・着席の移動/姿勢アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { TransformNode, Mesh, Vector3, Quaternion } from "@babylonjs/core";
import { HUD_OPTS } from "./config";
import { clamp, rand } from "./util";
import { rate } from "./attributes";
import { Player, aimDownTo } from "./player";

declare module "./player" {
  interface Player {
    jump(height: number, dur: number, leapX?: number, leapZ?: number): void;
    updateJump(dt: number): void;
    updateLegs(dt: number): void;
    updateAcornFeet(dt: number): void;
    syncAcornLegs(): void;
    foldSeatedLegs(): void;
    sit(): void;
    stand(): void;
    foldAcornSeat(): void;
    unfoldAcornSeat(): void;
  }
}

Player.prototype.jump = function(height: number, dur: number, leapX = 0, leapZ = 0): void {
    // still gathering balance from the last landing — can't leap yet
    if (this.landT > 0) return;
    // don't restart a bigger jump with a smaller one mid-air
    if (this.jumpRemaining > 0 && height <= this.jumpHeight) return;
    this.jumpHeight = height;
    this.jumpDur = dur;
    this.jumpRemaining = dur;
    this.leapX = leapX;
    this.leapZ = leapZ;
};

Player.prototype.updateJump = function(dt: number): void {
    if (this.jumpRemaining > 0) {
      // a diagonal leap carries him horizontally at a steady rate over the flight
      // (ballistic: constant horizontal velocity), so total travel = (leapX,leapZ)
      if (this.jumpDur > 0 && (this.leapX !== 0 || this.leapZ !== 0)) {
        const f = Math.min(dt, this.jumpRemaining) / this.jumpDur;
        this.pos.x += this.leapX * f;
        this.pos.z += this.leapZ * f;
      }
      this.jumpRemaining = Math.max(0, this.jumpRemaining - dt);
      if (this.jumpRemaining === 0) {
        // landing 硬直: the centre of gravity has to settle before he can re-jump or
        // explode. Driven by クイックネス(敏捷性) AND ジャンプ力 together — both elite
        // reset FAST (~0.3 s), and it climbs steeply as EITHER drops (both low ≈ 2.5 s
        // for a full jump). A ジャンプ力 player thus leaps HIGH (jump() heights) AND
        // gathers quickly for the next one. A bigger leap resets a touch slower, a
        // little hop faster. Blocks a re-jump and drags the first steps (accelSpeed).
        const ability = (rate(this.attr.agility) + rate(this.attr.jump)) / 2;   // 1 = elite both
        const base = 0.3 + Math.pow(1 - ability, 0.85) * 2.2;                    // 0.3 .. 2.5 (full jump)
        const heightScale = clamp(0.5 + this.jumpHeight * 0.9, 0.45, 1.3);
        this.landDur = this.landT = clamp(base * heightScale, 0.3, 2.6);
        this.leapX = this.leapZ = 0;
      }
    }
};

  // One frame of the walk/run cycle: swing the hips fore/aft (opposite phase per
  // leg) with a stride that grows with speed, and bend the knee on the forward
  // swing. Below a walking pace the legs ease back to straight. Held still while
  // seated (sit() owns the pose).
Player.prototype.updateLegs = function(dt: number): void {
    if (this.seated) return;
    if (HUD_OPTS.model !== "human") { this.updateAcornFeet(dt); return; }
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    if (frac < 0.04) {
      this.stridePhase = 0;
      const ease = Math.min(1, dt * 12);
      this.hipL.rotation.x += -this.hipL.rotation.x * ease;
      this.hipR.rotation.x += -this.hipR.rotation.x * ease;
      this.kneeL.rotation.x += -this.kneeL.rotation.x * ease;
      this.kneeR.rotation.x += -this.kneeR.rotation.x * ease;
      return;
    }
    this.stridePhase += this.curSpd * dt * 3.4;   // distance-based → speed sets cadence
    const amp = 0.32 + frac * 0.5;                // longer strides at a sprint
    // front is local -numberSide·Z (same as the arms/toes), so the swing and the
    // knee bend are keyed to numberSide — both teams then walk forward and bend
    // the knee BACKWARD, whichever end they attack.
    const ns = this.numberSide;
    const sL = Math.sin(this.stridePhase), sR = Math.sin(this.stridePhase + Math.PI);
    this.hipL.rotation.x = sL * amp * ns;          // + phase swings the foot to the front
    this.hipR.rotation.x = sR * amp * ns;
    const bend = 0.5 + frac * 0.6;
    this.kneeL.rotation.x = -Math.max(0, sL) * bend * ns;   // shin trails back on the forward swing
    this.kneeR.rotation.x = -Math.max(0, sR) * bend * ns;
};

  // Penguin patter for the acorn shoes: while moving, the feet alternate quick
  // toe-up flaps (pivoting at the sole, so the heel stays planted — a pata-pata
  // waddle whose cadence and lift grow with speed); while airborne both toes
  // point down as if dangling; at rest they ease back flat. The shared
  // stridePhase means a mode switch mid-run stays in step.
Player.prototype.updateAcornFeet = function(dt: number): void {
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    let tL = 0, tR = 0, tw = 0;
    if (this.airborne) {
      tL = tR = -0.55;                              // toes point down off the floor
    } else if (frac >= 0.04) {
      // cadence ~3 steps/s at a sprint — any quicker and the easing below blurs
      // the two feet into flapping together instead of alternating
      this.stridePhase += this.curSpd * dt * 3.0;
      const amp = 0.35 + frac * 0.4;
      tL = Math.max(0, Math.sin(this.stridePhase)) * amp;
      tR = Math.max(0, Math.sin(this.stridePhase + Math.PI)) * amp;
      // the body rocks onto the planted foot — away from the lifted toe — which
      // is the penguin waddle itself; the sway widens a touch with pace.
      // クイックネス(敏捷性) steadies it: a nimble player barely waddles at all
      // (99 ≈ level shoulders), a heavy-footed one rocks the full amount.
      // Purely cosmetic — no speed or balance effect.
      const wobble = 1 - rate(this.attr.agility);
      tw = -Math.sin(this.stridePhase) * (0.07 + frac * 0.06) * wobble;
    } else {
      this.stridePhase = 0;
    }
    const ease = Math.min(1, dt * 22);
    this.acornFootL.rotation.x += (tL - this.acornFootL.rotation.x) * ease;
    this.acornFootR.rotation.x += (tR - this.acornFootR.rotation.x) * ease;
    this.acornWaddle += (tw - this.acornWaddle) * ease;
    // Flap around the HEEL, not the node origin: a toe-up pitch alone swings the
    // heel's back corner (local z = heelBotZ 0.18) down through the floor, so
    // the node rises by exactly that sunk depth — the toe slaps while the heel
    // stays planted. Toe-down (airborne) needs no lift: the root is in the air.
    this.acornFootL.position.y = Math.max(0, Math.sin(this.acornFootL.rotation.x)) * 0.18;
    this.acornFootR.position.y = Math.max(0, Math.sin(this.acornFootR.rotation.x)) * 0.18;
    this.syncAcornLegs();
};

  // Keep each bare-skin leg cylinder glued between the waist and its shoe: the leg
  // stays vertical (never inherits the foot's toe-flap tilt) and just rides the
  // foot's lift/stance in y and z, so the top stays tucked up into the waist and
  // the bottom stays down in the shoe as the feet patter.
Player.prototype.syncAcornLegs = function(): void {
    this.acornLegL.position.y = this.acornFootL.position.y;
    this.acornLegL.position.z = this.acornFootL.position.z;
    this.acornLegR.position.y = this.acornFootR.position.y;
    this.acornLegR.position.z = this.acornFootR.position.z;
};

  // thighs fold toward the front (the court, since bench players face the ball),
  // shins drop to the floor — keyed to numberSide so both benches fold FORWARD
  // (over the seat) rather than one folding back through the bench.
Player.prototype.foldSeatedLegs = function(): void {
    const ns = this.numberSide;
    this.hipL.rotation.x = this.hipR.rotation.x = Player.SIT_HIP * ns;
    this.kneeL.rotation.x = this.kneeR.rotation.x = Player.SIT_KNEE * ns;
};

  // Bench seat / stand-up. Seated drops the whole rig so the hips meet the seat
  // and folds the legs (thighs forward, shins down); standing returns them to
  // the walk cycle.
Player.prototype.sit = function(): void {
    this.seated = true;
    this.handsRest();
    this.resetTwist();   // sit square on the bench
    this.foulReactT = 0;
    this.defWinT = 0;
    this.flinchPitch = 0;
    this.foldSeatedLegs();   // hidden in acorn mode, but keeps the pose consistent
    if (HUD_OPTS.model === "acorn") this.foldAcornSeat();
};

Player.prototype.stand = function(): void {
    if (!this.seated) return;
    this.seated = false;
    this.root.rotation.x = 0;
    this.hipL.rotation.x = this.hipR.rotation.x = 0;   // legs straighten
    this.kneeL.rotation.x = this.kneeR.rotation.x = 0;
    this.unfoldAcornSeat();  // waist back down, shoes back to the standing stance
};

Player.prototype.foldAcornSeat = function(): void {
    const ns = this.numberSide;
    const fold = Player.SIT_FOLD;                 // gentler than a hard 90°
    this.acornWaistPivot.rotation.x = fold * ns;
    const s = this.height / 1.95;
    // flatter feet planted on the floor read more like sitting than a steep
    // toe-down. `lift` self-compensates the floor contact for the seat drop and
    // the toe pitch; z is horizontal, so the foot stays grounded either way.
    const TILT = 0.30;                     // toe-down pitch (local heel-up is -x for both sides)
    const toeDrop = 0.28 * Math.sin(TILT); // the pitched toe (z -0.28) dips this far below the node
    const RAISE = 0.24;                    // lift the feet off the floor (dangling look)
    const lift = Player.acornSeatDrop() - Player.SEAT_SURF / s + toeDrop + RAISE;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = -TILT;
    this.acornFootL.position.y = this.acornFootR.position.y = lift;
    // the feet sprout from UNDER the waist bottom (its forward reach shrinks with
    // a gentler fold), dropping straight to the floor
    const footZ = -ns * Player.ACORN_WAIST_LEN * Math.sin(fold) * 0.7;
    this.acornFootL.position.z = this.acornFootR.position.z = footZ;
    this.syncAcornLegs();
};

  // Back to the standing arrangement (also safe to call in human mode).
Player.prototype.unfoldAcornSeat = function(): void {
    this.acornWaistPivot.rotation.x = 0;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = 0;
    this.acornFootL.position.y = this.acornFootR.position.y = 0;
    this.acornFootL.position.z = this.acornFootR.position.z =
      -this.numberSide * Player.ACORN_FOOT_Z;
    this.syncAcornLegs();
};

