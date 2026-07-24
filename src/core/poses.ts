// ポーズ／腕・手のアニメーション（方式B: GameState 集約）。毎フレームの手・腕の
// ターゲット姿勢（オンボール保持/ディナイ/コンテスト挙上/勝利セレブレーション）を
// 決める描画寄りの処理。状態は Game に集約し各関数は第一引数 game を受け取る。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, COURT, TEAM_COLORS, MAX_PASS } from "../config";
import { clamp, dist2D, dist2DTo, rand, chance } from "../util";
import { rate } from "../attributes";
import type { Game } from "../game";

  // Put a hand on the ball for whoever is touching it, so the ball is dribbled /
  // passed / shot / tipped from a palm rather than floating. Everyone else rests
  // their arms at their sides.
export function poseHands(game: Game, ): void {
    if (game.ballMode === "finale") return;   // updateFinale owns every pose
    const b = game.ball.pos;
    // Defensive stances are RATE-LIMITED — they slew toward the target pose rather
    // than snapping — so runArms must not stomp those arms first. Work out who is
    // holding a defensive stance this frame, apply it, and skip their runArms.
    const posed = new Set<Player>();
    if (game.ballMode === "held" && game.handler) {
      poseOnBallHands(game, game.handler, b, posed);   // what the on-ball defender answers
      poseDenyHands(game, game.handler, b, posed);       // off-ball defenders denying the pass
      posed.add(game.handler);   // his dribble hand slews too (below) — don't stomp it
      // まだ収まっていない: while the receiver is corralling a bobbled catch, the man
      // on him DIGS at the loose ball — both arms reaching low for the exposed
      // ball, so the steal attempt is visible (catchStrips does the step + poke).
      if (game.handler.gatherT > 0) {
        const d = game.onBallDefender(game.handler);
        if (d && !d.airborne && dist2D(d.pos, game.handler.pos) < 2.0) {
          d.reach(new Vector3(b.x, b.y, b.z), true);
          posed.add(d);
        }
      }
      // press trap: the second man doesn't body in — he stands off and DIGS at
      // the ball, both hands hunting it, so the trap reads as a steal attempt
      const pt = game.pressTrapper;
      if (pt && !pt.airborne && dist2D(pt.pos, game.handler.pos) < 1.8) {
        pt.reach(new Vector3(b.x, b.y, b.z), true);
        posed.add(pt);
      }
    } else if (game.ballMode === "charge" && game.shooter) {
      const cd = game.onBallDefender(game.shooter);     // a grounded contest goes STRAIGHT UP
      if (cd && !cd.airborne && dist2D(cd.pos, game.shooter.pos) < 2.2) {
        cd.handsUp(defArmRate(game, cd)); posed.add(cd);
      }
    }
    // a shooter frozen in his follow-through owns his own arms (held below) — even
    // grounded (a set jumper that doesn't leave the floor) — so don't let runArms
    // pump them back down during his cooldown
    if (game.shooter && game.shooter.coolT > 0 && game.shooter !== game.handler) {
      posed.add(game.shooter);
    }
    for (const p of game.players) if (!posed.has(p)) p.runArms();   // run swing / rest
    switch (game.ballMode) {
      case "held": {
        if (game.handler) {
          if (game.pendingPassTo) {
            // ジャンプパスのウィンドアップ: 両手でボールを頭上に掲げている
            game.handler.holdBallHands(b);
          } else if (game.handler.gatherT > 0) {
            // まだ収まっていない: the two-handed CATCH pose carries straight on —
            // the ball sits BETWEEN the palms (one hand each side) and the whole
            // hold shakes as one until it settles; then he drops into the dribble
            game.handler.holdBallHands(b);
          } else {
            // hand hovers at dribble height while the ball bounces below it —
            // dribbled with the hand on the SAME side the ball is carried (a hip
            // carry uses the near hand, not the far arm reaching across the body)
            const bw = new Vector3(b.x, 0.95, b.z);
            game.handler.reachDribble(bw, game.handler.dribbleWithRight(bw), dribArmRate(game, game.handler));
          }
        }
        break;
      }
      case "charge":
        game.shooter?.reach(b, true);                // ball loaded in the shot pocket
        raiseAirborne(game, b, game.shooter);         // a defender who left early is already up
        break;
      case "inbound":
        game.handler?.reach(b);                      // holds the ball to throw it in
        break;
      case "shot":
        // a FINISHER keeps his hand ON the ball all the way to the rim (a dunk/layup
        // is arm-driven); a jumper only holds the release for the first beat, then
        // follows through.
        if (game.shooter && (game.shooterFinishing || game.shotT < game.shotDur * 0.45)) {
          game.shooter.reach(b, true);
        }
        raiseAirborne(game, b, game.shooter);         // contesting defenders go up
        break;
      case "freethrow":
        if (game.ft.t < 1.4) game.ft.shooter?.reach(b, true);
        break;
      case "pass":
        // two-handed CHEST pass: both arms shove FORWARD at chest height toward the
        // receiver — NOT up after the arcing ball (which read as an overhead throw)
        if (game.passT < game.passDur * 0.4 && game.passer && game.passTo) {
          const pr = game.passer.pos, tp = game.passTo.pos;
          const dx = tp.x - pr.x, dz = tp.z - pr.z, dl = Math.hypot(dx, dz) || 1;
          game.passer.reach(new Vector3(pr.x + (dx / dl) * 1.2, 1.3, pr.z + (dz / dl) * 1.2), true);
        } else if (game.passT > game.passDur * 0.45) {
          // CATCH: the receiver puts BOTH hands out to meet the incoming ball
          // (his chest is already squared to it — updateFacing turns him), one
          // palm to each side of it, ready to take it BETWEEN the hands
          game.passTo?.holdBallHands(b);
        }
        if (game.passSteal) game.passSteal.def.reach(b);                   // jumping the lane
        break;
      case "loose":
        // everyone going up for the board reaches for it — EXCEPT a shooter still
        // in his follow-through, who must not snap his arms toward a blocked ball
        // (that read as "he threw it there"); he holds his release form below.
        raiseAirborne(game, b, game.shooter && game.shooter.coolT > 0 ? game.shooter : null);
        // GROUND SCRAMBLE for a poked-loose ball: the man who knocked it free keeps
        // a hand STABBING at it (a visible dig, not a teleport-grab), and the man
        // who lost it reaches to snatch it back — so a steal reads as a fight for
        // a live loose ball rather than the ball just changing hands.
        {
          const lb = new Vector3(b.x, Math.max(0.35, b.y), b.z);
          const digger = game.looseStealBy, loser = game.looseStealVictim;
          // the thief LUNGES: one hand out, upper body rotated, arm extended far
          if (digger && !digger.airborne && dist2D(digger.pos, b) < 2.4) digger.digReach(lb);
          // the man who lost it reaches back one-handed to recover
          if (loser && loser !== digger && !loser.airborne && dist2D(loser.pos, b) < 2.2) loser.reach(lb);
        }
        break;
      case "tipoff":
        game.teamPlayers(0)[4].reach(b, true);       // both centres tip with both hands
        game.teamPlayers(1)[4].reach(b, true);
        break;
      // "pause": nobody is holding the ball — arms stay at rest
    }

    // A body in the air with no ball-handling job IS a block/contest jump —
    // both hands go STRAIGHT UP (the early-contest gamble and the rim
    // protector's timed leap happen while the ball is still "held", where no
    // case above raises the arms). Rebound scrambles (loose) and the tip-off
    // keep reaching for the ball itself instead.
    if (game.ballMode !== "loose" && game.ballMode !== "tipoff") {
      for (const p of game.players) {
        if (!p.airborne || p === game.shooter || p === game.handler) continue;
        if (p === game.passer) continue;   // a jump PASSER keeps his chest-pass arms, not hands-up
        if (p.foulReactT > 0) continue;    // the AND-1 flex hop keeps its fists up
        p.reach(new Vector3(p.pos.x, 6, p.pos.z), true);   // dead-vertical target
      }
    }

    // FROZEN FOLLOW-THROUGH: a shooter holds his release form — arms up toward the
    // basket he shot at — for his whole cooldown (coolT), whether he left the floor
    // or not. So a set jumper keeps the pose after the ball leaves, and a
    // blocked/missed shot never snaps his arms toward the ball as if he threw it
    // there. Exceptions: the "charge" gather owns his pose (ball loaded overhead),
    // and the very start of the "shot" flight is the live release motion (the shot
    // case reaches with the ball); after that we freeze the form.
    const sh = game.shooter;
    const releasing = game.ballMode === "shot" && game.shotT < game.shotDur * 0.45;
    if (sh && sh.coolT > 0 && game.ballMode !== "charge" && !releasing
        && sh !== game.handler && sh.foulReactT <= 0) {
      const rim = game.attackFloor(sh.team);
      sh.reach(new Vector3(rim.x, 3.2, rim.z), true);
    }

    // foul reactions play out last so they own the arms over any rest pose
    for (const p of game.players) p.poseFoulReaction();

    // defensive-success celebrations play out LAST of all — but only for a player
    // who has NO active ball job this frame (not handling / shooting / passing,
    // not still airborne on the swat, and not scrambling a loose ball). So a
    // blocker's fist-pump waits until he lands, and a stealer only pumps if he
    // didn't immediately grab the ball and push it (in which case dribbling owns
    // his arms — realistic). A foul reaction, if any, has already won the arms.
    const scrambling = game.ballMode === "loose" || game.ballMode === "tipoff";
    for (const p of game.players) {
      if (p.defWinT <= 0 || p.foulReactT > 0) continue;
      if (p === game.handler || p === game.shooter || p === game.passer) continue;
      if (p.airborne || scrambling) continue;
      p.poseDefWin();
    }
  }

  // Players in the air (contesting a shot or crashing the glass) raise both hands
  // up toward the ball to grab, tip, or block it.
