import { Vector3 } from "@babylonjs/core";

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** 0..100 の能力値を 0..1 の係数へ写す。 */
export const rate = (r: number): number => clamp(r, 0, 100) / 100;
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

/** 角度(rad)を [-π, π] へ正規化する。 */
export function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** (fromX,fromZ)→(toX,toZ) のXZ平面単位ベクトルと距離。ゼロ距離は len=1 扱い。 */
export function dirTo2D(fromX: number, fromZ: number, toX: number, toZ: number):
    { ux: number; uz: number; len: number } {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  return { ux: dx / len, uz: dz / len, len };
}

/** (fromX,fromZ) から (toX,toZ) の方向へ dist だけ進んだ点。 */
export function towardPoint(fromX: number, fromZ: number, toX: number, toZ: number, dist: number):
    { x: number; z: number } {
  const { ux, uz } = dirTo2D(fromX, fromZ, toX, toZ);
  return { x: fromX + ux * dist, z: fromZ + uz * dist };
}

/** keyFn が最小の要素を返す（空リストは null、同値は先勝ち）。 */
export function nearestOf<T>(list: readonly T[], keyFn: (t: T) => number): T | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const t of list) {
    const d = keyFn(t);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

/** 点(px,pz)の線分(a→b)への射影率t(クランプなし)と、その射影点までの垂直距離。縮退線分は len²=1 扱い。 */
export function segPerp(ax: number, az: number, bx: number, bz: number, px: number, pz: number):
    { t: number; perp: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = ((px - ax) * dx + (pz - az) * dz) / len2;
  return { t, perp: Math.hypot(px - (ax + dx * t), pz - (az + dz * t)) };
}

/** 指数イーズ: rateCap>0 なら cur から target へ 1-exp(-rateCap*dt) 分だけ近づけた値、それ以外は target。 */
export function expEase(cur: number, target: number, rateCap: number, dt: number): number {
  if (rateCap <= 0) return target;
  return cur + (target - cur) * (1 - Math.exp(-rateCap * dt));
}
