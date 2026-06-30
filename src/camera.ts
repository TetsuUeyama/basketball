import { Scene, ArcRotateCamera, Vector3 } from "@babylonjs/core";
import { lerp } from "./util";

// Broadcast-style camera that smoothly follows the ball along the sideline.
// The user can still drag/zoom; auto-follow only adjusts the target point.
export class BroadcastCamera {
  readonly cam: ArcRotateCamera;
  autoFollow = true;
  private targetX = 0;
  private targetZ = 0;

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

  update(dt: number, ballX: number, ballZ: number): void {
    if (!this.autoFollow) return;
    // ease the target toward the ball; bias toward court centre so it stays wide
    this.targetX = lerp(this.targetX, ballX * 0.5, Math.min(1, dt * 2));
    this.targetZ = lerp(this.targetZ, ballZ * 0.85, Math.min(1, dt * 2));
    this.cam.target.set(this.targetX, 1.2, this.targetZ);
  }
}
