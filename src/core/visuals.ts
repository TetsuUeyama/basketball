// ビジュアル同期（方式B: GameState 集約）。毎フレーム、状態から各選手メッシュの位置・
// 向き（updateFacing）とネット演出（tickSwish/swishNet）を反映する描画寄り処理。
// syncAll は全選手の visual sync を回す。状態は Game に集約し各関数は game を受け取る。
// applyModelAll/applyUniforms/syncVisuals は main.ts 向け public API として Game 残置。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, COURT, TEAM_COLORS } from "../config";
import { clamp, dist2D, dist2DTo, moveToward2D, rand } from "../util";
import { rate } from "../attributes";
import { hoopIndex } from "../court";
import { poseHands } from "./poses";
import type { Game } from "../game";

  // Kick off the net swish + rim/board flash on the rim `team` just scored on.
export function swishNet(game: Game, team: number): void {
    const i = hoopIndex(game.attackSign(team));
    game.netSwish[i] = 1.1;         // longer, so the celebration reads clearly
    game.swishTeam[i] = team;
  }

  // One frame of the net-swish + rim/backboard flash on a make (visual only;
  // skipped in the headless harness where no hoops are attached). The rim and
  // backboard flash bright in the SCORING team's colour so it's obvious who
  // scored, and the net snaps down hard and springs back.
export function tickSwish(game: Game, dt: number): void {
    if (!game.hoops) return;
    const DUR = 1.1;
    for (let i = 0; i < 2; i++) {
      if (game.netSwish[i] <= 0) continue;
      game.netSwish[i] = Math.max(0, game.netSwish[i] - dt);
      const net = game.hoops.nets[i], rim = game.hoops.rimMats[i], board = game.hoops.boardMats[i];
      const c = TEAM_COLORS[game.swishTeam[i]];
      if (game.netSwish[i] > 0) {
        const e = DUR - game.netSwish[i];                 // seconds elapsed
        const damp = Math.exp(-e * 5);                    // brightness decay
        // net snaps down hard and springs back with a decaying wobble
        const spring = Math.exp(-e * 6);
        net.scaling.y = 1 + 0.9 * spring;
        const sway = Math.sin(e * 24) * 0.25 * spring;
        net.scaling.x = 1 + sway;
        net.scaling.z = 1 - sway;
        // strong flash: rim & backboard glow the scoring team's colour, pulsing
        const pulse = damp * (0.6 + 0.4 * Math.abs(Math.sin(e * 18)));
        rim.emissiveColor.set(0.3 + c.r * 1.3 * pulse, 0.12 + c.g * 1.3 * pulse, c.b * 1.3 * pulse);
        board.emissiveColor.set(c.r * pulse, c.g * pulse, c.b * pulse);
      } else {                                          // settle back to rest
        net.scaling.set(1, 1, 1);
        rim.emissiveColor.set(0.3, 0.12, 0.0);
        board.emissiveColor.set(0, 0, 0);
      }
    }
  }

  // On-court players turn to face the play: the ball-handler and shooter square
  // up to the basket they attack, and everyone else (defenders keeping eyes on
  // the ball, off-ball attackers reading it) turns toward the ball. Eased so
  // bodies track rather than snap. Skipped during substitutions, where players
  // walk to set spots. Bench players aim their own gaze in benchIdle.