export function raiseAirborne(game: Game, b: Vector3, except: Player | null): void {
    for (const p of game.players) {
      if (p !== except && p.airborne) p.reach(b, true);
    }
  }

  // The on-ball defender's hands say what he is answering. Straight blow-by (or a
  // handler driving at the rim) → a front hand cuts off the lane and stabs at the
  // ball. Working it side to side → arms spread wide to wall both directions. A
  // held, stationary ball with the defender right on top → the same front-hand
  // poke. Otherwise he keeps his hands active and wide.
  // How fast a defender can re-orient his hands, in rad/s — a weak defender switches
  // his stance slowly (so he's a beat late), an elite one snaps to it.
  // How fast a DEFENDER re-places his hands — gated by 守備 (defence): a low-defence
  // player's arms move slowly/deliberately, an elite one's are quick. Never a snap
  // (setArmDir eases toward the target at this rate), so hands don't teleport.
export function defArmRate(game: Game, d: Player): number {
    return 0.8 + rate(d.attr.defense) * 4.0;   // ~0.8 (slow, deliberate) .. ~4.8 (crisp)
  }

  // How fast the ball-handler's dribbling hand re-places itself — tied to his
  // dribble accuracy (D精度, the offensive ball-handling skill): a loose handler's
  // hand lags, a tight one's is quick.
