import { Vector3 } from "@babylonjs/core";

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const chance = (p: number) => Math.random() < p;

/** 2点間の水平（XZ平面）距離。 */
export function dist2D(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

export function dist2DTo(a: Vector3, x: number, z: number): number {
  return Math.hypot(a.x - x, a.z - z);
}

/** `cur` を `(tx,tz)` へ、XZ平面上で最大 `maxStep` だけ動かす。cur を変更する。 */
export function moveToward2D(cur: Vector3, tx: number, tz: number, maxStep: number): void {
  const dx = tx - cur.x;
  const dz = tz - cur.z;
  const d = Math.hypot(dx, dz);
  if (d <= maxStep || d === 0) {
    cur.x = tx;
    cur.z = tz;
    return;
  }
  cur.x += (dx / d) * maxStep;
  cur.z += (dz / d) * maxStep;
}
