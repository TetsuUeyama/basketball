import {
  Scene, Vector3, Quaternion, MeshBuilder, StandardMaterial, Color3, Mesh, TransformNode,
  DynamicTexture,
} from "@babylonjs/core";
import { TEAM_COLORS } from "./config";
import { Attributes, AbilityKey, PlayerDef, rate, roleOffense, computeOffPriority } from "./attributes";
import { clamp, rand } from "./util";

// A player's box-score line for the current game. `min` is time on court in
// game-clock seconds (shown as minutes in the result screen).
export interface Stats { pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; fgm: number; fga: number; min: number; }

// Quaternion rotating the default down-pointing arm (0,-1,0) onto a unit vector.
function aimDownTo(vx: number, vy: number, vz: number): Quaternion {
  const dot = -vy;                                   // dot((0,-1,0),(vx,vy,vz))
  if (dot > 0.9999) return Quaternion.Identity();
  if (dot < -0.9999) return Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI);
  const axis = new Vector3(-vz, 0, vx);              // cross((0,-1,0),(vx,vy,vz))
  axis.normalize();
  return Quaternion.RotationAxis(axis, Math.acos(clamp(dot, -1, 1)));
}

// ---------------------------------------------------------------------------
// Player — a kinematic actor. Its logical position lives in `pos` (XZ, feet on
// the floor); the mesh is synced from it every frame. No physics body.
// ---------------------------------------------------------------------------
export class Player {
  readonly team: number;
  readonly idx: number;          // roster index within the team (0..12); jersey = idx+1
  slot = 0;                      // court slot 0..4 while on the floor (man-matching key)
  stintT = 0;                    // game-seconds since this player last checked in
  name: string;
  attr: Attributes;              // live reference to the def's ratings
  height: number;                // metres
  runSpeed: number;              // m/s, derived from the `speed` rating
  role: string;                  // PG / SG / SF / PF / C
  offPriority: number;           // 0..1 scoring-option weight (go-to scorer = high)
  playmaking: number;            // 0..1 ball-bringing / playmaking role (PG = high)

