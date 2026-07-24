// ベンチ演出（方式B: GameState 集約）。ベンチ選手の着席位置(benchSeat/seatOnBench)と、
// 得点/勝利時の歓声アニメ(benchCheer/updateBenchCheer)。状態は Game に集約し game を受け取る。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { COURT } from "../config";
import { clamp, rand, chance } from "../util";
import type { Game } from "../game";

export function benchSeat(game: Game, p: Player): { x: number; z: number } {
    const x = COURT.halfW + 2.3;                  // far (+X) sideline, set back off the court
    const zEnd = COURT.halfL - 1;                 // first seat just inside the baseline
    const z = (p.team === 0 ? -1 : 1) * (zEnd - p.idx * 0.8);
    return { x, z };
  }

export function seatOnBench(game: Game, p: Player): void {
    const s = benchSeat(game, p);
    p.pos.set(s.x, 0, s.z);
    p.cutting = false;
    p.screening = false;
    p.sit();          // compress + drop onto the bench seat (sitting look)
    p.sync();
  }

export function benchCheer(game: Game, team: number, duration = 1.8, amp = 0.5): void {
    const fresh = game.cheerT[team] <= 0;   // previous cheer already over → start anew
    game.cheerT[team] = Math.max(game.cheerT[team], duration);
    game.cheerAmp[team] = fresh ? amp : Math.max(game.cheerAmp[team], amp);
  }

  // While a cheer is running, everyone on that bench bounces with both arms up;
  // when it winds down they land, drop their arms and sit back into the game.
  // Bench players get no per-frame updates elsewhere, so jump/sync tick here.
export function updateBenchCheer(game: Game, dt: number): void {
    for (let t = 0; t < 2; t++) {
      if (game.cheerT[t] <= -1.6) continue;     // fully settled (all have sat by now)
      game.cheerT[t] -= dt;
      const amp = game.cheerAmp[t];   // celebration intensity (dunk / three → 1.0)
      for (const p of game.roster[t]) {
        if (game.onCourt(p)) continue;
        if (game.subWalkers.some((w) => w.p === p)) continue; // mid-walk — not cheering
        p.updateJump(dt);
        const seat = benchSeat(game, p);
        const frontX = seat.x - (0.8 + amp * 0.7);   // a bigger celebration steps further out
        // each reserve lingers a personal beat before dropping back — so the
        // bench doesn't all sit down in lockstep
        const windOff = ((p.idx * 37) % 10) * 0.08;   // 0 .. ~0.72s of extra celebrating
        const winding = game.cheerT[t] <= -windOff;
        if (!winding) {
          p.stand();   // up off the seat to celebrate
          // step out in front of the bench so they're not jumping through it
          p.pos.x += (frontX - p.pos.x) * Math.min(1, dt * 5);
          p.pos.z = seat.z;
          // bigger, more frequent jumps for a dunk / three
          if (!p.airborne && chance((1.6 + amp * 2.4) * dt)) {
            p.jump(rand(0.2, 0.38) + amp * 0.4, rand(0.35, 0.55));
          }
          // arms overhead, angled a touch differently per player so the bench
          // doesn't celebrate in lockstep; they punch higher on a big play
          const ox = ((p.idx * 37) % 11 - 5) * 0.06;
          const oy = ((p.idx * 13) % 7) * 0.08;
          p.reach(new Vector3(p.pos.x + ox, 2.9 + oy + amp * 0.5, p.pos.z), true);
        } else {
          // wind down: walk back to the seat, then sit once there
          p.pos.x += (seat.x - p.pos.x) * Math.min(1, dt * 5);
          if (!p.airborne && Math.abs(p.pos.x - seat.x) < 0.12) p.sit();
        }
        p.sync();
      }
    }
  }
