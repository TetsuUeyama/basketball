import { Vector3 } from "@babylonjs/core";

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const chance = (p: number) => Math.random() < p;

/** Horizontal (XZ-plane) distance between two points. */
export function dist2D(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

export function dist2DTo(a: Vector3, x: number, z: number): number {
  return Math.hypot(a.x - x, a.z - z);
}

/** Move `cur` toward `(tx,tz)` by at most `maxStep`, in the XZ plane. Mutates cur. */
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

/** Pick a weighted-random index from a list of weights (all >= 0). */
export function weightedPick(weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}
