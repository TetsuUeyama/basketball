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

// Procedural face look per roster slot — SHARED by the HUD face icon (2D canvas)
// and the 3D player head, so the on-court player matches his icon. Seeded by the
// roster index so it's deterministic and identical on both sides.
const SKIN_HEX = ["#f2cfa8", "#e6b48c", "#cf9a6a", "#a9713f", "#8a5a2b"];
const HAIR_HEX = ["#20140a", "#3a2413", "#0e0e0e", "#5a3a1c", "#7a5230"];
function hexRGB(h: string): { r: number; g: number; b: number } {
  const n = parseInt(h.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
// hairStyle 0..4: 0=短髪 1=坊主(bald) 2=アフロ 3=フラットトップ(背高) 4=ヘッドバンド
export type PlayerLook = {
  skinHex: string; hairHex: string;
  skin: { r: number; g: number; b: number }; hair: { r: number; g: number; b: number };
  style: number;
};
export function playerLook(idx: number): PlayerLook {
  const h = (idx * 2654435761) >>> 0;
  const skinHex = SKIN_HEX[h % SKIN_HEX.length];
  const hairHex = HAIR_HEX[(h >>> 3) % HAIR_HEX.length];   // unsigned shift (>> could go negative → undefined)
  const style = (h >>> 7) % 5;                             // hairstyle — spreads players apart visually
  return { skinHex, hairHex, skin: hexRGB(skinHex), hair: hexRGB(hairHex), style };
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
