// ゲームフロー: クォーター終了処理・ハーフ/試合終了のフィナーレ・クォーター間の
// 退場/入場ウォーク（方式B: GameState 集約）。状態は Game に集約し各関数は第一引数
// game を受け取る。ライブ進行(updateLive)や状況判断とは分離した進行管理レイヤ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { QUARTERS, QUARTER_TIME, SHOT_CLOCK, COURT, teamShort } from "../config";
import { clamp, rand, dist2D, dist2DTo, moveToward2D } from "../util";
import { festivePose } from "./poses";
import type { Game } from "../game";

// フィナーレ(勝利/引き分け)演出の総尺(秒)
const FINALE_DUR = 6.0;

  // The period ends on the buzzer, but not abruptly: an END banner, then both
  // fives WALK OFF to their benches, hold there a beat, and (after any subs)
  // walk back out to their spots for the next period's throw-in.
export function endQuarter(game: Game, ): void {
    game.coastT = 0;
    game.ballFalling = false;
    const leader = game.score[0] === game.score[1]
      ? game.possession
      : (game.score[0] > game.score[1] ? 0 : 1);
    game.handler = null;
    game.gameClock = 0;
    const ended = game.quarter;
    // log this period's points for the result-screen line score (cumulative
    // score minus what the earlier periods already accounted for). Guarded so a
    // re-entrant buzzer path can't record the same quarter twice.
    if (game.qLine[0].length < ended) {
      for (let t = 0; t < 2; t++) {
        const prior = game.qLine[t].reduce((s, v) => s + v, 0);
        game.qLine[t].push(game.score[t] - prior);
      }
    }
    game.setEvent(ended === 2 ? "HALFTIME" : `END OF Q${ended}`, leader, 3.0);
    // the break itself restores some legs — halftime considerably more
    if (ended < QUARTERS) {
      const rest = ended === 2 ? 0.15 : 0.06;
      for (let t = 0; t < 2; t++) for (const p of game.roster[t]) p.breakRecover(rest);
    }

    // the FINAL horn gets its own scene: winners mob the floor, losers hang
    // their heads (a draw celebrates both benches) — no walk-off first
    if (ended >= QUARTERS) {
      game.pauseThen(1.2, () => startFinale(game));
      return;
    }

    game.pauseThen(1.2, () => quarterWalkOff(game, () => {
      // a short huddle at the bench, then the next period
      game.pauseThen(1.0, () => {
        game.quarter = ended + 1;
        game.gameClock = QUARTER_TIME;
        game.shotClock = SHOT_CLOCK;
        game.applyNumberSides(); // teams switch ends at half-time — numbers follow
        // Possession to start the period follows the opening-tip rule (NBA):
        // the team that LOST the opening jump ball starts Q2 & Q3; the winner
        // starts Q4 (ends switched in the second half via attackSign).
        const team = quarterStartTeam(game, game.quarter);
        game.withSubs(() => quarterWalkOn(game, team));
      });
    }));
  }

export function startFinale(game: Game, ): void {
    const w = game.score[0] === game.score[1] ? -1 : (game.score[0] > game.score[1] ? 0 : 1);
    game.finaleWinner = w;
    game.finaleT = 0;
    game.finaleWalkers = [];
    game.finaleTrudge = [];
    game.handler = null;
    game.cheerT = [-9, -9];   // the finale supersedes any running bench cheer
    game.setEvent(w >= 0 ? `${teamShort(w)} WINS!` : "DRAW",
      w >= 0 ? w : game.possession, FINALE_DUR);
    // centre of the winning five, so the bench can fan out around them
    const winFive = w >= 0 ? game.teamPlayers(w) : [];
    const cx = winFive.length ? winFive.reduce((s, q) => s + q.pos.x, 0) / winFive.length : 0;
    const cz = winFive.length ? winFive.reduce((s, q) => s + q.pos.z, 0) / winFive.length : 0;
    for (let t = 0; t < 2; t++) {
      for (const p of game.roster[t]) {
        const onCourt = game.onCourt(p);
        if (t === w) {
          if (onCourt) continue;   // on-court winners celebrate in place (updateFinale)
          // the winning bench rushes the floor, fanning out around the five
          p.stand();
          p.resetFacing();
          const ang = (game.finaleWalkers.length / 8) * Math.PI * 2;
          game.finaleWalkers.push({
            p,
            tx: clamp(cx + Math.cos(ang) * 1.8, -COURT.halfW + 1, COURT.halfW - 1),
            tz: clamp(cz + Math.sin(ang) * 1.8, -COURT.halfL + 1, COURT.halfL - 1),
          });
        } else if (w < 0) {
          if (onCourt) continue;   // draw: on-court players celebrate in place
          p.stand();               // the bench stands up and claps along
          p.resetFacing();
        } else if (onCourt) {
          // the losing five trudge off toward the front of their own bench,
          // heads down (the deep seat can be a full court away — the gather
          // spot in front of the bench is a reachable target)
          const dir = t === 0 ? -1 : 1;
          game.finaleTrudge.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
        } else if (!p.seated) {
          p.sit();       // the losing bench is already sitting, heads low
        }
      }
    }
    game.ballMode = "finale";
  }

