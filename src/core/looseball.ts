// ルーズボール物理（方式B: GameState 集約）。空中/地面を転がる自由球の飛翔・反射、
// 選手の追走、接触判定、確保(secureLoose)までを関数として集約。エントリ点である
// goLoose/startRebound/leakOut/crashBoards は多所から使うため Game 残置。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, COURT, SHOT_CLOCK, SHOT_CLOCK_PARTIAL } from "../config";
import { clamp, dist2D, dist2DTo, moveToward2D, chance, rand } from "../util";
import { looseSecureChance } from "../resolution/rebound";
import { rate } from "../attributes";
import type { Game } from "../game";

  // One frame of ball free-flight: gravity, a floor bounce that keeps a little
  // energy (so it dribbles to rest like a real basketball), and reflection off
  // the court boundary. Shared by the loose ball and the cosmetic drop after a
  // made basket. `restY` is the floor contact height (ball radius).
export function stepBallFreeFlight(game: Game, dt: number, reflect = true): void {
    const b = game.ball;
    b.vel.y -= 9.0 * dt;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // bounce off the floor, losing energy (a rolling-to-rest dribble)
    if (b.pos.y < 0.12) { b.pos.y = 0.12; b.vel.y = Math.abs(b.vel.y) * 0.62; b.vel.x *= 0.72; b.vel.z *= 0.72; }
    // reflect off the court boundary to keep it in play — but a LIVE loose ball
    // (reflect = false) is allowed to cross the line so it can go out of bounds
    // and become a throw-in (updateLoose detects the crossing).
    if (reflect) {
      const mw = COURT.halfW - 0.1, ml = COURT.halfL - 0.1;
      if (b.pos.x < -mw) { b.pos.x = -mw; b.vel.x = Math.abs(b.vel.x) * 0.6; }
      if (b.pos.x > mw) { b.pos.x = mw; b.vel.x = -Math.abs(b.vel.x) * 0.6; }
      if (b.pos.z < -ml) { b.pos.z = -ml; b.vel.z = Math.abs(b.vel.z) * 0.6; }
      if (b.pos.z > ml) { b.pos.z = ml; b.vel.z = -Math.abs(b.vel.z) * 0.6; }
    }
    // clamp speed so a bad bounce can never send it flying (stays deterministic)
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    if (sp > 10) { const k = 10 / sp; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }
  }

export function updateLoose(game: Game, dt: number): void {
    if (game.blockHoldT > 0) {
      // BLOCK CONTACT: the swatted ball stops dead on the blocker's hand for a
      // beat so the hit reads, then the deflection velocity is released.
      game.blockHoldT -= dt;
      if (game.blockHoldT <= 0) game.ball.vel.copyFrom(game.blockHoldVel);
    } else {
      stepBallFreeFlight(game, dt, false);   // a live loose ball may cross the line
      // OUT OF BOUNDS → throw-in for the team that did NOT touch it last (e.g. a
      // block swatted out off the defender's hand stays with the offence).
      const b = game.ball.pos;
      if (Math.abs(b.x) > COURT.halfW || Math.abs(b.z) > COURT.halfL) {
        const to = game.lastTouch ? 1 - game.lastTouch.team : 1 - game.looseOff;
        game.inbound.startAt(to, b.x, b.z);
        return;
      }
    }
    for (const p of game.players) if (p.touchCool > 0) p.touchCool = Math.max(0, p.touchCool - dt);

    game.looseAge += dt;
    chaseLoose(game, dt);
    // hold off securing for a beat so a steal/deflect reads as a real scramble
    if (game.looseAge >= game.looseGrabAfter) resolveLooseContact(game);
    if (game.ballMode !== "loose") return;   // someone secured it this frame

    game.looseT -= dt;
    if (game.looseT <= 0) {                    // safety net: nearest player comes up with it
      let near = game.players[0];
      for (const p of game.players) {
        if (dist2DTo(game.ball.pos, p.pos.x, p.pos.z) < dist2DTo(game.ball.pos, near.pos.x, near.pos.z)) near = p;
      }
      secureLoose(game, near);
    }
  }

  // Only a few players actually contest a loose ball; the rest spread out to
  // get ready for the next play rather than everyone collapsing into a pile.
  // Contesters: the nearest of each team (so it's a real battle), plus any extra
  // who are genuinely close, capped at three total.
