// 方向転換・傾き: 勢い/傾いた体に逆らって向きを変えるコストと、傾きの回復。
import { rate, clamp } from "../../util";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    turnFactor(tx: number, tz: number): number;
    leanFactor(tx: number, tz: number): number;
    leanRecoverRate(): number;
    decayLean(dt: number): void;
  }
}

/** 既存の勢いを(tx,tz)へ向け直すときに保持されるトップスピードの割合。敏捷性が
 *  高いと素早い選手は速度を失わずにカット/切り返しできる。遅い選手は方向を
 *  変えるのに減速せねばならない。まっすぐ動く/静止からは~1。 */
Player.prototype.turnFactor = function(tx: number, tz: number): number {
  if (this.curSpd < 1.2) return 1;                   // 逆らうべき勢いがほとんどない
  const vl = Math.hypot(this.velX, this.velZ);
  const dx = tx - this.pos.x, dz = tz - this.pos.z;
  const dl = Math.hypot(dx, dz);
  if (vl < 0.15 || dl < 0.1) return 1;
  const dot = (dx * this.velX + dz * this.velZ) / (dl * vl); // -1（逆走）.. 1（まっすぐ）
  const turn = (1 - dot) / 2;                         // 0 .. 1
  const keep = 0.32 + rate(this.attr.agility) * 0.68; // 0.32（遅い）.. 1.0（素早い）
  return clamp(1 - turn * (1 - keep), 0.35, 1);
};

/** 体が傾いている間に(tx,tz)へ動くとき保持される速度の割合: 傾きと同じ向き
 *  （またはスクエア）へ動くのは滑らかだが、傾きに逆らって切り返すにはまず重心を
 *  足の上へ引き戻す必要がある — その最初の一歩が遅い。これはドリブラーが守備者を
 *  左右に揺さぶり、彼が戻れないサイドへ抜けることで突く要素（傾き自体は別の場所で
 *  敏捷性に応じて減衰する）。 */
Player.prototype.leanFactor = function(tx: number, tz: number): number {
  const m = Math.abs(this.lean);
  if (m < 0.12) return 1;                            // ほぼスクエア
  const dx = tx - this.pos.x, dz = tz - this.pos.z;
  const dl = Math.hypot(dx, dz);
  if (dl < 0.05) return 1;
  // 符号付きのワールド空間の傾き方向
  const lx = this.leanAxisX * this.lean, lz = this.leanAxisZ * this.lean;
  const ll = Math.hypot(lx, lz);
  if (ll < 1e-4) return 1;
  const align = (dx * lx + dz * lz) / (dl * ll);     // -1 逆らう .. +1 同じ向き
  return clamp(1 - m * Math.max(0, -align) * 0.55, 0.4, 1);
};

/** この選手が重心を足の上へ引き戻す速さ(単位/s)。クイックネス(敏捷性)が支配する。
 *  足の重い65で~0.7/s（フルの傾きのリセットに~1.4 s）、素早い85で~2.0/s（~0.5 s）。 */
Player.prototype.leanRecoverRate = function(): number {
  return clamp(0.35 + (rate(this.attr.agility) - 0.70) * 9.0, 0.3, 2.6);
};

/** この選手と誰も積極的に競り合っていないとき、傾いた横方向の重心をスクエアへ
 *  徐々に戻す。（オンボールの競り合いはdefendOnBall内で、シェードへ向かう独自の
 *  回復を持つ。） */
Player.prototype.decayLean = function(dt: number): void {
  if (this.lean === 0) return;
  const r = this.leanRecoverRate() * dt;
  this.lean += clamp(-this.lean, -r, r);
};
