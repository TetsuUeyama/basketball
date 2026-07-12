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
  update(dt: number, ballX: number, ballZ: number, ballY = 1.2, followBall = false): void {
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