export function updateFinale(game: Game, dt: number): void {
    game.finaleT += dt;
    const w = game.finaleWinner;
    game.ball.pos.y = Math.max(0.15, game.ball.pos.y - 3 * dt);   // ball settles
    for (let t = 0; t < 2; t++) {
      const won = t === w, draw = w < 0;
      for (const p of game.roster[t]) {
        const walker = game.finaleWalkers.find((f) => f.p === p);
        if (walker) {
          // bench mobbing the floor: sprint in, then bounce with the group
          if (dist2DTo(p.pos, walker.tx, walker.tz) > 0.6) {
            const jog = p.runSpeed * 0.9;
            moveToward2D(p.pos, walker.tx, walker.tz, jog * dt);
            p.faceToward(walker.tx, walker.tz);
            p.twistToward(walker.tx, walker.tz, dt);
            p.curSpd = jog;
            p.updateLegs(dt);
            p.runArms();
          } else {
            festivePose(game, p, dt, 1);
          }
          p.updateJump(dt);
          p.sync();
          continue;
        }
        const trudger = game.finaleTrudge.find((f) => f.p === p);
        if (trudger) {
          // the losing five walk off toward the bench, upper body hunched the
          // whole way — and keep standing there dejected once they arrive. They
          // are in game.players, so the main loop measures speed / runs the leg
          // cycle / syncs; here we only steer + hold the pose.
          if (dist2DTo(p.pos, trudger.tx, trudger.tz) > 0.4) {
            moveToward2D(p.pos, trudger.tx, trudger.tz, p.runSpeed * 0.6 * dt);   // heavy walk
            p.faceToward(trudger.tx, trudger.tz);
          }
          p.dejectedPose();                     // hunched forward, arms limp, all the way
          continue;
        }
        if (game.onCourt(p)) {
          // on-court bodies tick/sync in the main loop — just pose them
          if (won) festivePose(game, p, dt, 1);
          else if (draw) festivePose(game, p, dt, 0.45);
          else p.dejectedPose();
        } else if (draw) {
          // both benches share a standing, measured celebration at the seats
          festivePose(game, p, dt, 0.4);
          p.updateJump(dt);
          p.sync();
        } else {
          p.sync();   // the losing bench sits still, heads down
        }
      }
    }
    // keep the mob from stacking into one column
    const bodies: Player[] = [...game.players, ...game.finaleWalkers.map((f) => f.p)];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        let d = Math.hypot(dx, dz);
        if (d >= 0.62) continue;
        if (d < 1e-4) { dx = rand(-1, 1); dz = rand(-1, 1); d = Math.hypot(dx, dz) || 1; }
        const push = (0.62 - d) / 2;
        a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
        b.pos.x += (dx / d) * push; b.pos.z += (dz / d) * push;
      }
    }
    if (game.finaleT >= FINALE_DUR) {
      game.state = "final";
      game.setEvent("FINAL", game.score[0] >= game.score[1] ? 0 : 1);
    }
  }

  // Everyone on the floor walks to a gathering spot in front of his own bench.
export function quarterWalkOff(game: Game, next: () => void): void {
    game.subWalkers = [];
    for (const p of game.players) {
      const dir = p.team === 0 ? -1 : 1;      // each team's bench half
      game.subWalkers.push({ p, tx: COURT.halfW + 0.6, tz: dir * (8 + p.slot * 0.9) });
    }
    // the ball doesn't stay lying where the period died — it's placed at the
    // NEXT period's throw-in spot (centre line, left sideline — where the taker
    // will stand) before the players head for their benches, like an official
    // setting it for the restart.
    game.ball.pos.set(-(COURT.halfW + 0.3), 0.12, 0);
    game.ball.vel.set(0, 0, 0);
    game.subNext = next;
    game.subT = 0;
    game.ballMode = "subs";
  }

  // The (possibly substituted) fives walk from the bench out to the exact
  // spots the quarter throw-in uses, then the throw-in is readied in place.
export function quarterWalkOn(game: Game, team: number): void {
    const offense = game.teamPlayers(team);
    const defenders = game.teamPlayers(1 - team);
    const spots = game.formationSpots(team);
    const protect = game.attackFloor(team);
    game.subWalkers = [];
    for (const p of offense) {
      if (p === offense[2]) {                 // the throw-in taker heads wide
        game.subWalkers.push({ p, tx: -(COURT.halfW + 0.3), tz: 0 });
      } else {
        game.subWalkers.push({ p, tx: spots[p.slot].x, tz: spots[p.slot].z });
      }
    }
    for (const d of defenders) {
      const s = spots[d.slot];                // goal-side of the man's spot
      const dx = protect.x - s.x, dz = protect.z - s.z;
      const len = Math.hypot(dx, dz) || 1;
      game.subWalkers.push({ p: d, tx: s.x + (dx / len) * 1.4, tz: s.z + (dz / len) * 1.4 });
    }
    game.subNext = () => game.startQuarterInbound(team, true);
    game.subT = 0;
    game.ballMode = "subs";
  }

  // Which team starts the given quarter, by the opening-tip rule.
export function quarterStartTeam(game: Game, quarter: number): number {
    const loser = 1 - game.tipoff.winner;
    return (quarter === 2 || quarter === 3) ? loser : game.tipoff.winner;
  }
