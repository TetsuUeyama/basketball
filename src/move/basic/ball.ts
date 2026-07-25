// ボールの挙動・軌道のベース定義。重力・反発・摩擦・速度上限・接地高さを一元化し、
// 自由飛行の1ステップ（積分・床バウンド・境界反射・速度クランプ）をここで行う。
// シュート/パスの弾道はアクション側（move/action）がこのベースの上に定義する。
import { Ball } from "../../objects/ball";
import { COURT, OOB_WALL } from "../../config";

export const BALL = {
  gravity: 9.0,     // 自由飛行の重力(m/s²)
  restY: 0.12,      // 接地時のボール中心高さ(m)
  bounce: 0.62,     // 床バウンドの反発係数
  friction: 0.72,   // 床バウンド時の水平減衰
  wallBounce: 0.6,  // コート境界反射の減衰
  maxSpeed: 10,     // 自由飛行の速度上限(m/s)
} as const;

/** 自由飛行の1ステップ: 重力・積分・床バウンド。reflect でコート境界の反射も行う。 */
export function stepBallFlight(b: Ball, dt: number, reflect: boolean): void {
  b.vel.y -= BALL.gravity * dt;
  b.pos.x += b.vel.x * dt;
  b.pos.y += b.vel.y * dt;
  b.pos.z += b.vel.z * dt;
  // 床で弾んでエネルギーを失う
  if (b.pos.y < BALL.restY) {
    b.pos.y = BALL.restY;
    b.vel.y = Math.abs(b.vel.y) * BALL.bounce;
    b.vel.x *= BALL.friction;
    b.vel.z *= BALL.friction;
  }
  // 境界で反射させてインプレーに保つ。壁はエプロンの外(OOB_WALL)なので、
  // OOBになってもボールはしばらく軌道のまま外へ飛んでから壁に当たる。
  if (reflect) {
    const mw = COURT.halfW + OOB_WALL, ml = COURT.halfL + OOB_WALL;
    if (b.pos.x < -mw) { b.pos.x = -mw; b.vel.x = Math.abs(b.vel.x) * BALL.wallBounce; }
    if (b.pos.x > mw) { b.pos.x = mw; b.vel.x = -Math.abs(b.vel.x) * BALL.wallBounce; }
    if (b.pos.z < -ml) { b.pos.z = -ml; b.vel.z = Math.abs(b.vel.z) * BALL.wallBounce; }
    if (b.pos.z > ml) { b.pos.z = ml; b.vel.z = -Math.abs(b.vel.z) * BALL.wallBounce; }
  }
  // 速度をクランプして飛んでいかないようにする
  const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
  if (sp > BALL.maxSpeed) {
    const k = BALL.maxSpeed / sp;
    b.vel.x *= k;
    b.vel.y *= k;
    b.vel.z *= k;
  }
}
