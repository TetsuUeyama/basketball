// デッドボール解決（方式B: GameState 集約）。ターンオーバー(turnover)、ショット
// クロック違反(shotClockViolation)、ディフェンシブファウル(defensiveFoul)と、その後の
// サイドスローイン(sideInbound)。ポゼッション交代とスローイン再開を司る。共有インフラの
// pauseThen/updatePause は Game 残置(多所参照)。状態は Game に集約し game を受け取る。
import { Player } from "../player";
import { COURT, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, teamShort } from "../config";
import { clamp, dist2D } from "../util";
import { rate } from "../attributes";
import type { Game } from "../game";

  // Non-shooting (reach-in) foul: the offence keeps the ball and inbounds.
export function defensiveFoul(game: Game, victim: Player, fouler?: Player): void {
    // knocked AWAY from the man who hit him; how hard depends on the fouler's
    // strength/aggression vs how well the victim keeps his balance
    let px = 0, pz = 0, strength = 0.5;
    if (fouler) {
      px = victim.pos.x - fouler.pos.x;
      pz = victim.pos.z - fouler.pos.z;
      strength = clamp(0.3 + rate(fouler.attr.balance) * 0.4 + rate(fouler.attr.aggression) * 0.2
        - rate(victim.attr.balance) * 0.35, 0.1, 1);
    }
    victim.foulReaction("hurt", px, pz, strength);   // rock off the contact while play stops
    game.setEvent("FOUL", victim.team);
    game.possession = victim.team;
    game.handler = null;
    game.shotClock = Math.max(game.shotClock, SHOT_CLOCK_PARTIAL); // partial reset on a foul
    // hold so the foul reads, then subs, then the side inbound (the fouled
    // player takes the ball in, so he can't be subbed here)
    game.pauseThen(1.2, () => game.withSubs(() => sideInbound(game, victim), victim));
  }

export function sideInbound(game: Game, victim: Player): void {
    game.possession = victim.team;
    game.handler = victim;
    game.ballMode = "inbound";
    game.inbound.t = 1.0;
    // whose ball the restart is (the foul call has had its beat on screen)
    game.setEvent(`THROW-IN\n${teamShort(victim.team)} BALL`, victim.team, 2.0);
    const sideX = victim.pos.x >= 0 ? COURT.halfW + 0.3 : -(COURT.halfW + 0.3);
    victim.pos.set(sideX, 0, clamp(victim.pos.z, -COURT.halfL + 1, COURT.halfL - 1));
    game.resetMotion();
    game.inbound.receiver = game.inbound.pickReceiver(victim);
  }

  // Shot-clock expiry is an OFFENSIVE VIOLATION: a dead ball (not a live steal).
  // Play stops, the offence is charged a turnover, and the defence restarts with
  // a throw-in.
export function shotClockViolation(game: Game): void {
    const off = game.handler ?? game.teamPlayers(game.possession)[0];
    off.stats.tov++;
    const offTeam = game.possession;   // the team that committed the violation
    const def = 1 - offTeam;
    // FIBA: the throw-in is from the out-of-bounds spot NEAREST to where play was
    // stopped (no special case for the 24-second violation) — remember it now,
    // before the dead-ball pause moves anyone. The clock rule follows the spot:
    // in the new offence's FRONTcourt (i.e. the violation was committed in the
    // old offence's backcourt, a smothered bring-up) the restart clock is the
    // short one; a backcourt throw-in restarts with the full clock.
    const sx = game.ball.pos.x, sz = game.ball.pos.z;
    const front = sz * game.attackSign(def) > 0;
    game.handler = null;
    // announce the OFFENSIVE violation (attributed to the offence) and hold it on
    // screen through the dead-ball pause before the defence's throw-in restart
    game.setEvent("SHOT CLOCK VIOLATION", offTeam, 2.6);
    // the restart banner then says WHOSE ball the throw-in is
    game.pauseThen(1.2, () => game.withSubs(() => game.inbound.startAt(def, sx, sz,
      { clock: front ? SHOT_CLOCK_PARTIAL : SHOT_CLOCK })));
  }

export function turnover(game: Game, loser: Player, reason: string): void {
    loser.stats.tov++;
    // give the ball to the nearest opponent
    const opp = game.teamPlayers(1 - loser.team);
    let near = opp[0];
    for (const p of opp) {
      if (dist2D(p.pos, loser.pos) < dist2D(near.pos, loser.pos)) near = p;
    }
    game.handler = near;
    game.possession = near.team;
    game.ballMode = "held";
    game.shotClock = SHOT_CLOCK;
    near.decisionT = 0.4;
    game.resetMotion();
    game.leakOut();          // 飛び出し runners take off on the turnover
    game.setEvent(reason, near.team);
  }