export function dribArmRate(game: Game, h: Player): number {
    return 0.8 + rate(h.attr.dribbleAcc) * 4.0;
  }

export function poseOnBallHands(game: Game, h: Player, b: Vector3, posed: Set<Player>): void {
    const d = game.onBallDefender(h);
    if (!d || d.airborne) return;
    const r = defArmRate(game, d);
    // aim the front hand at a STEADY point — the handler's BODY at chest height,
    // not the dribbled ball (whose x/z jitter with every bounce/crossover made the
    // hand bob). Nudged a touch toward the ball side so it still reads as on-ball.
    const bt = new Vector3(h.pos.x * 0.75 + b.x * 0.25, 1.0, h.pos.z * 0.75 + b.z * 0.25);
    const useRight = d.dribbleWithRight(bt);         // the hand nearer the ball leads
    const rim = game.attackFloor(h.team);            // the basket he is attacking
    const spd = Math.hypot(h.velX, h.velZ);
    const toRimX = rim.x - h.pos.x, toRimZ = rim.z - h.pos.z;
    const rl = Math.hypot(toRimX, toRimZ) || 1;
    const straight = spd > 1.2 && (h.velX * toRimX + h.velZ * toRimZ) / (spd * rl) > 0.5;
    const close = dist2D(d.pos, h.pos) < 0.9;
    // a straight/blown-by drive, or bodied right up, is a DRIVE-GUARD (front hand
    // down). Otherwise it's a stance choice made with HYSTERESIS: go wide only when
    // the handler is CLEARLY moving (spd>1.5), drop back to the guard only when he
    // is CLEARLY slow (spd<0.9) — so a speed hovering at the old 1.2 line no longer
    // flips the pose (and the hands) frame to frame.
    if (h.beatenT > 0 || straight) {
      d.guardDrive(bt, useRight, r);                 // cut off penetration
    } else {
      if (d.stanceWide) { if (spd < 0.9 || close) d.stanceWide = false; }
      else { if (spd > 1.5 && !close) d.stanceWide = true; }
      if (d.stanceWide) d.armsWide(r);               // shut the side lanes
      else d.guardDrive(bt, useRight, r);            // sit down & poke the held ball
    }
    posed.add(d);
  }

  // Off-ball defenders one pass away and ball-side FRONT their man — a diagonal
  // hand in the lane so the ball can't be threaded behind them (a swing back out
  // is conceded). A defender sagging as help (goal-side of his man) keeps his
  // arms down; the on-ball defender is left to poseOnBallHands.
export function poseDenyHands(game: Game, h: Player, b: Vector3, posed: Set<Player>): void {
    for (const o of game.teamPlayers(h.team)) {
      if (o === h) continue;                          // he has the ball, not a receiver
      if (dist2D(o.pos, b) > MAX_PASS) continue;      // out of any passing range
      const d = game.onBallDefender(o);               // the man guarding this receiver
      if (!d || d.airborne) continue;
      if (dist2D(d.pos, b) < dist2D(o.pos, b)) {      // ball-side / fronting → deny
        d.denyLane(d.dribbleWithRight(b), defArmRate(game, d));
        posed.add(d);
      }
    }
  }

  // Hands-up bounces for a celebrating body (amp 1 = full mob, ~0.4 = polite).
export function festivePose(game: Game, p: Player, dt: number, amp: number): void {
    p.reach(new Vector3(p.pos.x, 2.7 + amp * 0.5, p.pos.z), true);   // both arms up
    if (!p.airborne && p.landT <= 0 && chance(dt * (1.2 + amp * 1.3))) {
      p.jump(0.1 + amp * rand(0.15, 0.3), rand(0.3, 0.45));
    }
  }
