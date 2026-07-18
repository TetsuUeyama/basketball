import { Scene, ArcRotateCamera, Vector3 } from "@babylonjs/core";
import { lerp } from "./util";

// Broadcast-style camera that smoothly follows the ball along the sideline.
// The user can still drag/zoom; auto-follow only adjusts the target point.
export class BroadcastCamera {
  readonly cam: ArcRotateCamera;
  autoFollow = true;
  private targetX = 0;
  private targetZ = 0;
  private targetY = 1.2;
  // pregame player-introduction tour: while true, introShot() owns the camera
  // every frame and the broadcast follow is suspended
  private introMode = false;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.cam = new ArcRotateCamera("cam", -Math.PI / 2, 0.95, 24, new Vector3(0, 1.2, 0), scene);
    this.cam.attachControl(canvas, true);
    this.cam.lowerRadiusLimit = 12;
    this.cam.upperRadiusLimit = 48;
    this.cam.upperBetaLimit = 1.45;
    this.cam.lowerBetaLimit = 0.3;
    this.cam.wheelPrecision = 18;
    this.cam.panningSensibility = 0;
  }

  /** `followBall` (a deep shot in flight / just landed): chase the ball itself,
   *  lifting the aim toward its arc, so the rainbow and the rim stay in frame
   *  and the viewer sees whether it drops. Otherwise: the broadcast wide. */
  private enterIntro(): void {
    if (this.introMode) return;
    this.introMode = true;
    this.cam.lowerRadiusLimit = 2;     // allow the close framing (restored on endIntro)
  }

  /** Frame ONE player for the pregame intro: the camera parks a few metres out
   *  on the side his FACE actually renders (faceDirWorld = the eye meshes'
   *  world side, immune to numberSide conventions) at eye height, aiming at his
   *  body — a slightly-wide portrait, full figure in frame — and pushes in
   *  gently over the hold (`k` 0→1). Call every frame while the tour runs. */
  introShot(p: { pos: { x: number; z: number }; faceDirWorld(): { x: number; z: number } },
            k: number, dir?: { x: number; z: number }): void {
    this.enterIntro();
    const dist = 4.3 - k * 0.7;        // 少し引き — full body, with a slow push-in
    const f = dir ?? p.faceDirWorld(); // caller may pass an occlusion-cleared angle
    this.cam.target.set(p.pos.x, 1.05, p.pos.z);
    this.cam.setPosition(new Vector3(p.pos.x + f.x * dist, 1.7, p.pos.z + f.z * dist));
  }

  /** ONE pulled-back cut that frames a whole BENCH row at once: the camera backs
   *  off toward the court far enough for every seated player to fit, centred on
   *  the row, with a gentle push-in over the hold. The seated players sit
   *  straight and turn to LOOK AT THE LENS (a team photo), not off at the ball. */
  benchShot(players: { pos: { x: number; z: number }; faceToward(x: number, z: number): void }[],
            k: number): void {
    if (players.length === 0) return;
    this.enterIntro();
    let minZ = Infinity, maxZ = -Infinity, sumX = 0;
    for (const p of players) {
      minZ = Math.min(minZ, p.pos.z); maxZ = Math.max(maxZ, p.pos.z);
      sumX += p.pos.x;
    }
    const cx = sumX / players.length;          // the bench line (x ≈ courtside seats)
    const cz = (minZ + maxZ) / 2;
    const span = maxZ - minZ;
    // pull back toward the court (the seats face the floor) until the row fits
    const dist = Math.max(4.5, span * 0.62 + 2.4) - k * 0.5;
    const side = cx >= 0 ? -1 : 1;             // approach from the court side
    const camX = cx + side * dist;
    for (const p of players) p.faceToward(camX, cz);   // every face to the camera
    this.cam.target.set(cx, 1.0, cz);
    this.cam.setPosition(new Vector3(camX, 2.1, cz));
  }

  /** The tour is over — restore the broadcast wide and its zoom limits. */
  endIntro(): void {
    if (!this.introMode) return;
    this.introMode = false;
    this.cam.lowerRadiusLimit = 12;
    this.targetX = 0; this.targetZ = 0; this.targetY = 1.2;
    this.cam.target.set(0, 1.2, 0);
    this.cam.alpha = -Math.PI / 2;
    this.cam.beta = 0.95;
    this.cam.radius = 24;
  }

  update(dt: number, ballX: number, ballZ: number, ballY = 1.2, followBall = false): void {
    if (this.introMode) return;        // the intro tour owns the camera
    if (!this.autoFollow) return;
    if (followBall) {
      const e = Math.min(1, dt * 5);   // snappier than the wide frame — the ball is quick
      this.targetX = lerp(this.targetX, ballX, e);
      this.targetZ = lerp(this.targetZ, ballZ, e);
      this.targetY = lerp(this.targetY, Math.min(1.2 + ballY * 0.35, 4.0), e);
    } else {
      // ease the target toward the ball; bias toward court centre so it stays wide
      this.targetX = lerp(this.targetX, ballX * 0.5, Math.min(1, dt * 2));
      this.targetZ = lerp(this.targetZ, ballZ * 0.85, Math.min(1, dt * 2));
      this.targetY = lerp(this.targetY, 1.2, Math.min(1, dt * 2));
    }
    this.cam.target.set(this.targetX, this.targetY, this.targetZ);
  }
}