export function updateFacing(game: Game, dt: number): void {
    if (game.ballMode === "subs" || game.ballMode === "finale") return;
    const b = game.ball.pos;
    for (const p of game.players) {
      // the PASSER delivers a two-handed pass CHEST-ON: snap his upper body to the
      // receiver NOW (the pass is too quick for an eased turn), feet left where
      // they are. Done BEFORE the airborne skip so a JUMP pass out of a double-team
      // (trapKickOut leaves the floor) still turns chest-on to the receiver.
      if (game.ballMode === "pass" && p === game.passer && game.passTo) {
        if (game.noLookPass) {
          // ノールック: he does NOT square up to the target — the legs hold and only
          // a slight torso hint turns that way, so the ball whips out from the side/
          // behind without facing it (the different, no-look release motion).
          p.twistToward(game.passTo.pos.x, game.passTo.pos.z, dt, 0.4, 6);
        } else {
          p.faceChestToward(game.passTo.pos.x, game.passTo.pos.z);
        }
        continue;
      }
      // TURN-AND-PASS wind-up: the target was behind his front-to-side arc, so he
      // pivots his body toward it before the release (the ball is still in hand).
      if (game.pendingPassTo && game.pendingPassTurn && p === game.handler) {
        const t = game.pendingPassTo;
        const rt = 2.2 + (rate(p.attr.agility) * 0.6 + rate(p.attr.offense) * 0.4) * 6;
        p.faceSmooth(t.pos.x, t.pos.z, rt * dt);
        p.twistToward(t.pos.x, t.pos.z, dt, undefined, rt * 1.25);
        p.lookToward(t.pos.x, t.pos.z, dt, rt * 1.6);
        continue;
      }
      // OFF THE FLOOR he can't re-orient: a jumper (shooter, contester, tip) holds
      // whatever way he was facing at take-off until he lands — no mid-air turns.
      if (p.airborne) continue;
      // the RECEIVER squares his chest to the INCOMING ball to take it in both
      // hands — the same chest-on snap the passer makes, so a ball arriving from
      // behind turns him around (the torso covers what it can, the feet turn the
      // excess; his run to the catch point is untouched — legs keep travelling).
      // Inside ~0.5 m the bearing to the ball swings wildly frame-to-frame, so
      // hold the last orientation for the actual catch instant.
      if (game.ballMode === "pass" && p === game.passTo) {
        if (dist2D(p.pos, b) > 0.5) p.faceChestToward(b.x, b.z);
        continue;
      }
      // corralling the catch (gatherT): he TWISTS his upper body to shield the ball,
      // turning his chest away from the nearest defender (the ball rides to the far
      // hip in updateLive). Squares back up as it settles. If there's no defender to
      // shield from, just hold the catch posture.
      if (p === game.handler && p.gatherT > 0 && p.catchIntent === "shield") {
        const nd = game.nearestDefender(p);
        if (nd) {
          // PRESSURED: only the UPPER BODY turns to shield — the chest twists away
          // from the defender while the HEAD keeps facing the play (the rim), so it
          // reads as "protecting with the body", not the whole figure spinning.
          // lookToward at a fixed world point counter-rotates the head vs the chest.
          const shieldX = p.pos.x + (p.pos.x - nd.pos.x), shieldZ = p.pos.z + (p.pos.z - nd.pos.z);
          const rt = 2.2 + (rate(p.attr.agility) * 0.6 + rate(p.attr.offense) * 0.4) * 6;
          p.twistToward(shieldX, shieldZ, dt, undefined, rt * 1.25);   // chest shields
          const rim = game.attackFloor(p.team);
          p.lookToward(rim.x, rim.z, dt, rt);                          // face stays on the play
        }
        continue;
      }
      // an OPEN catch (shoot / drive intent) squares up to the basket instead of
      // holding the passer-facing catch posture — it falls through to the normal
      // handler aim (attackFloor) below, ready to rise or go.
      // KEEP-DRIBBLE SHIELD: a marked poor handler turns SIDE-ON to wall the ball
      // off — chest perpendicular to the defender, angled to the rim side, so his
      // body sits between the man and the ball (carried on the far hip). His head
      // still tracks the floor/rim so he can find the help pass.
      if (p === game.handler && p.keepShieldT > 0) {
        const od = game.onBallDefender(p);
        if (od) {
          const rimF = game.attackFloor(p.team);
          const dx = od.pos.x - p.pos.x, dz = od.pos.z - p.pos.z;   // toward the defender
          let px = -dz, pz = dx;                                    // perpendicular (side-on)
          if (px * (rimF.x - p.pos.x) + pz * (rimF.z - p.pos.z) < 0) { px = dz; pz = -dx; } // pick the rim side
          const sx = p.pos.x + px, sz = p.pos.z + pz;
          const shieldRate = 2.2 + rate(p.attr.agility) * 5;
          p.faceSmooth(sx, sz, shieldRate * dt);                    // legs/hips turn side-on
          p.twistToward(sx, sz, dt, undefined, shieldRate * 1.2);   // chest walls the ball off
          p.lookToward(rimF.x, rimF.z, dt, shieldRate * 1.6);       // eyes up on the floor/rim
          continue;
        }
      }
      const aim = (p === game.handler || p === game.shooter) ? game.attackFloor(p.team) : b;
      // Lower body: while running, the legs face the direction of TRAVEL and the
      // torso twists toward the play (twistToward) — receiving on the move,
      // shadowing a driver in stride. EXCEPT when moving away from the aim
      // (a backpedal): then the legs hold their square-up so the player retreats
      // chest-on (which is also what triggers the backpedal arm pose). Standing
      // still, the whole body squares to the aim and the twist unwinds.
      let lx = aim.x, lz = aim.z;
      const spd = Math.hypot(p.velX, p.velZ);
      // a FINISHER in his gather squares his legs to the rim (aim = the hoop) so
      // the dunk/layup faces the basket instead of taking off angled — which is
      // what read as a frequent "back dunk" (the body wasn't turned to the rim).
      const finishing = p === game.shooter && game.shooterFinishing
        && dist2DTo(p.pos, aim.x, aim.z) < 3.2;
      if (spd > 1.5 && !finishing) {
        const ax = aim.x - p.pos.x, az = aim.z - p.pos.z;
        const al = Math.hypot(ax, az);
        // Moving toward the aim → legs face travel. Moving AWAY (a retreat) a
        // slow contain-shuffle stays chest-on (keep facing the aim, backpedal) —
        // BUT a committed SPRINT away (chasing a loose ball, or a beaten defender
        // sprinting back to recover) turns and RUNS: face the travel direction so
        // he doesn't moon-walk. faceSmooth eases it, so the turn is gradual.
        const committed = spd > p.runSpeed * 0.72;
        if (al > 0.05 && ((p.velX * ax + p.velZ * az) / (spd * al) > -0.26 || committed)) {
          lx = p.pos.x + p.velX;
          lz = p.pos.z + p.velZ;
        }
      }
      // How fast he can WHIP his body around to a new direction — no instant
      // spins. Driven by クイックネス(敏捷性) plus his role skill: a DEFENDER turns
      // on 敏捷性 + ディフェンス (staying with his man), an attacker on オフェンス +
      // 敏捷性. Low ratings turn slowly (a beat to change direction), elite ones
      // snap around — but never instantly.
      const offense = p.team === game.possession;
      const quick = rate(p.attr.agility);
      const skill = offense ? rate(p.attr.offense) : rate(p.attr.defense);
      const turnRate = 2.2 + (quick * 0.6 + skill * 0.4) * 6;   // ~2.2 (slow) .. ~8.2 (quick) rad/s
      p.faceSmooth(lx, lz, turnRate * dt);                       // lower body (legs/hips)
      p.twistToward(aim.x, aim.z, dt, undefined, turnRate * 1.25); // upper body (chest), a touch quicker
      // the HEAD tracks the thing worth watching (the ball, or the rim he attacks)
      // ON TOP of the chest — so he never runs/turns without his face on the play
      p.lookToward(aim.x, aim.z, dt, turnRate * 1.6);
    }
  }

export function syncAll(game: Game, ): void {
    for (const p of game.players) p.sync();
    game.ball.sync();
    poseHands(game);
    if (game.handler && game.ballMode === "held") {
      game.ring.isVisible = true;
      game.ring.position.set(game.handler.pos.x, 0.03, game.handler.pos.z);
    } else {
      game.ring.isVisible = false;
    }
  }
