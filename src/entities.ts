import {
  Scene, Vector3, Quaternion, MeshBuilder, StandardMaterial, Color3, Mesh, TransformNode,
  DynamicTexture, VertexData,
} from "@babylonjs/core";
import { TEAM_COLORS, HUD_OPTS } from "./config";
import { Attributes, AbilityKey, PlayerDef, rate, roleOffense, computeOffPriority, ROLE_BEHAVIOR,
  DEF_ROLE_BEHAVIOR, OffAction, offActionOf } from "./attributes";
import { clamp, rand, chance, playerLook } from "./util";

// A player's box-score line for the current game. `min` is time on court in
// game-clock seconds (shown as minutes in the result screen).
export interface Stats {
  pts: number; reb: number; ast: number; stl: number; blk: number; tov: number;
  fgm: number; fga: number;   // field goals made / attempted (all shots incl. threes)
  tpm: number; tpa: number;   // three-pointers made / attempted
  ftm: number; fta: number;   // free throws made / attempted
  min: number;
}

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
  evalRole: string | undefined;  // オフェンスロール — 攻撃時の挙動修飾 (applyDef)
  defRole: string | undefined;   // ディフェンスロール — 守備時の挙動修飾 (applyDef)
  offAction: OffAction = "balanced"; // オフェンスロール由来の行動プロファイル
  lockDef = false;               // 守備をサボらない（defRole由来の常時全力）
  defEffortGear: number | undefined; // defRole由来の守備エフォート上限(0..1)。未設定=自動
  choiceRank: number | undefined; // 手動の選択順位 1..5 (def由来。未設定=自動)
  autoRank = 3;                  // refreshChoiceRanks が入れる自動順位 1..5
  hand: "R" | "L" = "R";         // 利き手 — preferred attacking side & finish hand
  offhandAcc = 5;                // 逆手精度 2..8 (WE2010 scale) — weak-hand finish quality
  offhandFreq = 5;               // 逆手頻度 2..8 — how willingly he goes weak-side
  offPriority: number;           // 0..1 scoring-option weight (go-to scorer = high)
  playmaking: number;            // 0..1 ball-bringing / playmaking role (PG = high)

  // box-score stats accumulated over the current game
  readonly stats: Stats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, min: 0 };
  readonly pos = new Vector3();  // logical position (feet)
  readonly root: TransformNode;

  // short arms whose hands reach out to hold/dribble/pass/shoot the ball
  private readonly armPivotL: TransformNode;
  private readonly armPivotR: TransformNode;
  private elbowL!: TransformNode;   // upper-arm ↔ forearm joint (bent at rest, straight to reach)
  private elbowR!: TransformNode;

  // floating name tag, redrawn when the name changes
  private nameTex!: DynamicTexture;
  private namePlane!: Mesh;   // floating name tag; hidden when HUD_OPTS.showNames is off
  private readonly teamRGB: { r: number; g: number; b: number };

  // jersey-number decals, one per Z side and per body style; the visible one is
  // the player's back on the currently shown body
  private numHumanPlus!: Mesh;
  private numHumanMinus!: Mesh;
  private numAcornPlus!: Mesh;
  private numAcornMinus!: Mesh;
  private numberSide = 1;   // which local Z side currently shows the number
  private sideApplied = false; // Game hasn't picked a back side yet — keep shells hidden

  // Upper body carrier: chest, head, arms and the jersey number ride this and
  // TWIST toward the play (twistToward), while the root — and with it the legs
  // and feet — faces the direction of travel. Lets a player keep running one
  // way with his chest turned to receive, pass, or shadow a driver.
  private torsoNode!: TransformNode;
  private torsoTwist = 0;   // smoothed twist (rad), clamped to ±TWIST_MAX

  // Both body styles exist from construction; applyModel() shows one and hides
  // the other so the style can be flipped live from the HUD menu.
  private humanNode!: TransformNode;   // rectangular torso (ribbons + caps)
  private acornNode!: TransformNode;   // the acorn figure (chest + waist + shoe feet)
  private acornWaistPivot!: TransformNode; // waist rides this, at the waist-chest cut —
                                       // sitting folds it 90° forward (the lap)
  private acornFootL!: TransformNode;  // shoe-shaped feet — asymmetric, so both the
  private acornFootR!: TransformNode;  // position AND the yaw flip with numberSide
  private eyeL!: Mesh;                  // face eyes — sit on the front (-numberSide·Z)
  private eyeR!: Mesh;
  private hair: Mesh | null = null;    // hair crown — tilted back so front/nape differ
  private hairTilt = 0;                // backward tilt magnitude (flipped by numberSide)

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
  // ピック&ロール: this screener rolled into space the defence gave up (a hedge/
  // switch left his man behind) — a live pocket-pass window worth feeding
  openRollT = 0;
  // お膳立て: caught in rhythm off a good pass — a catch-and-shoot window during
  // which his next shot gets `setupBonus` (a great passer CREATES a makeable
  // look for a limited scorer; a fast pass keeps the window open longer).
  setupT = 0;
  setupBonus = 0;

  // dribble carry: where the live dribble sits relative to the handler (world
  // XZ offset). The game eases it between a fast front carry and a protected
  // side carry at a speed set by D精度; baitT is a deliberate "shown ball"
  // window inviting a reach-in the handler is ready to beat.
  carryX = 0;
  carryZ = 0;
  baitT = 0;
  // dribble cadence phase (per-handler): advances faster for a high-D精度
  // handler, so a poor one pounds it slowly and the ball spends longer away from
  // his hand (exposed to a poke, and he can only start his next action when it's
  // back in his hand).
  dribblePhase = 0;

  // foul reaction — a brief, purely visual beat played during the dead-ball
  // pause: "hurt" sells the contact (arms fly out, body rocks back), "and1"
  // is the flex (fists up + a hop) before heading to the line
  foulReactT = 0;
  private foulReactDur = 0;
  private foulReactKind: "hurt" | "and1" = "hurt";
  private flinchPitch = 0;   // extra root pitch while flinching, added in sync()
  private flinchRoll = 0;    // extra root roll while flinching (directional foul tilt)
  // direction the contact knocked him (world unit XZ; 0,0 = no info → back-rock),
  // its strength (0..1), and whether it knocked him off balance into a stumble
  private foulPushX = 0;
  private foulPushZ = 0;
  private foulStrength = 0;
  private foulStumble = false;
  private foulStaggerX = 0;
  private foulStaggerZ = 0;

  // --- conditioning (スタミナ/加速) ---
  // Actual speed achieved last frame (m/s), measured from displacement; the
  // acceleration model builds on it so a standing start ramps up to top speed.
  curSpd = 0;
  fatigue = 0;     // 0 (fresh) .. 1 (gassed) — drains speed and accuracy
  prevX = 0;       // position at the start of the frame, to measure curSpd
  prevZ = 0;
  velX = 0;        // measured velocity (m/s) — used to lead a moving receiver
  velZ = 0;
  private gaugeDrawn = 0;   // fatigue value last painted on the name-tag gauge
  private gaugeRev = -1;    // HUD_OPTS.rev the tag was last painted for (forces a repaint on toggle)

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

  // articulated legs: a hip pivot (thigh) + knee pivot (shin + foot) per side.
  // They swing in a walk/run cycle while playing and fold into a sitting pose on
  // the bench. Driven by updateLegs(); posed by sit()/stand().
  seated = false;
  private hipL!: TransformNode;
  private hipR!: TransformNode;
  private kneeL!: TransformNode;
  private kneeR!: TransformNode;
  private footL!: Mesh;
  private footR!: Mesh;
  private stridePhase = 0;   // accumulates with distance travelled → leg swing
  private acornWaddle = 0;   // eased penguin body-roll (rad), added to root roll in sync()

  constructor(scene: Scene, team: number, idx: number, def: PlayerDef) {
    this.team = team;
    this.idx = idx;
    this.slot = Math.min(idx, 4);   // starters own their slot; bench get one on check-in
    this.spotIdx = this.slot;
    this.name = def.name;
    this.attr = def.attr;
    this.height = def.height;
    this.runSpeed = 3.2 + rate(def.attr.speed) * 4.8; // ~3.2 (slow) .. 8.0 (fast)

    // offensive identity: role baseline nudged by ratings (or an explicit priority)
    this.role = def.role;
    this.abilities = new Set(def.abilities ?? []);
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;
    this.evalRole = def.evalRole;
    this.offAction = offActionOf(def.evalRole);
    this.defRole = def.defRole;
    this.choiceRank = def.choiceRank;

    const c = TEAM_COLORS[team];
    this.teamRGB = c;
    const color = new Color3(c.r, c.g, c.b);

    this.root = new TransformNode(`p_${team}_${idx}`, scene);

    // the twisting upper body — everything above the hips parents here
    const torsoNode = new TransformNode(`torsoTwist_${team}_${idx}`, scene);
    torsoNode.parent = this.root;
    this.torsoNode = torsoNode;

    // carrier for every humanoid-only torso piece, so the whole rect torso can
    // be enabled/disabled as one when the body style flips
    const humanNode = new TransformNode(`human_${team}_${idx}`, scene);
    humanNode.parent = torsoNode;
    this.humanNode = humanNode;

    // torso split into upper body (chest) + lower body (abdomen/pelvis) with a
    // slight waist taper — the legs are separate. Slim to match the thin legs.
    const bodyMat = new StandardMaterial(`bmat_${team}_${idx}`, scene);
    bodyMat.diffuseColor = color;
    bodyMat.specularColor = new Color3(0.1, 0.1, 0.1);
    bodyMat.backFaceCulling = false;   // torso caps/ribbon show regardless of winding
    // Torso = two rounded-RECTANGLE prisms (rectangular cross-section with a
    // small corner fillet R, extruded vertically). Core Babylon has no rounded
    // box, so the rounded-rect ring is built by hand and the sides are a closed
    // ribbon between a bottom and a top ring. The upper body is a touch bigger
    // than the waist.
    const rrRing = (a: number, b: number, r: number, y: number): Vector3[] => {
      const pts: Vector3[] = [];
      const corner = (cx: number, cz: number, a0: number) => {
        for (let i = 0; i <= 4; i++) {
          const t = a0 + (Math.PI / 2) * (i / 4);
          pts.push(new Vector3(cx + Math.cos(t) * r, y, cz + Math.sin(t) * r));
        }
      };
      corner(a - r, -(b - r), -Math.PI / 2);   // bottom-right → right edge
      corner(a - r, b - r, 0);                 // top-right → top edge
      corner(-(a - r), b - r, Math.PI / 2);    // top-left → left edge
      corner(-(a - r), -(b - r), Math.PI);     // bottom-left → bottom edge
      return pts;
    };
    // a flat cap (triangle fan from the centre to the ring) closes an end
    const makeCap = (name: string, ring: Vector3[], y: number): void => {
      const positions: number[] = [0, y, 0];
      for (const p of ring) positions.push(p.x, p.y, p.z);
      const indices: number[] = [];
      const n = ring.length;
      for (let i = 0; i < n; i++) indices.push(0, i + 1, ((i + 1) % n) + 1);
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      const vd = new VertexData();
      vd.positions = positions; vd.indices = indices; vd.normals = normals;
      const cap = new Mesh(name, scene);
      vd.applyToMesh(cap);
      cap.material = bodyMat;
      cap.parent = humanNode;
    };
    const roundedBox = (name: string, a: number, b: number, r: number, y0: number, y1: number): Mesh => {
      const bot = rrRing(a, b, r, y0), top = rrRing(a, b, r, y1);
      const m = MeshBuilder.CreateRibbon(name, {
        pathArray: [bot, top], closePath: true, sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      m.material = bodyMat;
      m.parent = humanNode;
      makeCap(`${name}_top`, top, y1);   // close the top and bottom so the torso isn't hollow
      makeCap(`${name}_bot`, bot, y0);
      return m;
    };
    // waist / pelvis, and a slightly larger chest / shoulders
    const lowerBody = roundedBox(`lower_${team}_${idx}`, 0.21, 0.15, 0.06, 0.79, 1.21);
    // top kept below the head (head bottom ≈ 1.61) so the head isn't buried
    const upperBody = roundedBox(`upper_${team}_${idx}`, 0.25, 0.18, 0.07, 1.15, 1.58);
    // the flat back the jersey number sits on (depth of the upper body)
    const backZ = 0.18;

    // the "acorn" figure — kept as an alternative style, toggled from the HUD
    // menu. Three parts, all flat at the joins (no rounding at a cut face —
    // like an acorn sawn through): a LONG chest keeping the old capsule's full
    // r0.3 silhouette (flat bottom at the waist cut, hemisphere shoulders), a
    // slimmer WAIST below it (flat top, hemisphere bottom hanging just above
    // the floor), and penguin FEET — only the toe tips peeking out in front.
    // Core Babylon has no one-flat-end capsule, so each piece is a lathe of
    // its profile.
    const acornNode = new TransformNode(`acorn_${team}_${idx}`, scene);
    acornNode.parent = torsoNode;   // chest + waist twist; the feet stay on the root
    this.acornNode = acornNode;
    const AR = 0.3, ACUT = Player.ACORN_CUT, ARC = 8; // chest radius / waist-chest cut height
    const WR = Player.ACORN_WAIST_R, WTIP = 0.22; // waist radius / waist bottom tip height
    // the waist rides a pivot at the cut plane so sitting can fold it 90°
    // forward (the lap) — its profile is built RELATIVE to the cut (y=0 at ACUT)
    const waistPivot = new TransformNode(`acornWaist_${team}_${idx}`, scene);
    waistPivot.parent = acornNode;
    waistPivot.position.y = ACUT;
    this.acornWaistPivot = waistPivot;
    // the waist widens at the very top to meet the chest FLUSH (WTOP ≈ the chest
    // radius AR), so the wider chest no longer overhangs the narrower waist —
    // that overhanging lip at the join was the big "R" at the upper-body side.
    // A small fillet (RF) softens the top outer edge just a touch.
    const WTOP = AR, RF = 0.03;
    const lowerShape: Vector3[] = [];
    for (let i = 0; i <= ARC; i++) {   // waist bottom hemisphere: axis tip out to full radius
      const t = (i / ARC) * Math.PI / 2;
      lowerShape.push(new Vector3(Math.sin(t) * WR, WTIP + WR - Math.cos(t) * WR - ACUT, 0));
    }
    for (let i = 0; i <= 4; i++) {     // flare up to the chest width + a small rounded top edge
      const a = (i / 4) * Math.PI / 2;
      lowerShape.push(new Vector3(WTOP - RF + Math.cos(a) * RF, -RF + Math.sin(a) * RF, 0));
    }
    lowerShape.push(new Vector3(0, 0, 0));       // flat cut face back to the axis
    const upperShape: Vector3[] = [
      new Vector3(0, ACUT, 0),                   // flat cut face out from the axis
      new Vector3(AR, ACUT, 0),                  // straight side up to the shoulder
    ];
    for (let i = 0; i <= ARC; i++) {   // top hemisphere: full radius in to the axis tip (1.675)
      const t = (i / ARC) * Math.PI / 2;
      upperShape.push(new Vector3(Math.cos(t) * AR, 1.375 + Math.sin(t) * AR, 0));
    }
    const makeAcornPiece = (name: string, shape: Vector3[]): Mesh => {
      const m = MeshBuilder.CreateLathe(name, {
        shape, tessellation: 12, sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      m.material = bodyMat;
      m.parent = acornNode;
      return m;
    };
    const acornLower = makeAcornPiece(`acornLower_${team}_${idx}`, lowerShape);
    acornLower.parent = waistPivot;              // folds with the sitting pivot
    const acornUpper = makeAcornPiece(`acornUpper_${team}_${idx}`, upperShape);

    const head = MeshBuilder.CreateSphere(`head_${team}_${idx}`, { diameter: 0.34, segments: 10 }, scene);
    head.position.y = 1.78;
    // skin / hair tone MATCH the HUD face icon (shared playerLook, seeded by idx)
    const look = playerLook(idx);
    const headMat = new StandardMaterial(`hmat_${team}_${idx}`, scene);
    headMat.diffuseColor = new Color3(look.skin.r, look.skin.g, look.skin.b);
    headMat.specularColor = new Color3(0.05, 0.05, 0.05);
    head.material = headMat;
    head.parent = torsoNode;   // the head turns with the chest

    // hair — a crown mesh whose SHAPE varies by hairstyle (so players read apart,
    // not just by colour). 0=短髪 1=坊主(髪なし) 2=アフロ 3=フラットトップ 4=ヘッドバンド。
    const hairMat = new StandardMaterial(`hair_${team}_${idx}`, scene);
    hairMat.diffuseColor = new Color3(look.hair.r, look.hair.g, look.hair.b);
    hairMat.specularColor = new Color3(0.04, 0.04, 0.04);
    // fuller coverage (comes down the sides/back so the crown isn't balding) and
    // a backward TILT so the front rides up at the hairline while the back covers
    // the nape — front and back hair then read differently. `tilt` is flipped by
    // numberSide (front = -numberSide·Z) in setNumberSide.
    // slice = how far the dome comes down (moderate, so it covers the sides/back
    // but NOT the face); tilt = backward lean so the FRONT rides up above the eyes
    // (forehead & expression visible) while the nape stays covered.
    const HS: ({ d: number; slice: number; sy: number; y: number; tilt: number } | null)[] = [
      { d: 0.375, slice: 0.58, sy: 1.0, y: 0.0, tilt: 0.34 },   // 0 短髪
      null,                                                     // 1 坊主
      { d: 0.47, slice: 0.66, sy: 1.08, y: 0.0, tilt: 0.24 },   // 2 アフロ
      { d: 0.375, slice: 0.56, sy: 1.4, y: 0.02, tilt: 0.30 },  // 3 フラットトップ
      { d: 0.375, slice: 0.56, sy: 0.95, y: 0.0, tilt: 0.32 },  // 4 ヘッドバンド下の髪
    ];
    const hs = HS[look.style];
    if (hs) {
      const hair = MeshBuilder.CreateSphere(`haircap_${team}_${idx}`, { diameter: hs.d, segments: 12, slice: hs.slice }, scene);
      hair.material = hairMat;
      hair.parent = head;            // rides the head
      hair.position.y = hs.y;
      hair.scaling.y = hs.sy;
      hair.rotation.x = this.numberSide * hs.tilt;   // lean back: front up, nape down
      this.hair = hair;
      this.hairTilt = hs.tilt;
    }
    if (look.style === 4) {
      // headband — a team-coloured ring around the head
      const band = MeshBuilder.CreateTorus(`band_${team}_${idx}`, { diameter: 0.355, thickness: 0.05, tessellation: 12 }, scene);
      const bandMat = new StandardMaterial(`bandmat_${team}_${idx}`, scene);
      const tc = TEAM_COLORS[team];
      bandMat.diffuseColor = new Color3(tc.r, tc.g, tc.b);
      bandMat.specularColor = new Color3(0.05, 0.05, 0.05);
      band.material = bandMat;
      band.parent = head;
      band.position.y = 0.035;       // forehead height
    }
    // eyes — two small dark spheres on the FRONT of the head. Front = local
    // -numberSide·Z (same convention the arms/feet use); setNumberSide re-aims Z
    // when the teams switch ends at half-time.
    const eyeMat = new StandardMaterial(`eye_${team}_${idx}`, scene);
    eyeMat.diffuseColor = new Color3(0.14, 0.1, 0.08);
    eyeMat.specularColor = new Color3(0, 0, 0);
    const mkEye = (sx: number): Mesh => {
      const e = MeshBuilder.CreateSphere(`eye_${team}_${idx}_${sx}`, { diameter: 0.05, segments: 6 }, scene);
      e.material = eyeMat;
      e.parent = head;
      e.position.set(sx, -0.005, -0.15);   // front hemisphere (numberSide default +1)
      return e;
    };
    this.eyeL = mkEye(-0.062);
    this.eyeR = mkEye(0.062);

    // acorn penguin feet, shaped like SHOES: a long low toe box + a rounded toe
    // cap + a taller ankle shaft tucking up under the waist bottom. Built with
    // the toe pointing local -Z (the chest side when numberSide = +1); the shoe
    // is front/back asymmetric, so setNumberSide flips its yaw as well as its
    // z position at half-time.
    const shoeMat = new StandardMaterial(`shoemat_${team}_${idx}`, scene);
    shoeMat.diffuseColor = new Color3(0.92, 0.92, 0.92);   // white sneakers
    shoeMat.specularColor = new Color3(0.08, 0.08, 0.08);
    shoeMat.backFaceCulling = false;   // hand-built wedge shows regardless of winding
    // Each shoe is ONE mesh so it reads as a single moulded piece (it used to
    // be four primitives and every join showed): the side-view outline —
    // sole → quarter-ellipse toe curve → straight instep diagonal → flat
    // collar top → heel back flaring slightly out toward the sole — is swept
    // across the full shoe width, and the two sides are closed with triangle
    // fans (the outline is convex).
    const makeAcornFoot = (sx: number, tag: string): TransformNode => {
      const node = new TransformNode(`acornFoot_${tag}_${team}_${idx}`, scene);
      node.parent = this.root;   // feet belong to the legs, not the twisting torso
      node.position.set(sx, 0, 0.07);            // z / yaw re-aimed per numberSide
      const hw = 0.15 / 2;                            // half width
      const capZ = -0.20, capR = 0.08, capH = 0.13;   // toe curve: start / bulge / height
      const topY = 0.25, slopeZ = -0.08;              // collar top / instep end
      const heelTopZ = 0.11, heelBotZ = 0.18;         // heel back: flares down-and-out to a longer heel
      const TSEG = 6;
      const prof: [number, number][] = [[heelBotZ, 0]]; // (z,y) closed outline, heel-bottom first
      for (let i = 0; i <= TSEG; i++) {   // toe: sole tip up and over the quarter ellipse
        const t = (1 - i / TSEG) * Math.PI / 2;
        prof.push([capZ - capR * Math.sin(t), capH * Math.cos(t)]);
      }
      prof.push([slopeZ, topY]);          // instep diagonal up to the collar
      prof.push([heelTopZ, topY]);        // flat collar top; loop closes down the flared heel
      const N = prof.length;
      const spos: number[] = [];
      for (const [z, y] of prof) spos.push(-hw, y, z, hw, y, z);  // pair 2i / 2i+1
      const sidx: number[] = [];
      for (let i = 0; i < N; i++) {       // swept outline surface (incl. sole & heel back)
        const j = (i + 1) % N;
        const a = 2 * i, b = a + 1, c = 2 * j, d = c + 1;
        sidx.push(a, c, b, b, c, d);
      }
      for (let i = 1; i < N - 1; i++) {   // flat side caps, fanned from the heel-bottom corner
        sidx.push(0, 2 * i, 2 * (i + 1));
        sidx.push(1, 2 * (i + 1) + 1, 2 * i + 1);
      }
      const snorm: number[] = [];
      VertexData.ComputeNormals(spos, sidx, snorm);
      const svd = new VertexData();
      svd.positions = spos; svd.indices = sidx; svd.normals = snorm;
      const shoe = new Mesh(`acornShoe_${tag}_${team}_${idx}`, scene);
      svd.applyToMesh(shoe);
      shoe.material = shoeMat;
      shoe.parent = node;
      return node;
    };
    this.acornFootL = makeAcornFoot(-0.12, "L");
    this.acornFootR = makeAcornFoot(0.12, "R");

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
    const makeNumberShell = (sign: number, tag: string, R: number,
      yTop: number, yBot: number, span: number): Mesh => {
      const SEG = 12;
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
      const shell = MeshBuilder.CreateRibbon(`numshell_${tag}_${sign}_${team}_${idx}`, {
        pathArray: [bot, top], sideOrientation: Mesh.DOUBLESIDE,
      }, scene);
      shell.material = numMat;
      shell.parent = torsoNode;   // the number is printed on the (twisting) jersey
      shell.isVisible = false;            // Game picks the back side each half
      return shell;
    };
    // human: just proud of the flat rect back (~60° gentle wrap, upper back)
    this.numHumanPlus = makeNumberShell(1, "h", backZ + 0.012, 1.52, 1.08, Math.PI * 0.34);
    this.numHumanMinus = makeNumberShell(-1, "h", backZ + 0.012, 1.52, 1.08, Math.PI * 0.34);
    // acorn: just proud of the 0.3 capsule radius (~100° wrap, as it always was)
    this.numAcornPlus = makeNumberShell(1, "a", 0.315, 1.42, 0.88, Math.PI * 0.55);
    this.numAcornMinus = makeNumberShell(-1, "a", 0.315, 1.42, 0.88, Math.PI * 0.55);

    // Floating name tag that always faces the camera, so personalities are legible.
    const namePlane = MeshBuilder.CreatePlane(`name_${team}_${idx}`, { width: 1.7, height: 0.42 }, scene);
    this.namePlane = namePlane;
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

    // --- arms: upper arm (jersey sleeve) → elbow → forearm (skin) → hand. The
    // shoulder pivot aims the whole arm at the ball (reach); the elbow bends at
    // rest / while running and straightens to put the palm on the ball. Total
    // length = UP + FORE, matching the old ARM_LEN so reach maths is unchanged. ---
    const UP = 0.25, FORE = 0.25;
    const makeArm = (sx: number, tag: string): { pivot: TransformNode; elbow: TransformNode } => {
      const pivot = new TransformNode(`arm_${tag}_${team}_${idx}`, scene);
      pivot.parent = torsoNode;   // shoulders ride the twisting chest
      pivot.position.set(sx, 1.45, 0.06);          // shoulder
      const upper = MeshBuilder.CreateCylinder(`upper_${tag}_${team}_${idx}`,
        { height: UP, diameter: 0.12, tessellation: 8 }, scene);
      upper.parent = pivot;
      upper.position.set(0, -UP / 2, 0);           // upper arm, jersey sleeve
      upper.material = bodyMat;
      const elbow = new TransformNode(`elbow_${tag}_${team}_${idx}`, scene);
      elbow.parent = pivot;
      elbow.position.set(0, -UP, 0);               // elbow at the end of the upper arm
      const fore = MeshBuilder.CreateCylinder(`fore_${tag}_${team}_${idx}`,
        { height: FORE, diameter: 0.1, tessellation: 8 }, scene);
      fore.parent = elbow;
      fore.position.set(0, -FORE / 2, 0);          // forearm, bare skin
      fore.material = headMat;
      const hand = MeshBuilder.CreateSphere(`hand_${tag}_${team}_${idx}`,
        { diameter: 0.16, segments: 8 }, scene);
      hand.parent = elbow;
      hand.position.set(0, -FORE, 0);              // palm at the end of the forearm
      hand.material = headMat;
      return { pivot, elbow };
    };
    const armL = makeArm(-0.28, "L");   // shoulders drawn in toward the slimmer torso
    const armR = makeArm(0.28, "R");
    this.armPivotL = armL.pivot; this.elbowL = armL.elbow;
    this.armPivotR = armR.pivot; this.elbowR = armR.elbow;
    this.handsRest();

    // --- articulated legs: hip pivot (thigh, jersey shorts) + knee pivot (shin,
    // skin + a foot). At rest the leg hangs straight from the hip at y≈0.9 to the
    // floor. updateLegs() swings the hips (and bends the knees) for a walk cycle;
    // sit() folds them. ---
    const HIP_Y = 0.92, THIGH = 0.46, SHIN = 0.44;
    const makeLeg = (sx: number, tag: string): { hip: TransformNode; knee: TransformNode; foot: Mesh } => {
      const hip = new TransformNode(`hip_${tag}_${team}_${idx}`, scene);
      hip.parent = this.root;
      hip.position.set(sx, HIP_Y, 0);
      const thigh = MeshBuilder.CreateCylinder(`thigh_${tag}_${team}_${idx}`,
        { height: THIGH, diameter: 0.21, tessellation: 8 }, scene);
      thigh.parent = hip;
      thigh.position.set(0, -THIGH / 2, 0);      // hangs down from the hip
      thigh.material = bodyMat;                    // shorts in the jersey colour
      const knee = new TransformNode(`knee_${tag}_${team}_${idx}`, scene);
      knee.parent = hip;
      knee.position.set(0, -THIGH, 0);            // knee at the bottom of the thigh
      const shin = MeshBuilder.CreateCylinder(`shin_${tag}_${team}_${idx}`,
        { height: SHIN, diameter: 0.16, tessellation: 8 }, scene);
      shin.parent = knee;
      shin.position.set(0, -SHIN / 2, 0);         // hangs down from the knee (skin)
      shin.material = headMat;
      const foot = MeshBuilder.CreateBox(`foot_${tag}_${team}_${idx}`,
        { width: 0.16, height: 0.1, depth: 0.28 }, scene);
      foot.parent = knee;
      foot.position.set(0, -SHIN, 0.06);          // toe offset set per numberSide in setNumberSide
      foot.material = headMat;
      return { hip, knee, foot };
    };
    const legL = makeLeg(-0.13, "L");
    const legR = makeLeg(0.13, "R");
    this.hipL = legL.hip; this.kneeL = legL.knee; this.footL = legL.foot;
    this.hipR = legR.hip; this.kneeR = legR.knee; this.footR = legR.foot;

    // scale the whole figure vertically to the player's height (base build ≈ 1.95 m)
    this.root.scaling.y = def.height / 1.95;

    this.meshes = [upperBody, lowerBody, head, acornUpper, acornLower];
    this.refreshBodyDepth();   // thin the torso front-to-back per ボディバランス
    this.applyModel();   // show the currently selected body style
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
    this.sideApplied = true;
    this.numberSide = sign >= 0 ? 1 : -1;
    const human = HUD_OPTS.model === "human";
    this.numHumanPlus.isVisible = human && sign > 0;
    this.numHumanMinus.isVisible = human && sign < 0;
    this.numAcornPlus.isVisible = !human && sign > 0;
    this.numAcornMinus.isVisible = !human && sign < 0;
    this.armPivotL.position.z = -this.numberSide * 0.06;
    this.armPivotR.position.z = -this.numberSide * 0.06;
    // toes point the same way as the chest/arms (front = -numberSide·Z), so the
    // team attacking -Z doesn't read with its feet on backwards
    this.footL.position.z = -this.numberSide * 0.1;
    this.footR.position.z = -this.numberSide * 0.1;
    // eyes sit on the chest/front side too, so they don't end up on the back
    if (this.eyeL) { this.eyeL.position.z = -this.numberSide * 0.15; this.eyeR.position.z = -this.numberSide * 0.15; }
    // hair leans back relative to the face, so the tilt flips with the front side
    if (this.hair) this.hair.rotation.x = this.numberSide * this.hairTilt;
    // shoe feet: same rule, but the shoe is front/back asymmetric so its yaw
    // flips too (built toe-forward for numberSide +1). The stance sits toward
    // the back of the body with the toes fanned outward (a slight duck stance),
    // so each foot's yaw = facing base ± the outward splay.
    const fns = this.numberSide;
    this.acornFootL.position.z = -fns * Player.ACORN_FOOT_Z;
    this.acornFootR.position.z = -fns * Player.ACORN_FOOT_Z;
    const fBase = fns > 0 ? 0 : Math.PI;
    this.acornFootL.rotation.y = fBase + fns * Player.ACORN_SPLAY;
    this.acornFootR.rotation.y = fBase - fns * Player.ACORN_SPLAY;
    if (this.seated) {
      this.foldSeatedLegs();   // keep a sitting fold facing the right way
      if (HUD_OPTS.model === "acorn") this.foldAcornSeat();
    }
  }

  /** モデル切替（人型 ⇄ どんぐりカプセル）: 選択中のボディだけを表示し、腕の
   *  肩幅・背番号シェル・着席姿勢をそのモード用に組み直す。いつ呼んでも安全
   *  （腕/頭/名前タグは両モード共用）。 */
  applyModel(): void {
    const human = HUD_OPTS.model === "human";
    this.humanNode.setEnabled(human);
    this.hipL.setEnabled(human);          // legs (thigh/shin/foot ride these pivots)
    this.hipR.setEnabled(human);
    this.acornNode.setEnabled(!human);
    this.acornFootL.setEnabled(!human);   // shoe feet live on the root (they don't
    this.acornFootR.setEnabled(!human);   // twist), so they toggle separately
    // the capsule is wider than the rect torso — shoulders move out to match
    const sx = human ? 0.28 : 0.34;
    this.armPivotL.position.x = -sx;
    this.armPivotR.position.x = sx;
    if (this.sideApplied) this.setNumberSide(this.numberSide); // move the number onto this body
    // re-pose for this mode: a seated acorn folds its waist into a lap, a
    // seated human sits on folded legs (acorn fold cleared either way first)
    if (this.seated && !human) this.foldAcornSeat();
    else this.unfoldAcornSeat();
    this.refreshScale();
  }

  // How far the chest can twist away from the hips (either way). Real torsos
  // manage ~60-70° before the feet have to come around.
  private static readonly TWIST_MAX = 1.15;

  /** Twist the upper body so the chest aims at a world point while the root
   *  (legs, feet) keeps its own facing — receiving on the run, shading a driver
   *  while sprinting alongside. Clamped to TWIST_MAX and eased; aiming near the
   *  root's own facing (or standing square) unwinds it back to zero. */
  twistToward(x: number, z: number, dt: number, maxTwist = Player.TWIST_MAX, rate = 10): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      let d = Math.atan2(-s * fx, -s * fz) - this.root.rotation.y;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      want = clamp(d, -maxTwist, maxTwist);
    }
    const step = rate * dt;   // the chest turns quicker than the feet (faceSmooth's 8)
    this.torsoTwist += clamp(want - this.torsoTwist, -step, step);
    this.torsoNode.rotation.y = this.torsoTwist;
  }

  /** Orient the CHEST to face (x,z) NOW (no easing) — a two-handed pass is thrown
   *  chest-on to the target. The torso twists there; the feet only turn by the
   *  part the torso can't cover (|twist| capped at TWIST_MAX), so the feet may lag
   *  ("足はズレていても") while the upper body lands on the receiver. */
  faceChestToward(x: number, z: number): void {
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
  }

  /** Square the chest back over the hips instantly (bench seat, resets). */
  resetTwist(): void {
    this.torsoTwist = 0;
    this.torsoNode.rotation.y = 0;
    this.torsoNode.rotation.x = 0;   // clear any dejected forward hunch
    this.torsoNode.position.set(0, 0, 0);   // and the dejected waist-hinge offset
    if (!this.seated) this.acornWaistPivot.rotation.x = 0;   // waist back to vertical
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
    this.flinchPitch = 0;
    this.resetTwist();
  }

  /** うなだれ: hips and legs stay upright — only the UPPER BODY hunches forward
   *  (torso pitch) with the arms hanging dead. Trudging back to the bench keeps
   *  this posture (the legs still walk underneath). Hold it by calling every
   *  frame; resetTwist()/sit()/resetFacing() straighten the body back up. */
  dejectedPose(): void {
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
  }

  /** Tick down the post-pass/shot recovery cooldown. */
  tickCooldown(dt: number): void {
    if (this.coolT > 0) this.coolT = Math.max(0, this.coolT - dt);
    if (this.landT > 0) this.landT = Math.max(0, this.landT - dt);
    if (this.quickT > 0) this.quickT = Math.max(0, this.quickT - dt);
    if (this.baitT > 0) this.baitT = Math.max(0, this.baitT - dt);
    if (this.openRollT > 0) this.openRollT = Math.max(0, this.openRollT - dt);
    if (this.setupT > 0) this.setupT = Math.max(0, this.setupT - dt);
    if (this.foulReactT > 0) {
      this.foulReactT = Math.max(0, this.foulReactT - dt);
      // stumble: an off-balance stagger step in the push direction, spent over
      // the FIRST part of the reaction (he catches himself after)
      if (this.foulStumble && this.foulReactDur > 0) {
        const remain = this.foulReactT / this.foulReactDur;      // 1 → 0
        const w = clamp((remain - 0.3) / 0.7, 0, 1);             // spent over the first ~70% (a few steps)
        const r = w * 2.2 * dt;
        this.pos.x += this.foulStaggerX * r;
        this.pos.z += this.foulStaggerZ * r;
      }
    }
  }

  /** Kick off a foul reaction. `pushX/pushZ` is the world direction the contact
   *  knocked him (0,0 = unknown → a plain back-rock); `strength` (0..1) scales how
   *  hard he rocks, how long it lasts, and the chance it becomes a stumble. */
  foulReaction(kind: "hurt" | "and1", pushX = 0, pushZ = 0, strength = 0.5): void {
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
  }

  /** One frame of the foul-reaction pose. Call AFTER runArms (it owns the
   *  arms while it runs); ticking happens in tickCooldown. */
  poseFoulReaction(): void {
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
      this.elbowL.rotation.x = this.elbowR.rotation.x = 0;
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
    const acc = 2.5 + rate(this.attr.accel) * 15;      // m/s² — sluggish .. explosive first step
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
    const keep = 0.32 + rate(this.attr.agility) * 0.68; // 0.32 (slow) .. 1.0 (quick)
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

  /** +1 = the dominant-hand side, -1 = the weak side (driveSide space). */
  strongSide(): number { return this.hand === "L" ? -1 : 1; }

  /** How strongly he favours his dominant side when free to choose a side —
   *  逆手頻度 8 plays both ways (50/50), 2 is heavily one-handed (~70/30). */
  strongSideBias(): number { return 0.5 + (1 - this.offhandFreq / 8) * 0.27; }

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
    this.lastDt = dt;   // remembered so rate-limited arm slews know the frame length
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
    if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
  }

  /** Sitting on the bench: a slow, steady recovery (not an instant refill) —
   *  a high stamina rating also means recovering faster between stints. */
  benchRecover(dt: number): void {
    const rec = 0.002 + rate(this.attr.stamina) * 0.004;   // ~0.0024 .. ~0.006 per sec
    this.fatigue = Math.max(0, this.fatigue - rec * dt);
    if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
  }

  /** A one-off recovery chunk at a period break (quarter rest / halftime). */
  breakRecover(amount: number): void {
    this.fatigue = Math.max(0, this.fatigue - amount);
    if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
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

  // Leg geometry / pose constants.
  private static readonly HIP_Y = 0.92;      // hip pivot height (matches makeLeg)
  private static readonly SEAT_HIP = 0.46;   // hips rest at the bench-seat surface when sat
  private static readonly SIT_HIP = 1.45;    // thigh swings up to ~horizontal (forward)
  private static readonly SIT_KNEE = -1.55;  // shin folds back down to the floor
  // acorn sitting: the waist folds 90° forward at the waist-chest cut (it
  // reads as the lap) and the shoes tuck under it, standing on the floor
  private static readonly ACORN_CUT = 0.72;     // waist-chest cut height (the sit hinge)
  private static readonly ACORN_WAIST_R = 0.25; // waist radius (constructor's WR)
  private static readonly SEAT_SURF = 0.42;     // bench seat surface the folded waist rests on
  private static readonly SIT_FOLD = 1.15;      // waist fold when sat (~66°, gentler than a hard 90°)
  private static readonly ACORN_WAIST_LEN = 0.50; // pivot→waist tip length (from the lathe profile)
  private static readonly ACORN_FOOT_Z = 0.02;  // standing stance: feet sit toward the back
  private static readonly ACORN_SPLAY = 0.30;   // standing stance: toes fan outward (~17° each)

  /** Vertical scale for the player's height. */
  private refreshScale(): void {
    this.root.scaling.y = this.height / 1.95;
  }

  /** ボディバランス(フィジカル) sets the torso's front-to-back thickness (the Z
   *  depth): a poised, strong 99 keeps the full build; 65 and below thin down to
   *  two-thirds (the common minimum), linear in between. The chest, waist and
   *  their jersey-number shells all compress together so the number stays on the
   *  (now shallower) back. Head, arms and legs keep their depth. Purely visual. */
  private refreshBodyDepth(): void {
    const t = clamp((this.attr.balance - 65) / (99 - 65), 0, 1);
    const z = 2 / 3 + t * (1 / 3);   // 0.667 (≤65) .. 1.0 (99)
    this.acornNode.scaling.z = z;
    this.humanNode.scaling.z = z;
    this.numAcornPlus.scaling.z = z;
    this.numAcornMinus.scaling.z = z;
    this.numHumanPlus.scaling.z = z;
    this.numHumanMinus.scaling.z = z;
  }

  // Fold the acorn body into its sitting pose: waist swings up to horizontal
  // toward the chest side (front = -numberSide·Z, so rotation.x = +90°·ns maps
  // the downward waist onto -ns·Z), shoes move forward under the lap and back
  // down to the floor (the root is dropped by sync() while seated).
  // Lowest point of the folded waist below the root (what rests on the seat).
  // Derived from the fold angle so it stays correct as SIT_FOLD changes; reduces
  // to the old (ACORN_CUT - ACORN_WAIST_R)=0.47 at a 90° fold.
  private static acornSeatDrop(): number {
    const f = Player.SIT_FOLD;
    return Player.ACORN_CUT - Player.ACORN_WAIST_R * (Math.cos(f) + Math.sin(f));
  }
  private foldAcornSeat(): void {
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
  }
  // Back to the standing arrangement (also safe to call in human mode).
  private unfoldAcornSeat(): void {
    this.acornWaistPivot.rotation.x = 0;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = 0;
    this.acornFootL.position.y = this.acornFootR.position.y = 0;
    this.acornFootL.position.z = this.acornFootR.position.z =
      -this.numberSide * Player.ACORN_FOOT_Z;
  }

  // Bench seat / stand-up. Seated drops the whole rig so the hips meet the seat
  // and folds the legs (thighs forward, shins down); standing returns them to
  // the walk cycle.
  sit(): void {
    this.seated = true;
    this.handsRest();
    this.resetTwist();   // sit square on the bench
    this.foulReactT = 0;
    this.flinchPitch = 0;
    this.foldSeatedLegs();   // hidden in acorn mode, but keeps the pose consistent
    if (HUD_OPTS.model === "acorn") this.foldAcornSeat();
  }
  // thighs fold toward the front (the court, since bench players face the ball),
  // shins drop to the floor — keyed to numberSide so both benches fold FORWARD
  // (over the seat) rather than one folding back through the bench.
  private foldSeatedLegs(): void {
    const ns = this.numberSide;
    this.hipL.rotation.x = this.hipR.rotation.x = Player.SIT_HIP * ns;
    this.kneeL.rotation.x = this.kneeR.rotation.x = Player.SIT_KNEE * ns;
  }
  stand(): void {
    if (!this.seated) return;
    this.seated = false;
    this.root.rotation.x = 0;
    this.hipL.rotation.x = this.hipR.rotation.x = 0;   // legs straighten
    this.kneeL.rotation.x = this.kneeR.rotation.x = 0;
    this.unfoldAcornSeat();  // waist back down, shoes back to the standing stance
  }

  // One frame of the walk/run cycle: swing the hips fore/aft (opposite phase per
  // leg) with a stride that grows with speed, and bend the knee on the forward
  // swing. Below a walking pace the legs ease back to straight. Held still while
  // seated (sit() owns the pose).
  updateLegs(dt: number): void {
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
  }

  // Penguin patter for the acorn shoes: while moving, the feet alternate quick
  // toe-up flaps (pivoting at the sole, so the heel stays planted — a pata-pata
  // waddle whose cadence and lift grow with speed); while airborne both toes
  // point down as if dangling; at rest they ease back flat. The shared
  // stridePhase means a mode switch mid-run stays in step.
  private updateAcornFeet(dt: number): void {
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
  }

  sync(): void {
    if (this.seated) {
      // drop the rig so the (folded) hips meet the bench seat; the folded legs
      // reach the floor in front. rotation.y is set by benchIdle/faceToward —
      // keep it; stay upright (no lean tilt). The acorn body drops until the
      // UNDERSIDE of its folded waist (hinge minus the waist radius) rests on
      // the seat surface — the chest rides above the lap, and the shoes are
      // lifted back onto the floor by foldAcornSeat.
      const s = this.height / 1.95;
      const rootY = HUD_OPTS.model === "acorn"
        ? Player.SEAT_SURF - Player.acornSeatDrop() * s
        : Player.SEAT_HIP - Player.HIP_Y * s;
      this.root.position.set(this.pos.x, rootY + this.jumpY(), this.pos.z);
      this.root.rotation.x = 0;
      this.root.rotation.z = 0;
      this.tiltX = this.tiltZ = 0;
      return;
    }
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
    this.root.rotation.x = this.tiltX + this.flinchPitch;   // + the foul-flinch rock-back
    // the acorn body waddles side to side in step with the foot flaps (eased in
    // updateAcornFeet, zero when still/airborne or in human mode); the foul-flinch
    // roll tips him sideways off a hit that came from an angle
    this.root.rotation.z = this.tiltZ + this.flinchRoll + (HUD_OPTS.model === "acorn" ? this.acornWaddle : 0);
  }

  /** Re-read name / height / role / priority / derived values from a (possibly
   *  edited) roster def. `attr` is a live reference, so rating edits already apply. */
  applyDef(def: PlayerDef): void {
    this.role = def.role;
    this.attr = def.attr;   // re-bind: pre-game swaps can replace the def object
    this.abilities = new Set(def.abilities ?? []);
    this.runSpeed = 3.2 + rate(def.attr.speed) * 4.8; // keep in sync with the constructor
    this.offPriority = computeOffPriority(def);
    this.playmaking = roleOffense(def.role).playmaking;
    // 評価ロールを実挙動へ: 仮想特能の付与と優先度/プレイメイキング補正。
    // これで「エースにはボールが集まる」「ロックダウンは常時マンマーク」等が
    // 既存の特殊能力/優先度の配線に乗って動く。
    this.evalRole = def.evalRole;
    this.offAction = offActionOf(def.evalRole);
    this.choiceRank = def.choiceRank;
    this.hand = def.hand ?? "R";
    this.offhandAcc = def.future?.offhandAcc || 5;
    this.offhandFreq = def.future?.offhandFreq || 5;
    const rb = def.evalRole ? ROLE_BEHAVIOR[def.evalRole] : undefined;
    if (rb) {
      for (const k of rb.ab ?? []) this.abilities.add(k);
      this.offPriority = clamp(this.offPriority + (rb.pri ?? 0), 0, 1);
      this.playmaking = clamp(this.playmaking + (rb.pm ?? 0), 0, 1);
    }
    // ディフェンスロール（オフェンスロールとは独立）: 守備の仮想特能と常時全力。
    this.defRole = def.defRole;
    this.lockDef = false;
    this.defEffortGear = undefined;
    const db = def.defRole ? DEF_ROLE_BEHAVIOR[def.defRole] : undefined;
    if (db) {
      for (const k of db.ab ?? []) this.abilities.add(k);
      this.lockDef = !!db.lockEffort;
      this.defEffortGear = db.effort;
    }
    if (def.name !== this.name) { this.name = def.name; this.drawNameTag(); }
    if (def.height !== this.height) {
      this.height = def.height;
      this.refreshScale();   // rescale the figure to the new height (keeps a seated squash)
    }
    this.refreshBodyDepth();   // a swapped-in player's ボディバランス sets his torso depth
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

    // stamina gauge (track + fill) — only when the HUD is set to show it on the
    // name tag; in "icon" mode it lives under the bottom-HUD face icon instead
    if (HUD_OPTS.staminaOn === "name") {
      const left = 14, top = 46, width = 228, height = 10;
      const frac = clamp(1 - this.fatigue, 0, 1);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(left, top, width, height);
      ctx.fillStyle = frac > 0.5 ? "rgb(80,220,110)"
        : frac > 0.25 ? "rgb(240,200,70)" : "rgb(235,80,60)";
      ctx.fillRect(left, top, width * frac, height);
    }
    ctx.shadowBlur = 0;

    this.nameTex.update();
    this.namePlane.isVisible = HUD_OPTS.showNames;   // toggle the on-court name tag
    this.gaugeDrawn = this.fatigue;
    this.gaugeRev = HUD_OPTS.rev;
  }

  /** Zero this player's box score and conditioning (start of a game). */
  resetStats(): void {
    const s = this.stats;
    s.pts = s.reb = s.ast = s.stl = s.blk = s.tov = s.fgm = s.fga = s.min = 0;
    s.tpm = s.tpa = s.ftm = s.fta = 0;
    this.fatigue = 0;
    this.curSpd = 0;
    this.stintT = 0;
  }

  // elbow bend: forward (toward the chest, -numberSide·Z), matching the arm/leg
  // convention. Straight (0) whenever the hand must reach the ball.
  // The FOREARM (elbow) eases toward its bend at the same rate as the upper arm
  // when a slew is active — so the two segments move independently, the forearm
  // straightening/folding at its own controlled speed rather than snapping.
  private bendElbow(node: TransformNode, amount: number): void {
    const target = amount * this.numberSide;
    if (this.armRateCap > 0) {
      const k = 1 - Math.exp(-this.armRateCap * this.lastDt);
      node.rotation.x += (target - node.rotation.x) * k;
    } else {
      node.rotation.x = target;
    }
  }

  /** Both arms hang at the sides, elbows slightly bent (default pose). */
  handsRest(): void {
    this.armPivotL.rotationQuaternion = Quaternion.Identity();
    this.armPivotR.rotationQuaternion = Quaternion.Identity();
    this.armPivotL.scaling.set(1, 1, 1);
    this.armPivotR.scaling.set(1, 1, 1);
    this.bendElbow(this.elbowL, 0.28);
    this.bendElbow(this.elbowR, 0.28);
  }

  // Arms for a player who isn't handling the ball. Running forward they pump
  // fore/aft with the stride (opposite the same-side leg, elbows carried bent) —
  // the acorn body pumps too, just about half as far (stubby penguin arms).
  // BACKPEDALLING (moving against the chest direction — a retreating defender)
  // swaps to a balance pose: both arms out low and a touch forward, fluttering
  // in step with the feet. Rests at a walk/standstill. poseHands() calls this
  // for everyone, then overrides ball arms.
  private backArms = false;   // hysteresis so the style doesn't flicker at the threshold
  private lastDt = 1 / 60;    // last frame length, for rate-limited arm slews
  // While > 0, setArmDir turns the arm toward its target at this many rad/s instead
  // of snapping — a weak defender re-orients his hands slowly, so a switch lags.
  private armRateCap = 0;
  runArms(): void {
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
  }

  /** Reach the right hand (or both) out so the palm meets `world` — the ball.
   *  Elbows straighten so the palm actually reaches the aimed point. */
  reach(world: Vector3, both = false): void {
    this.aimArm(this.armPivotR, world);
    this.elbowR.rotation.x = 0;
    if (both) { this.aimArm(this.armPivotL, world); this.elbowL.rotation.x = 0; }
    else { this.armPivotL.rotationQuaternion = Quaternion.Identity(); this.bendElbow(this.elbowL, 0.28); }
  }

  /** Which side of the body a world point sits on — +x local = the body's RIGHT
   *  (armPivotR side). Uses the SAME yaw+twist frame as aimArm, so it can never
   *  disagree with where the arm actually points. */
  dribbleWithRight(world: Vector3): boolean {
    const th = this.root.rotation.y + this.torsoTwist;
    const wx = world.x - this.root.position.x, wz = world.z - this.root.position.z;
    const localX = Math.cos(th) * wx - Math.sin(th) * wz;
    return localX >= 0;
  }

  /** Dribble/hold the ball with the hand on the SAME side it sits — so a ball
   *  carried to the left hip is held with the LEFT hand instead of reaching the
   *  right arm across (through) the body, and vice-versa. */
  reachDribble(world: Vector3, useRight: boolean, rate = 0): void {
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
  }

  /** Spread both arms out wide — active hands to wall off a side-to-side drive.
   *  `rate` (rad/s) rate-limits the switch; 0 snaps (bench / non-defensive use). */
  armsWide(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -1, -0.35, 0.35);
    this.setArmDir(this.armPivotR, 1, -0.35, 0.35);
    this.bendElbow(this.elbowL, 0);   // forearms straighten out, eased
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
  }

  /** Cut off a straight drive: the hand nearer the ball goes out FRONT and low to
   *  wall off penetration and stab at the ball (the steal), the off hand rides low
   *  and out for balance in the slide. `rate` rate-limits the re-orient. */
  guardDrive(world: Vector3, useRight: boolean, rate = 0): void {
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
  }

  /** Deny the pass: one hand thrown out on a DIAGONAL — out to the ball side, up,
   *  and angled back toward the basket — to wall the lane so a pass can't slip
   *  BEHIND him. A swing laterally across his chest is conceded (that's fine). */
  denyLane(useRight: boolean, rate = 0): void {
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
  }

  /** Straight-up shot contest: both hands vertical, challenging without leaving
   *  the floor (an airborne contest reaches for the ball instead). */
  handsUp(rate = 0): void {
    this.armRateCap = rate;
    this.setArmDir(this.armPivotL, -0.14, 1, 0.06);
    this.setArmDir(this.armPivotR, 0.14, 1, 0.06);
    this.bendElbow(this.elbowL, 0);   // forearms straighten up, eased
    this.bendElbow(this.elbowR, 0);
    this.armRateCap = 0;
  }

  // Point an arm from its shoulder toward a world point — direction only, so the
  // arm keeps its fixed length. The root may now carry a yaw (players turn to face
  // the play), so the shoulder's world position rotates with the body, and the
  // desired reach — computed in world space — is converted back into the root's
  // local frame before it becomes the arm's (local) aim. R_y(θ): local +Z →
  // (sinθ,0,cosθ), local +X → (cosθ,0,-sinθ). At θ=0 this is the old direct maths.
  private aimArm(pivot: TransformNode, world: Vector3): void {
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
  }

  private setArmDir(pivot: TransformNode, dx: number, dy: number, dz: number): void {
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