export function chaseLoose(game: Game, dt: number): void {
    const bx = game.ball.pos.x, bz = game.ball.pos.z;
    const distToBall = (p: Player) => dist2DTo(p.pos, bx, bz);

    // tick down each player's reaction-to-the-loose-ball delay
    for (const p of game.players) if (p.looseReactT > 0) p.looseReactT -= dt;

    const contest = new Set<Player>();
    if (game.looseFromTip) {
      // OPENING TIP: the tap is aimed at a specific guard — let HIM collect it, with
      // only the single nearest opponent challenging. Everyone else peels off to
      // their spots instead of all ten piling onto the ball at centre (団子回避).
      contest.add(game.tipoff.guard);
      let opp: Player | null = null, od = Infinity;
      for (const p of game.teamPlayers(1 - game.tipoff.guard.team)) {
        const dd = distToBall(p); if (dd < od) { od = dd; opp = p; }
      }
      if (opp) contest.add(opp);
    } else {
      for (const team of [0, 1]) {                 // the closest man on each team goes
        let near = game.teamPlayers(team)[0];
        for (const p of game.teamPlayers(team)) if (distToBall(p) < distToBall(near)) near = p;
        contest.add(near);
      }
      const order = [...game.players].sort((a, b) => distToBall(a) - distToBall(b));
      for (const p of order) {                      // fill up to three, but only truly close ones
        if (contest.size >= 3) break;
        if (!contest.has(p) && distToBall(p) < 2.5) contest.add(p);
      }
      // a dedicated リバウンダー crashes every scramble he can reach — but only a REAL
      // rebound (off a missed shot), not a tip-off or a steal, so a loose ball in the
      // open floor doesn't suck every big into a pile.
      for (const p of game.players) {
        if (p.evalRole === "リバウンダー" && game.looseIsRebound && distToBall(p) < 7) contest.add(p);
      }
    }

    for (const p of game.players) {
      if (contest.has(p)) {
        // still reacting to the ball coming loose → hasn't set off yet, so a
        // quicker-reacting (higher 反応) opponent gets a head start on the chase
        if (p.looseReactT > 0) continue;
        // chase the ball AROUND bodies in the way — a scramble is still not a
        // licence to run straight through someone's back
        const cv = game.steerAround(p, bx, bz);
        moveToward2D(p.pos, cv.x, cv.z, p.accelSpeed(dt, game.isBig(p) ? 1.0 : 0.9) * dt);
        game.clampCourt(p.pos);
        // time a jump to a ball that's up in the air and within a stride
        if (!p.airborne && game.ball.pos.y > 1.7 && distToBall(p) < 1.3) {
          p.jump(0.55 + rate(p.attr.jump) * 0.45, 0.6);
        }
      } else {
        // not contesting → drift to a spacing spot, ready for whatever comes next
        const spot = game.formationSpots(p.team)[p.slot];
        moveToward2D(p.pos, spot.x, spot.z, p.accelSpeed(dt, 0.8) * dt);
        game.clampCourt(p.pos);
      }
    }
  }

  // The best-placed player able to get a hand on the ball makes contact.
export function resolveLooseContact(game: Game, ): void {
    let best: Player | null = null;
    let bestReach = -Infinity;
    for (const p of game.players) {
      if (p.touchCool > 0) continue;
      if (p.looseReactT > 0) continue;   // hasn't reacted to the loose ball yet
      if (dist2DTo(game.ball.pos, p.pos.x, p.pos.z) > 0.6) continue;
      const top = p.reachTopY();
      if (game.ball.pos.y > top || game.ball.pos.y < 0.3) continue; // out of reach high/low
      if (top > bestReach) { bestReach = top; best = p; }
    }
    if (best) contactLooseBall(game, best);
  }

  // A hand reaches the ball: secure it (clean catch) or tip it (deflect the
  // trajectory). ジャンプ/反応/バランス and height drive how often it's secured;
  // defenders box out (守判断) for an edge. After a few tips the next is forced.
export function contactLooseBall(game: Game, p: Player): void {
    game.lastTouch = p;   // a hand on the ball — decides a subsequent out-of-bounds
    // 確保確率は効果層(resolution/rebound)へ分離。抽選と確保/はじきの処理はここに残す。
    const defending = p.team !== game.looseOff;
    if (chance(looseSecureChance(p, defending, game.looseTips))) {
      secureLoose(game, p);
    } else {
      // tipped: deflect the ball up and away — the trajectory genuinely changes
      game.looseTips++;
      p.touchCool = 0.22;
      const a = rand(0, Math.PI * 2);
      game.ball.vel.set(Math.cos(a) * rand(0.6, 1.9), rand(2.4, 3.8), Math.sin(a) * rand(0.6, 1.9));
      p.jump(0.4, 0.45);
      game.setEvent("TIP", p.team);
    }
  }

  // A player comes down with the loose ball and play resumes.
export function secureLoose(game: Game, p: Player, label?: string): void {
    game.lastTouch = p;
    const offensive = p.team === game.looseOff;
    if (game.looseIsRebound) p.stats.reb++;   // only count boards off a missed shot
    if (!offensive && game.looseStealBy) {    // the defence came up with a poked-loose ball
      game.looseStealBy.stats.stl++;          // steal credited to whoever knocked it free
      if (game.looseStealVictim) game.looseStealVictim.stats.tov++;
    }
    game.looseStealBy = game.looseStealVictim = null;
    game.handler = p;
    game.possession = p.team;
    game.ballMode = "held";
    // shot clock: a change of possession is a full reset; an offensive rebound OFF
    // THE RIM gets the partial reset; any other offensive recovery (a blocked shot,
    // a strip, a fumble — no rim contact) just plays ON with the clock running.
    if (!offensive) game.shotClock = SHOT_CLOCK;
    else if (game.looseFromRim) game.shotClock = Math.max(game.shotClock, SHOT_CLOCK_PARTIAL);
    p.decisionT = 0.4;
    game.ball.vel.set(0, 0, 0);
    game.resetMotion();
    if (!offensive) game.maybeStartPush();   // change of possession → run the break
    game.leakOut();          // 飛び出し runners take off on the change of possession
    // pick it up BY HAND (no hop): a short scoop where the ball rises off the floor
    // into the carry while the hands track it down→up (see the pickup branch in the
    // dribble carry). A ball still up in the air is caught, not scooped.
    if (game.ball.pos.y < 1.2) {
      p.pickupT = p.pickupDur = 0.35;
      game.ball.pos.set(p.pos.x, Math.max(0.22, game.ball.pos.y), p.pos.z);
    }
    game.setEvent(label ?? (offensive ? "OFF. REBOUND" : "REBOUND"), p.team);
  }
