// ボールの挙動・軌道のベース定義。重力・反発・摩擦・速度上限・接地高さを一元化し、
// 自由飛行の1ステップ（積分・床バウンド・境界反射・速度クランプ）をここで行う。
// シュート/パスの弾道はアクション側（move/action）がこのベースの上に定義する。
import { Ball } from "../../objects/ball";
import { BENCH, COURT, OOB_WALL, RIM } from "../../config";

export const BALL = {
  gravity: 9.0,     // 自由飛行の重力(m/s²)
  restY: 0.12,      // 接地時のボール中心高さ(m)
  radius: 0.12,     // ボール半径(m)。反射は中心でなく表面で判定する
  bounce: 0.62,     // 床バウンドの反発係数
  friction: 0.72,   // 床バウンド時の水平減衰
  wallBounce: 0.6,  // コート境界反射の減衰
  boardBounce: 0.6, // バックボード反射の減衰
  maxSpeed: 10,     // 自由飛行の速度上限(m/s)
} as const;

// バックボード面の寸法(court.ts の board メッシュと一致)。板は z=±backboardZ、幅1.8/高1.05/厚0.05。
const BOARD = {
  faceZ: RIM.backboardZ - 0.025,        // 板のコート側の面(厚みの手前)
  halfW: 0.9,                           // 幅1.8 の半分(x 範囲)
  yTop: RIM.height + 0.3 + 0.525,       // 板の上端
  yBot: RIM.height + 0.3 - 0.525,       // 板の下端
} as const;

/** バックボード反射: 板の面にボールの「表面」(中心±半径)が届いたら跳ね返す。中心でなく
 *  半径で判定するのでボールは板にめり込まない。両エンド(±z)を扱う。 */
function bounceOffBoard(b: Ball): void {
  const r = BALL.radius;
  if (Math.abs(b.pos.x) > BOARD.halfW + r) return;             // 板の幅の外
  if (b.pos.y < BOARD.yBot - r || b.pos.y > BOARD.yTop + r) return; // 板の高さの外
  // +Z 側の板: コート側(−z)から近づく。表面が面に届いたら反射。
  if (b.vel.z > 0 && b.pos.z + r >= BOARD.faceZ && b.pos.z < RIM.backboardZ) {
    b.pos.z = BOARD.faceZ - r;                                  // 表面が板に接する位置へ
    b.vel.z = -Math.abs(b.vel.z) * BALL.boardBounce;
  } else if (b.vel.z < 0 && b.pos.z - r <= -BOARD.faceZ && b.pos.z > -RIM.backboardZ) {
    b.pos.z = -BOARD.faceZ + r;
    b.vel.z = Math.abs(b.vel.z) * BALL.boardBounce;
  }
}

/** ベンチ（座面＋背もたれ）の箱。実在の障害物なのでボールは突き抜けず、面で跳ね返る。
 *  ボールは表面(中心±半径)で判定する。両ハーフ対称なので |z| で見る。 */
function bounceOffBench(b: Ball): void {
  const r = BALL.radius;
  const zLo = BENCH.zMid - BENCH.len / 2, zHi = BENCH.zMid + BENCH.len / 2;
  const az = Math.abs(b.pos.z);
  if (az < zLo - r || az > zHi + r) return;
  const x0 = BENCH.x - BENCH.seatD / 2;                       // 座面の前縁(コート側)
  const x1 = BENCH.x + BENCH.seatD / 2 + BENCH.backT;         // 背もたれの後縁
  const top = b.pos.y > BENCH.backTop ? 0 : (b.pos.y > BENCH.seatTop ? 1 : 2);
  // 背もたれより上を通過 → 当たらない
  if (top === 0) return;
  if (top === 1) {
    // 座面の上・背もたれの高さ: 背もたれの板だけが障害物
    const bx0 = BENCH.x + BENCH.seatD / 2, bx1 = x1;
    if (b.pos.x + r < bx0 || b.pos.x - r > bx1) return;
    b.pos.x = b.pos.x < (bx0 + bx1) / 2 ? bx0 - r : bx1 + r;
    b.vel.x = (b.pos.x < BENCH.x ? -1 : 1) * Math.abs(b.vel.x) * BALL.wallBounce;
    return;
  }
  // 座面より下: 座面の天面に乗せるか、前後の面で弾く
  if (b.pos.x + r < x0 || b.pos.x - r > x1) return;
  if (b.pos.y + r > BENCH.seatTop && b.vel.y < 0) {           // 天面へ落ちてきた → 座面で弾む
    b.pos.y = BENCH.seatTop + r;
    b.vel.y = Math.abs(b.vel.y) * BALL.bounce;
    b.vel.x *= BALL.friction;
    b.vel.z *= BALL.friction;
    return;
  }
  const toFront = b.pos.x - (x0 - r), toBack = (x1 + r) - b.pos.x;   // 近い側の面へ押し出す
  if (toFront < toBack) { b.pos.x = x0 - r; b.vel.x = -Math.abs(b.vel.x) * BALL.wallBounce; }
  else { b.pos.x = x1 + r; b.vel.x = Math.abs(b.vel.x) * BALL.wallBounce; }
}

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
  // バックボード反射(reflect に依らず常に有効 — 板は実在の障害物)。表面で判定=めり込まない。
  bounceOffBoard(b);
  bounceOffBench(b);   // ベンチも同様に実在の障害物
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