  // box-score stats accumulated over the current game
  readonly stats: Stats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, min: 0 };
  readonly pos = new Vector3();  // logical position (feet)
  readonly root: TransformNode;

  // short arms whose hands reach out to hold/dribble/pass/shoot the ball
  private readonly armPivotL: TransformNode;
  private readonly armPivotR: TransformNode;

  // floating name tag, redrawn when the name changes
  private nameTex!: DynamicTexture;
  private readonly teamRGB: { r: number; g: number; b: number };

  // jersey-number decals, one per Z side; the visible one is the player's back
  private numDecalPlus!: Mesh;
  private numDecalMinus!: Mesh;
  private numberSide = 1;   // which local Z side currently shows the number

  decisionT = 0;                 // cooldown before the next AI decision
  driveTarget = new Vector3();   // where a ball-handler is heading

  // off-ball motion state
  cutting = false;               // currently making a cut to the basket
  offTimer = 0;                  // cooldown before the next off-ball decision
  spotIdx: number;               // formation spot this player currently owns
  readonly offTarget = new Vector3(); // current off-ball movement target

  // 1-on-1 battle state
  driveSide = 1;   // offence: which way the handler is attacking (-1 left, +1 right)
  shadeSide = 1;   // defence: which way the on-ball defender is shading
  reactT = 0;      // defence: reaction lag remaining before the shade catches up
  beatenT = 0;     // offence: time remaining of a successful (speed) blow-by burst
  powerT = 0;      // offence: time remaining of a bull/power drive shoving the man back
  stalledT = 0;    // offence: time the handler is walled off (contained), pulling it back out
  jukeT = 0;       // offence: a dribble move (step-in / side-step / step-back) mid-execution
  readonly jukeTarget = new Vector3(); // the footwork target while jukeT ticks down
  comboN = 0;      // offence: shakes already thrown in the current rocking combo
  lastFakeDir = 0; // offence: side the last fake sold, so the combo alternates
  lean = 0;        // defence: lateral weight / centre of gravity (-1..1, 0 = square)
  // world-space lateral axis the lean refers to (unit XZ): the actual lean
  // direction is (leanAxisX, leanAxisZ) * lean. Set wherever lean is modified.
  leanAxisX = 0;
  leanAxisZ = 0;

  // recovery cooldown after a pass or shot — the player is rooted (can't
  // initiate movement) until this elapses, modelling the release follow-through
  coolT = 0;
  // landing recovery — after coming down from a jump the centre of gravity has
  // to settle before he can explode into the next jump or sprint (not fully
  // rooted: he can still shuffle, just can't leap again or take off at speed)
  landT = 0;

  // 特殊能力 — set of AbilityKey flags from the roster def
  abilities: Set<AbilityKey>;
  // ダイレクトプレイ: window (seconds) after catching a pass for one-touch play
  quickT = 0;

  // --- conditioning (スタミナ/加速) ---
  // Actual speed achieved last frame (m/s), measured from displacement; the
  // acceleration model builds on it so a standing start ramps up to top speed.
  curSpd = 0;
  fatigue = 0;     // 0 (fresh) .. 1 (gassed) — drains speed and accuracy
  prevX = 0;       // position at the start of the frame, to measure curSpd
  prevZ = 0;
  velX = 0;        // measured velocity (m/s) — used to lead a moving receiver
  velZ = 0;
  private gaugeDrawn = 0;  // fatigue value last painted on the name-tag gauge

  // brief lock-out after touching a loose ball, so one tip doesn't re-trigger
  // a dozen contacts on the same frame-span
  touchCool = 0;

  // ball-screen (pick) state — setting/holding a screen to free the handler
  screening = false;
  screenT = 0;      // time left to establish & hold the pick before popping out
  screenSide = 1;   // which side the screen frees the handler toward (-1/+1)

  // vertical jump animation (shots, dunks, layups, contests, rebounds)
  private jumpRemaining = 0;
  private jumpDur = 0;
  private jumpHeight = 0;

  constructor(scene: Scene, team: number, idx: number, def: PlayerDef) {
    this.team = team;
    this.idx = idx;
    this.slot = Math.min(idx, 4);   // starters own their slot; bench get one on check-in
    this.spotIdx = this.slot;
    this.name = def.name;
    this.attr = def.attr;
    this.height = def.height;
    this.runSpeed = 3.8 + rate(def.attr.speed) * 4.2; // ~3.8 (slow) .. 8.0 (fast)

    // offensive identity: role baseline nudged by ratings (or an explicit priority)
    this.role = def.role;
    this.abilities = new Set(def.abilities ?? []);
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;

    const c = TEAM_COLORS[team];
    this.teamRGB = c;
    const color = new Color3(c.r, c.g, c.b);

    this.root = new TransformNode(`p_${team}_${idx}`, scene);

    const body = MeshBuilder.CreateCapsule(`body_${team}_${idx}`, {
      height: 1.55, radius: 0.3, capSubdivisions: 6, tessellation: 12,
    }, scene);
    body.position.y = 0.9;
    const bodyMat = new StandardMaterial(`bmat_${team}_${idx}`, scene);
    bodyMat.diffuseColor = color;
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    body.material = bodyMat;
    body.parent = this.root;

    const head = MeshBuilder.CreateSphere(`head_${team}_${idx}`, { diameter: 0.34, segments: 10 }, scene);
    head.position.y = 1.78;
    const headMat = new StandardMaterial(`hmat_${team}_${idx}`, scene);
    headMat.diffuseColor = new Color3(0.86, 0.7, 0.56);
    headMat.specularColor = new Color3(0.05, 0.05, 0.05);
    head.material = headMat;
    head.parent = this.root;

    // Jersey number, printed on the BACK of the jersey. A decal projects the
    // digits onto the capsule so they follow the body's curve instead of
    // floating on a flat plane. Bodies never yaw, so "the back" is simply the
    // side away from the basket being attacked — one decal is baked for each
    // Z side and setNumberSide() shows the correct one (flipped at half-time).
    const numTex = new DynamicTexture(`numtex_${team}_${idx}`, { width: 128, height: 128 }, scene, false);
    numTex.hasAlpha = true;
    const ctx = numTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = "white";
    ctx.font = "bold 84px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(idx + 1), 64, 68);
    numTex.update();
    const numMat = new StandardMaterial(`nummat_${team}_${idx}`, scene);
    numMat.diffuseTexture = numTex;
    numMat.opacityTexture = numTex;
    numMat.emissiveColor = new Color3(1, 1, 1);
    numMat.disableLighting = true;
    numMat.backFaceCulling = false;
    // The number is carried by a thin curved shell (a ribbon) hugging the
    // torso just outside the capsule surface, so the digits follow the body's
    // curve like a print on the jersey. Vertices are computed here explicitly —
    // no dependency on projection/UV internals. The arc sweep direction is
    // chosen per side so the digits read left-to-right for a viewer standing
    // on that side (default left-handed camera: +X is screen-right when
    // looking along +Z, and -X when looking along -Z).
    const makeNumberShell = (sign: number): Mesh => {
      const R = 0.315;                    // just proud of the 0.3 body radius
      const yTop = 1.42, yBot = 0.88;     // upper back
      const SEG = 12;
      const span = Math.PI * 0.55;        // ~100° of wrap around the torso
      const top: Vector3[] = [];
      const bot: Vector3[] = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG - 0.5) * span * (sign > 0 ? -1 : 1);
        const x = Math.sin(a) * R;
        const z = Math.cos(a) * R * sign;
        top.push(new Vector3(x, yTop, z));
        bot.push(new Vector3(x, yBot, z));
      }
      // [bot, top] puts texture-v the right way up (confirmed on-screen)
      const shell = MeshBuilder.CreateRibbon(`numshell_${sign}_${team}_${idx}`, {
        pathArray: [bot, top], sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      shell.material = numMat;
      shell.parent = this.root;
      shell.isVisible = false;            // Game picks the back side each half
      return shell;
    };
    this.numDecalPlus = makeNumberShell(1);
    this.numDecalMinus = makeNumberShell(-1);

    // Floating name tag that always faces the camera, so personalities are legible.
    const namePlane = MeshBuilder.CreatePlane(`name_${team}_${idx}`, { width: 1.7, height: 0.42 }, scene);
    namePlane.position.y = 2.35;
    namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    const nameTex = new DynamicTexture(`nametex_${team}_${idx}`, { width: 256, height: 64 }, scene, false);
    nameTex.hasAlpha = true;
    this.nameTex = nameTex;
    this.drawNameTag();              // paints the current name
    const nameMat = new StandardMaterial(`namemat_${team}_${idx}`, scene);
    nameMat.diffuseTexture = nameTex;
    nameMat.opacityTexture = nameTex;
    nameMat.emissiveColor = new Color3(1, 1, 1);
    nameMat.disableLighting = true;
    nameMat.backFaceCulling = false;
    namePlane.material = nameMat;
    namePlane.parent = this.root;

    // --- short arms + hands, used to hold / dribble / pass / shoot the ball ---
    const ARM_LEN = 0.5;
    const makeArm = (sx: number, tag: string): TransformNode => {
      const pivot = new TransformNode(`arm_${tag}_${team}_${idx}`, scene);
      pivot.parent = this.root;
      pivot.position.set(sx, 1.45, 0.06);          // shoulder
      const fore = MeshBuilder.CreateCylinder(`fore_${tag}_${team}_${idx}`,
        { height: ARM_LEN, diameter: 0.12, tessellation: 8 }, scene);
      fore.parent = pivot;
      fore.position.set(0, -ARM_LEN / 2, 0);       // hangs straight down from the shoulder
      fore.material = bodyMat;                      // sleeve in the jersey colour
      const hand = MeshBuilder.CreateSphere(`hand_${tag}_${team}_${idx}`,
        { diameter: 0.16, segments: 8 }, scene);
      hand.parent = pivot;
      hand.position.set(0, -ARM_LEN, 0);           // palm at the end of the arm
      hand.material = headMat;                      // skin tone
      return pivot;
    };
    this.armPivotL = makeArm(-0.34, "L");
    this.armPivotR = makeArm(0.34, "R");
    this.handsRest();

    // scale the whole figure vertically to the player's height (base build ≈ 1.95 m)
    this.root.scaling.y = def.height / 1.95;

    this.meshes = [body, head];
  }

  readonly meshes: Mesh[];

  /** 敏捷性: how quickly the body resets for the next action after a pass,
   *  shot or landing — quick players recover in roughly half the time. */
  recoveryMult(): number {
    return 1.3 - rate(this.attr.agility) * 0.65;   // ~0.66 (quick) .. ~1.24 (slow)
  }

  /** Begin a vertical jump of `height` metres lasting `dur` seconds. */
  jump(height: number, dur: number): void {
    // still gathering balance from the last landing — can't leap yet
    if (this.landT > 0) return;
    // don't restart a bigger jump with a smaller one mid-air
    if (this.jumpRemaining > 0 && height <= this.jumpHeight) return;
    this.jumpHeight = height;
    this.jumpDur = dur;
    this.jumpRemaining = dur;
  }

  updateJump(dt: number): void {
    if (this.jumpRemaining > 0) {
      this.jumpRemaining = Math.max(0, this.jumpRemaining - dt);
      if (this.jumpRemaining === 0) {
        // landing: the centre of gravity has to settle before the next jump or
        // sprint — bigger jumps take longer, and quick (敏捷性) players reset
        // fastest. Blocks a re-jump and drags the first step (see accelSpeed).
        this.landT = (0.22 + this.jumpHeight * 0.4) * this.recoveryMult();
      }
    }
  }

  /** True if this player has the given 特殊能力. */
  has(key: AbilityKey): boolean {
    return this.abilities.has(key);
  }

  /** Show the jersey number on the given Z side (+1 / -1) — the player's back,
   *  i.e. the side away from the basket he attacks. Flips at half-time.
   *  The shoulders carry a slight forward bias, so they follow the CHEST side
   *  (the opposite one) — otherwise the team attacking -Z reads front-to-back
   *  reversed, with its arms hung on the back. */
  setNumberSide(sign: number): void {
    this.numberSide = sign >= 0 ? 1 : -1;
    this.numDecalPlus.isVisible = sign > 0;
    this.numDecalMinus.isVisible = sign < 0;
    this.armPivotL.position.z = -this.numberSide * 0.06;
    this.armPivotR.position.z = -this.numberSide * 0.06;
  }

  /** Yaw the whole figure so the chest (the side opposite the number) points at
   *  a world point — bench players following the ball with their eyes. On-court
   *  bodies never yaw (all game maths assumes it), so this is bench-only. */
  faceToward(x: number, z: number, yawOffset = 0): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.01) return;
    const s = this.numberSide;
    // RotationY(θ) maps local +Z to (sinθ, 0, cosθ); the chest is local -s·Z
    this.root.rotation.y = Math.atan2(-s * fx, -s * fz) + yawOffset;
  }

  // --- bench idle: watching the game with a personality of one's own ---
  private benchGazeOff = 0;                       // personal gaze offset (rad)
  private benchGazeT = 0;                         // time to the next re-aim
  private benchActT = 1 + Math.random() * 5;      // time to the next fidget
  private benchArmT = 0;                          // current arm gesture time left

  /**
   * One frame of sitting on the bench watching the ball: gaze follows it with a
   * personal offset that drifts every couple of seconds, and every few seconds
   * a small random fidget fires — a little hop, a hand half-raised, arms spread.
   * Handles its own jump ticking and mesh sync (bench players get no on-court
   * per-frame updates).
   */
  benchIdle(dt: number, ballX: number, ballZ: number): void {
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
  }

  /** Turn an on-court body toward a world point, easing at up to `maxStep`
   *  radians this frame so a player tracks the play (the ball, or the basket he
   *  attacks) without snapping around. Uses the same chest-facing convention as
   *  faceToward; the arm rig (aimArm) now accounts for the resulting yaw. */
  faceSmooth(x: number, z: number, maxStep: number): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;   // target on top of us — hold facing
    const s = this.numberSide;
    const target = Math.atan2(-s * fx, -s * fz);
    let d = target - this.root.rotation.y;
    while (d > Math.PI) d -= 2 * Math.PI;             // shortest angular path
    while (d < -Math.PI) d += 2 * Math.PI;
    this.root.rotation.y += clamp(d, -maxStep, maxStep);
  }

  /** Clear any yaw (start of game / bench gaze); the body squares up again on the
   *  next facing update. */
  resetFacing(): void {
    this.root.rotation.y = 0;
    this.root.rotation.x = this.root.rotation.z = 0;   // stand up straight, too
    this.tiltX = this.tiltZ = 0;
    this.lean = 0;
  }

  /** Tick down the post-pass/shot recovery cooldown. */
  tickCooldown(dt: number): void {
    if (this.coolT > 0) this.coolT = Math.max(0, this.coolT - dt);
    if (this.landT > 0) this.landT = Math.max(0, this.landT - dt);
    if (this.quickT > 0) this.quickT = Math.max(0, this.quickT - dt);
  }

  /**
   * Speed available this frame (m/s): accelerates from the measured current
   * speed toward top speed. 加速力 sets the ramp, 速度 the ceiling, and fatigue
   * lowers the ceiling. Pure — call with the frame's dt wherever the player moves.
   */
  accelSpeed(dt: number, mult = 1): number {
    // recovering balance (post pass/shot) or still settling from a landing
    // barely lets the feet move — the first step off a landing is sluggish
    const rec = (this.coolT > 0 || this.landT > 0) ? 0.35 : 1;
    const target = this.runSpeed * mult * (1 - this.fatigue * 0.2) * rec;
    const acc = 3 + rate(this.attr.accel) * 13;        // m/s² — sluggish .. explosive
    return Math.min(target, this.curSpd + acc * dt);
  }

  /** Fraction of top speed kept when redirecting existing momentum toward
   *  (tx,tz). 敏捷性 lets a quick player cut/reverse without losing speed; a slow
   *  one has to decelerate to change direction. ~1 moving straight or from rest. */
  turnFactor(tx: number, tz: number): number {
    if (this.curSpd < 1.2) return 1;                   // little momentum to fight
    const vl = Math.hypot(this.velX, this.velZ);
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const dl = Math.hypot(dx, dz);
    if (vl < 0.15 || dl < 0.1) return 1;
    const dot = (dx * this.velX + dz * this.velZ) / (dl * vl); // -1 (reversal) .. 1 (straight)
    const turn = (1 - dot) / 2;                         // 0 .. 1
    const keep = 0.45 + rate(this.attr.agility) * 0.55; // 0.45 (slow) .. 1.0 (quick)
    return clamp(1 - turn * (1 - keep), 0.35, 1);
  }

  /** Fraction of speed kept moving toward (tx,tz) while the body is leaning:
   *  moving WITH the lean (or square) is smooth, but cutting back AGAINST a
   *  committed lean means first hauling the centre of gravity back over the
   *  feet — that first step is slow. This is what a dribbler exploits by
   *  rocking a defender side to side and bursting past the side he can't
   *  recover to (the lean itself decays with 敏捷性 elsewhere). */
  leanFactor(tx: number, tz: number): number {
    const m = Math.abs(this.lean);
    if (m < 0.12) return 1;                            // basically square
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const dl = Math.hypot(dx, dz);
    if (dl < 0.05) return 1;
    // signed world-space lean direction
    const lx = this.leanAxisX * this.lean, lz = this.leanAxisZ * this.lean;
    const ll = Math.hypot(lx, lz);
    if (ll < 1e-4) return 1;
    const align = (dx * lx + dz * lz) / (dl * ll);     // -1 against .. +1 with
    return clamp(1 - m * Math.max(0, -align) * 0.55, 0.4, 1);
  }

  /** accelSpeed scaled by the cost of changing direction toward (tx,tz) and of
   *  fighting a committed body lean. */
  accelToward(dt: number, tx: number, tz: number, mult = 1): number {
    return this.accelSpeed(dt, mult) * this.turnFactor(tx, tz) * this.leanFactor(tx, tz);
  }

  /** How fast (units/s) this player hauls his centre of gravity back over his
   *  feet. クイックネス(敏捷性) rules it — and because the WE2010-derived scale
   *  is compressed (most AGI sits in ~65..85), the slope is deliberately steep
   *  so a real quartile gap shows: ~0.7/s for a heavy-footed 65 (a full lean
   *  takes ~1.4 s to reset) vs ~2.0/s for a quick 85 (~0.5 s). */
  leanRecoverRate(): number {
    // pivot ~70: measured re-attack cadence is ~1.2 s, so below the pivot a
    // full lean SURVIVES into the next shake (it stacks), above it the weight
    // is square again before the dribbler can go
    return clamp(0.35 + (rate(this.attr.agility) - 0.70) * 9.0, 0.3, 2.6);
  }

  /** Ease the committed lateral weight back to square when nobody is actively
   *  duelling this player. (The on-ball duel has its own recovery in
   *  defendOnBall, toward the shade.) */
  decayLean(dt: number): void {
    if (this.lean === 0) return;
    const r = this.leanRecoverRate() * dt;
    this.lean += clamp(-this.lean, -r, r);
  }

  /**
   * Measure the speed actually achieved this frame and update fatigue.
   * スタミナ slows the drain; dead balls (free throws, pauses) recover.
   * Call once per frame after all movement/collisions have resolved.
   */
  tickMotion(dt: number, resting: boolean): void {
    if (dt > 0) {
      const moved = Math.hypot(this.pos.x - this.prevX, this.pos.z - this.prevZ);
      this.curSpd = Math.min(moved / dt, 12);
      this.velX = (this.pos.x - this.prevX) / dt;
      this.velZ = (this.pos.z - this.prevZ) / dt;
    }
    if (resting) {
      // a dead ball is only a breather — it barely restores anything
      this.fatigue = Math.max(0, this.fatigue - 0.003 * dt);
    } else {
      const effort = this.runSpeed > 0 ? clamp(this.curSpd / this.runSpeed, 0, 1.2) : 0;
      const drain = (0.003 + effort * 0.02) * (1.3 - rate(this.attr.stamina));
      const rest = effort < 0.1 ? 0.002 : 0;           // catching a breath while standing
      this.fatigue = clamp(this.fatigue + (drain - rest) * dt, 0, 1);
    }
    // keep the name-tag stamina gauge current (repaint only on visible change)
    if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02) this.drawNameTag();
  }

  /** Sitting on the bench: a slow, steady recovery (not an instant refill) —
   *  a high stamina rating also means recovering faster between stints. */
  benchRecover(dt: number): void {
    const rec = 0.002 + rate(this.attr.stamina) * 0.004;   // ~0.0024 .. ~0.006 per sec
    this.fatigue = Math.max(0, this.fatigue - rec * dt);
    if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02) this.drawNameTag();
  }

  /** A one-off recovery chunk at a period break (quarter rest / halftime). */
  breakRecover(amount: number): void {
    this.fatigue = Math.max(0, this.fatigue - amount);
    if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02) this.drawNameTag();
  }

  /** True while following through on a pass/shot — must not initiate movement. */
  get rooted(): boolean {
    return this.coolT > 0;
  }

  /** True while the player is off the floor (mid-jump). */
  get airborne(): boolean {
    return this.jumpRemaining > 0;
  }

  /** Highest point the hands can currently reach (standing reach + jump). */
  reachTopY(): number {
    return this.jumpY() + this.height * 1.35;
  }

  private jumpY(): number {
    if (this.jumpDur <= 0 || this.jumpRemaining <= 0) return 0;
    const k = 1 - this.jumpRemaining / this.jumpDur; // 0..1 over the jump
    return Math.sin(k * Math.PI) * this.jumpHeight;  // up then back down
  }

  private tiltX = 0;  // smoothed visual body tilt (rad), applied in sync()
  private tiltZ = 0;

  sync(): void {
    this.root.position.set(this.pos.x, this.jumpY(), this.pos.z);
    // VISIBLE body lean: tip the whole figure toward the committed centre of
    // gravity. World lean vector → the yaw-local frame using the codebase's
    // verified convention (RotationY(θ) maps local +Z to (sinθ,0,cosθ) — see
    // faceToward), then pitch/roll the root. Smoothed so shakes read as weight
    // shifts, not snaps.
    const m = this.lean * 0.30;                     // up to ~17° at a full lean
    let tx = 0, tz = 0;
    if (Math.abs(m) > 0.02) {
      const wx = this.leanAxisX * m, wz = this.leanAxisZ * m;
      const th = this.root.rotation.y;
      const c = Math.cos(th), s = Math.sin(th);
      const lx = wx * c - wz * s;                   // lean, in the yaw-local frame
      const lz = wx * s + wz * c;
      tx = lz;                                      // pitch: tip toward local +Z
      tz = -lx;                                     // roll:  tip toward local +X
    }
    this.tiltX += (tx - this.tiltX) * 0.25;
    this.tiltZ += (tz - this.tiltZ) * 0.25;
    this.root.rotation.x = this.tiltX;
    this.root.rotation.z = this.tiltZ;
  }

  /** Re-read name / height / role / priority / derived values from a (possibly
   *  edited) roster def. `attr` is a live reference, so rating edits already apply. */
  applyDef(def: PlayerDef): void {
    this.role = def.role;
    this.attr = def.attr;   // re-bind: pre-game swaps can replace the def object
    this.abilities = new Set(def.abilities ?? []);
    this.runSpeed = 3.8 + rate(def.attr.speed) * 4.2; // keep in sync with the constructor
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;
    if (def.name !== this.name) { this.name = def.name; this.drawNameTag(); }
    if (def.height !== this.height) {
      this.height = def.height;
      this.root.scaling.y = def.height / 1.95;   // rescale the figure to the new height
    }
  }

  // Paint the floating name tag plus the stamina gauge underneath. The jersey
  // number lives on the player's back (a decal), not beside the name.
  // The gauge shows what's left in the tank (1 - fatigue): green when fresh,
  // amber when winded, red when gassed.
  private drawNameTag(): void {
    const ctx = this.nameTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 64);
    // no backing box — a drop shadow keeps the text readable over the court
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 6;
    ctx.fillStyle = "#fff";   // white reads best over the court (team = jersey colour)
    // long database names (e.g. クリスティアーノ・ロナウド) shrink to fit the tag
    const size = this.name.length > 11 ? 18 : this.name.length > 7 ? 24 : 30;
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(this.name, 128, 24);

    // stamina gauge (track + fill)
    const left = 14, top = 46, width = 228, height = 10;
    const frac = clamp(1 - this.fatigue, 0, 1);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = frac > 0.5 ? "rgb(80,220,110)"
      : frac > 0.25 ? "rgb(240,200,70)" : "rgb(235,80,60)";
    ctx.fillRect(left, top, width * frac, height);
    ctx.shadowBlur = 0;

    this.nameTex.update();
    this.gaugeDrawn = this.fatigue;
  }

  /** Zero this player's box score and conditioning (start of a game). */
  resetStats(): void {
    const s = this.stats;
    s.pts = s.reb = s.ast = s.stl = s.blk = s.tov = s.fgm = s.fga = s.min = 0;
    this.fatigue = 0;
    this.curSpd = 0;
    this.stintT = 0;
  }

  /** Both arms hang at the sides (default pose). */
  handsRest(): void {
    this.armPivotL.rotationQuaternion = Quaternion.Identity();
    this.armPivotR.rotationQuaternion = Quaternion.Identity();
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
  }

  /** Reach the right hand (or both) out so the palm meets `world` — the ball. */
  reach(world: Vector3, both = false): void {
    this.aimArm(this.armPivotR, world);
    if (both) this.aimArm(this.armPivotL, world);
    else this.armPivotL.rotationQuaternion = Quaternion.Identity();
  }

  /** Spread both arms out wide — active hands to wall off the ball-handler. */
  armsWide(): void {
    this.setArmDir(this.armPivotL, -1, -0.35, 0.35);
    this.setArmDir(this.armPivotR, 1, -0.35, 0.35);
  }

  // Point an arm from its shoulder toward a world point — direction only, so the
  // arm keeps its fixed length. The root may now carry a yaw (players turn to face
  // the play), so the shoulder's world position rotates with the body, and the
  // desired reach — computed in world space — is converted back into the root's
  // local frame before it becomes the arm's (local) aim. R_y(θ): local +Z →
  // (sinθ,0,cosθ), local +X → (cosθ,0,-sinθ). At θ=0 this is the old direct maths.
  private aimArm(pivot: TransformNode, world: Vector3): void {
    const th = this.root.rotation.y;
    const c = Math.cos(th), s = Math.sin(th);
    const px = pivot.position.x, py = pivot.position.y * this.root.scaling.y, pz = pivot.position.z;
    // shoulder world = root + R_y(θ)·(local shoulder offset)
    const sx = this.root.position.x + (c * px + s * pz);
    const sy = this.root.position.y + py;
    const sz = this.root.position.z + (-s * px + c * pz);
    // reach direction in world → rotate into the root's local frame (R_y(-θ))
    const wx = world.x - sx, wy = world.y - sy, wz = world.z - sz;
    this.setArmDir(pivot, c * wx - s * wz, wy, s * wx + c * wz);
  }

  private setArmDir(pivot: TransformNode, dx: number, dy: number, dz: number): void {
    const len = Math.hypot(dx, dy, dz) || 1;
    pivot.rotationQuaternion = aimDownTo(dx / len, dy / len, dz / len);
  }
}

// ---------------------------------------------------------------------------
// Ball — a sphere whose position is fully driven by the simulation.
// ---------------------------------------------------------------------------
export class Ball {
  readonly mesh: Mesh;
  readonly pos = new Vector3(0, 1, 0);
  readonly vel = new Vector3();   // used while the ball is loose (free-flight)

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateSphere("ball", { diameter: 0.24, segments: 12 }, scene);
    const mat = new StandardMaterial("ballmat", scene);
    mat.diffuseColor = new Color3(0.85, 0.4, 0.12);
    mat.specularColor = new Color3(0.25, 0.2, 0.15);
    this.mesh.material = mat;
  }

  sync(): void {
    this.mesh.position.copyFrom(this.pos);
  }
}
