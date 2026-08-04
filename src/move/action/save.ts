// コート外へ逸れたパスのセーブ。受け手がラインの外へ横っ飛びで追い、掴めたら
// 着地する前に味方へ投げ返す。追走中とセーブ後の復帰中だけ、その選手はコートの
// 外へ出てよい（Game.clampCourt が saveBy を素通しする）。
import { Player } from "../../objects/player/player";
import { COURT, MAX_PASS } from "../../config";
import { rate, clamp, chance, dist2D, dist2DTo, moveToward2D } from "../../util";
import type { Game } from "../../game";

// ラインからこの距離までなら追う。これより外は届かないので見送る。
const CHASE_OOB = 2.2;
// 踏み切る残り飛行時間の窓(秒)
const DIVE_WINDOW = 0.32;
// 横っ飛びの跳躍距離の下限/上限(m)
const DIVE_MIN = 1.25;
const DIVE_MAX = 2.6;
// セーブ後、コートへ戻るまでクランプを外しておく上限(秒)
const RECOVER = 3.0;

export interface SaveResult { caught: boolean; mate: Player | null }

/** その点がラインの外か。 */
export function outOfCourt(x: number, z: number): boolean {
  return Math.abs(x) > COURT.halfW || Math.abs(z) > COURT.halfL;
}

/** 逸れたパスを受け手が追うか。ラインのすぐ外で、他に復帰中の選手がいないときだけ。 */
export function wantSave(game: Game, r: Player): boolean {
  if (game.saveBy) return false;   // 前のセーブの復帰中は重ねない
  const c = game.passCatch;
  if (!outOfCourt(c.x, c.z)) return false;
  const over = Math.max(Math.abs(c.x) - COURT.halfW, Math.abs(c.z) - COURT.halfL);
  if (over > CHASE_OOB) return false;
  // 飛行時間で落下点の1ストライド以内まで詰められるか
  const reach = r.runSpeed * 1.35 * game.passDur + 1.4;
  return dist2DTo(r.pos, c.x, c.z) <= reach;
}

/** セーブを始める（受け手をクランプ免除にする）。 */
export function beginSave(game: Game, r: Player): void {
  game.saveBy = r;
  game.saveT = game.passDur + RECOVER;
}

/** 追走と踏み切り。updatePass の受け手移動の代わりに毎フレーム呼ぶ。 */
export function updateSaveChase(game: Game, dt: number, r: Player): void {
  if (r.airborne) return;                       // 跳んだ後は leap が運ぶ
  const c = game.passCatch;
  const remain = Math.max(dt, game.passDur - game.passT);
  const gap = dist2DTo(r.pos, c.x, c.z);
  // 踏み切り: 残り時間が短く、跳んで届く距離なら横っ飛びでラインを越える。
  // ⚠️ leap はジャンプ全体に均等配分されるので、ボールが着く remain 時点で落下点に
  //    重なるよう跳躍距離を dur/remain 倍する（跳び越えたぶんは滑り込みに見える）。
  // ⚠️ 浅い外れでも最低 DIVE_MIN は跳ぶ。落下点まで歩いて行くと、ラインの外に
  //    立ったまま取る形になり（＝掴めば違反）セーブに見えない。
  const dive = 1.0 + rate(r.attr.jump) * 0.9;
  if (remain <= DIVE_WINDOW && remain >= 0.12 && gap <= dive && r.landT <= 0) {
    const dur = remain + 0.35;
    const len = clamp(gap * Math.min(dur / remain, 2.5), DIVE_MIN, DIVE_MAX);
    const dx = c.x - r.pos.x, dz = c.z - r.pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    r.jump(0.34, dur, (dx / dl) * len, (dz / dl) * len);
    return;
  }
  // 走るのはラインの内側まで。越えるのは跳躍で。
  const inX = clamp(c.x, -(COURT.halfW - 0.1), COURT.halfW - 0.1);
  const inZ = clamp(c.z, -(COURT.halfL - 0.1), COURT.halfL - 0.1);
  const run = dist2DTo(r.pos, inX, inZ);
  if (run > 0.02) {
    moveToward2D(r.pos, inX, inZ, Math.min(run / remain, r.runSpeed * 1.35) * dt);
  }
}

/** ボール到達時の判定。掴めたら投げ返す味方（居なければ null）を返す。 */
export function saveCatch(game: Game, r: Player): SaveResult {
  const c = game.passCatch;
  const gap = dist2DTo(r.pos, c.x, c.z);
  if (gap > 1.0) return { caught: false, mate: null };
  // ライン外に足がある状態では掴めない（掴めば違反）。跳び込んで空中なら掴める。
  if (!r.airborne && outOfCourt(r.pos.x, r.pos.z)) return { caught: false, mate: null };
  // 反応と手のテクニックで掴む。跳び込んでいる方が体が伸びて届く。深いほど難しい。
  const over = Math.max(Math.abs(c.x) - COURT.halfW, Math.abs(c.z) - COURT.halfL);
  const p = 0.05 + rate(r.attr.reaction) * 0.35 + rate(r.attr.handling) * 0.20
    + (r.airborne ? 0.10 : 0) - gap * 0.25 - over * 0.25;
  if (!chance(clamp(p, 0.05, 0.85))) return { caught: false, mate: null };
  return { caught: true, mate: outlet(game, r) };
}

/** 投げ返す先: ラインから余裕を持ってコート内に居る、一番近い味方。 */
function outlet(game: Game, r: Player): Player | null {
  let best: Player | null = null, bd = Infinity;
  for (const m of game.teamPlayers(r.team)) {
    if (m === r) continue;
    if (Math.abs(m.pos.x) > COURT.halfW - 1.0 || Math.abs(m.pos.z) > COURT.halfL - 1.0) continue;
    const d = dist2D(r.pos, m.pos);
    if (d > MAX_PASS || d >= bd) continue;
    bd = d; best = m;
  }
  return best;
}

/** セーブした選手をコートへ戻す。戻りきる/時間切れでクランプ免除を解く。 */
export function updateSaveRecover(game: Game, dt: number): void {
  const p = game.saveBy;
  if (!p) return;
  game.saveT -= dt;
  if (game.saveT <= 0) { game.saveBy = null; game.saveT = 0; return; }
  // 追走中（まだこのパスの受け手）は、コート内に居ても解除しない
  if (game.ballMode === "pass" && game.passTo === p) return;
  const mw = COURT.halfW - COURT.margin, ml = COURT.halfL - COURT.margin;
  if (Math.abs(p.pos.x) <= mw && Math.abs(p.pos.z) <= ml) {
    game.saveBy = null; game.saveT = 0;
    return;
  }
  if (p.airborne) return;
  moveToward2D(p.pos, clamp(p.pos.x, -mw, mw), clamp(p.pos.z, -ml, ml),
    p.accelSpeed(dt, 0.8) * dt);
}
