import {
  Scene, Vector3, Quaternion, MeshBuilder, StandardMaterial, Color3, Mesh, TransformNode,
  DynamicTexture,
} from "@babylonjs/core";
import { TEAM_COLORS } from "./config";
import { Attributes, PlayerDef, rate, roleOffense, computeOffPriority } from "./attributes";
import { clamp } from "./util";

// A player's box-score line for the current game.
export interface Stats { pts: number; reb: number; ast: number; stl: number; blk: number; tov: number; fgm: number; fga: number; }

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
  readonly idx: number;          // 0..4 within the team
  readonly name: string;
  readonly attr: Attributes;
  readonly height: number;       // metres
  runSpeed: number;              // m/s, derived from the `speed` rating
  role: string;                  // PG / SG / SF / PF / C
  offPriority: number;           // 0..1 scoring-option weight (go-to scorer = high)
  playmaking: number;            // 0..1 ball-bringing / playmaking role (PG = high)

  // box-score stats accumulated over the current game
  readonly stats: Stats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0 };
  readonly pos = new Vector3();  // logical position (feet)
  readonly root: TransformNode;

  // short arms whose hands reach out to hold/dribble/pass/shoot the ball
  private readonly armPivotL: TransformNode;
  private readonly armPivotR: TransformNode;

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
  beatenT = 0;     // offence: time remaining of a successful blow-by burst
  lean = 0;        // defence: lateral weight / centre of gravity (-1..1, 0 = square)

  // recovery cooldown after a pass or shot — the player is rooted (can't
  // initiate movement) until this elapses, modelling the release follow-through
  coolT = 0;

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
    this.spotIdx = idx;
    this.name = def.name;
    this.attr = def.attr;
    this.height = def.height;
    this.runSpeed = 5.4 + rate(def.attr.speed) * 1.9; // ~5.4 (slow) .. 7.3 (fast)

    // offensive identity: role baseline nudged by ratings (or an explicit priority)
    this.role = def.role;
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;

    const c = TEAM_COLORS[team];
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

    // Jersey number on a small billboard so teams/roles are readable.
    const numPlane = MeshBuilder.CreatePlane(`num_${team}_${idx}`, { size: 0.7 }, scene);
    numPlane.position.y = 1.05;
    numPlane.position.z = 0.31;
    const numTex = new DynamicTexture(`numtex_${team}_${idx}`, { width: 64, height: 64 }, scene, false);
    numTex.hasAlpha = true;
    const ctx = numTex.getContext() as unknown as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = "white";
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(idx + 1), 32, 34);
    numTex.update();
    const numMat = new StandardMaterial(`nummat_${team}_${idx}`, scene);
    numMat.diffuseTexture = numTex;
    numMat.opacityTexture = numTex;
    numMat.emissiveColor = new Color3(1, 1, 1);
    numMat.disableLighting = true;
    numMat.backFaceCulling = false;
    numPlane.material = numMat;
    numPlane.parent = this.root;

    // Floating name tag that always faces the camera, so personalities are legible.
    const namePlane = MeshBuilder.CreatePlane(`name_${team}_${idx}`, { width: 1.7, height: 0.42 }, scene);
    namePlane.position.y = 2.35;
    namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    const nameTex = new DynamicTexture(`nametex_${team}_${idx}`, { width: 256, height: 64 }, scene, false);
    nameTex.hasAlpha = true;
    const nctx = nameTex.getContext() as unknown as CanvasRenderingContext2D;
    nctx.clearRect(0, 0, 256, 64);
    nctx.fillStyle = "rgba(0,0,0,0.55)";
    nctx.fillRect(0, 0, 256, 64);
    nctx.fillStyle = `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`;
    nctx.font = "bold 34px sans-serif";
    nctx.textAlign = "center";
    nctx.textBaseline = "middle";
    nctx.fillText(`${idx + 1} ${def.name}`, 128, 34);
    nameTex.update();
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

  /** Begin a vertical jump of `height` metres lasting `dur` seconds. */
  jump(height: number, dur: number): void {
    // don't restart a bigger jump with a smaller one mid-air
    if (this.jumpRemaining > 0 && height <= this.jumpHeight) return;
    this.jumpHeight = height;
    this.jumpDur = dur;
    this.jumpRemaining = dur;
  }

  updateJump(dt: number): void {
    if (this.jumpRemaining > 0) this.jumpRemaining = Math.max(0, this.jumpRemaining - dt);
  }

  /** Tick down the post-pass/shot recovery cooldown. */
  tickCooldown(dt: number): void {
    if (this.coolT > 0) this.coolT = Math.max(0, this.coolT - dt);
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

  sync(): void {
    this.root.position.set(this.pos.x, this.jumpY(), this.pos.z);
  }

  /** Re-read role / priority / derived values from a (possibly edited) roster
   *  def. `attr` is a live reference to the def, so rating edits already apply. */
  applyDef(def: PlayerDef): void {
    this.role = def.role;
    this.runSpeed = 5.4 + rate(def.attr.speed) * 1.9;
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;
  }

  /** Zero this player's box score (called at the start of a game). */
  resetStats(): void {
    const s = this.stats;
    s.pts = s.reb = s.ast = s.stl = s.blk = s.tov = s.fgm = s.fga = 0;
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
  // arm keeps its fixed length. The root carries no yaw, so shoulder world = root
  // position + the pivot's local offset (Y also scaled by the figure's height).
  private aimArm(pivot: TransformNode, world: Vector3): void {
    const sx = this.root.position.x + pivot.position.x;
    const sy = this.root.position.y + pivot.position.y * this.root.scaling.y;
    const sz = this.root.position.z + pivot.position.z;
    this.setArmDir(pivot, world.x - sx, world.y - sy, world.z - sz);
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
