// ボール保持(ballMode "held")中のライブプレイ tick。ドリブルのケイデンス前進、
// オフェンス/守備/はたきの毎フレーム進行、そしてキャリー/ギャザー/ピックアップの
// ボール位置決め。方式A: game を第一引数に取る関数。game.ts の更新ループ switch の
// "held" ケースから呼ぶ。game.ts から分離（workPlan.md Phase4 / [[game-split-optionb]]）。
import { rate } from "../attributes";
import { clamp, dist2D, chance } from "../util";
import { runOffense } from "./offense";
import { runDefense, catchStrips, swarmStrips } from "./defense";
import { passToReceiver } from "./passing";
import type { Game } from "../game";

export function updateLive(game: Game, dt: number): void {
  const h = game.handler!;
  // ジャンプパスのウィンドアップ中: 跳び上がってボールを頭上に掲げ、最高点
  // 付近でリリース。コミット済みなので判断もドライブもしない。
  if (game.pendingPassTo) {
    game.pendingPassT -= dt;
    // TURN-and-pass: ball stays down in the hands while he pivots his body to the
    // target (updateFacing rotates him). A JUMP pass lifts it overhead instead.
    if (game.pendingPassTurn) game.ball.pos.set(h.pos.x + h.carryX, 1.0, h.pos.z + h.carryZ);
    else game.ball.pos.set(h.pos.x, 2.0, h.pos.z);
    if (game.pendingPassT <= 0) {
      const target = game.pendingPassTo;
      const turn = game.pendingPassTurn;
      game.pendingPassTo = null;
      game.pendingPassTurn = false;
      if (turn) {
        // finished the pivot → release as a NORMAL pass (not forced) so the lane/
        // risk safety gate still runs: if a defender rotated INTO the lane during
        // the turn, the throw is vetoed (he holds) instead of fired into him. Only
        // the arc check is skipped (he has already faced up).
        game.turnReleased = true;
        passToReceiver(game, h, target, false, "chest");
        game.turnReleased = false;
      } else {
        passToReceiver(game, h, target, true, "jump");   // committed kick-out over a trap
      }
    }
    runDefense(game, dt);
    return;
  }
  if (game.pushT > 0) game.pushT = Math.max(0, game.pushT - dt);
  // advance the dribble cadence FIRST so ball-in-hand gating is current this
  // frame: D精度 sets the pound rate (a poor handler dribbles slowly, the ball
  // away from his hand longer)
  h.dribblePhase += dt * (1.6 + rate(h.attr.dribbleAcc) * 1.4);   // 1.6 .. 3.0 Hz
  // ball clearly past halfway → frontcourt established for this possession
  if (!game.frontT && game.attackSign(h.team) * h.pos.z > 0.6) game.frontT = true;
  runOffense(game, dt, h);
  runDefense(game, dt);
  catchStrips(game, dt);
  if (game.ballMode !== "held") return;   // knocked loose out of a bobbled catch
  swarmStrips(game, dt);
  if (game.ballMode !== "held") return;   // a strip this frame ended the dribble
  // --- dribble CARRY position: where the live ball sits around the handler.
  // Out FRONT (toward the rim) he can push it and run — but it's exposed to
  // the man guarding him. Squared up against a defender it tucks to the hip
  // on the FAR side. How fast it relocates between spots is D精度; during a
  // bait (baitT) it's deliberately shown out front to invite the reach-in.
  const rim = game.attackFloor(h.team);
  const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len;
  let tx = fx * 0.5, tz = fz * 0.5;                    // default: front carry
  const od = game.onBallDefender(h);
  const dOn = od ? dist2D(od.pos, h.pos) : 99;
  if (h.baitT > 0) {
    tx = fx * 0.6; tz = fz * 0.6;                      // the shown ball
  } else if (od && dOn < 1.7) {
    // squared up / shielding: tuck the ball to the FAR HIP relative to his own
    // (twisted) UPPER BODY — a spot his HANDS actually reach. The old code placed
    // it RIM-relative, ignoring his facing, so once he twisted to shield, the ball
    // ended up straight behind his back where no palm could reach. Now it rides in
    // FRONT of the twisted chest, shifted to the hip away from the defender.
    const cf = h.chestFront(1);                                   // chest forward (twist-aware), unit
    let cx = cf.x - h.pos.x, cz = cf.z - h.pos.z;
    const cl = Math.hypot(cx, cz) || 1; cx /= cl; cz /= cl;
    let lx = -cz, lz = cx;                                        // chest lateral axis
    const side = ((od.pos.x - h.pos.x) * lx + (od.pos.z - h.pos.z) * lz) > 0 ? -1 : 1;  // far hip
    tx = cx * 0.12 + lx * side * 0.30;                            // in front of the chest + onto the far hip
    tz = cz * 0.12 + lz * side * 0.30;
  }
  // 持ち替え/クロスオーバーの速さは D精度 依存。下手ほどモッサリ、上手いほど素早い
  // (~0.9 m の左右持ち替えで下手≈1.8s / 上手≈0.45s)。全体に遅めで、持ち替えに
  // ちゃんと「時間がかかる」よう調整した。
  const cs = (0.5 + rate(h.attr.dribbleAcc) * 1.5) * dt;   // 0.5 .. 2.0 m/s
  h.carryX += clamp(tx - h.carryX, -cs, cs);
  h.carryZ += clamp(tz - h.carryZ, -cs, cs);
  // スティール誘い: walled off with the defender tight, a skilled handler
  // flashes the ball to bait the poke he is ready to yank away from
  if (h.baitT <= 0 && od && dOn < 1.3 && h.beatenT <= 0 && h.powerT <= 0
      && h.jukeT <= 0 && chance(dt * (0.1 + rate(h.attr.handling) * 0.45))) {
    h.baitT = 0.5;
  }
  // PICKUP scoop: fresh off securing a loose ball the hand reaches DOWN and lifts
  // it off the floor into the carry (no hop). Ball eases from ankle height up to
  // the pocket over pickupT; the hands track it (holdBallHands) so it reads as a
  // clean hand pickup. Overrides the dribble bounce for the brief scoop window.
  if (h.pickupT > 0) {
    const prog = h.pickupDur > 0 ? clamp(1 - h.pickupT / h.pickupDur, 0, 1) : 1;
    const scoop = h.chestFront(0.24);
    const py = 0.22 + (0.95 - 0.22) * prog;                    // floor → carry height
    game.ball.pos.set(
      h.pos.x + (scoop.x - h.pos.x) * prog,
      py,
      h.pos.z + (scoop.z - h.pos.z) * prog,
    );
  } else {
    // the carried ball bounces between hand height and the floor (dam-dam)
    const bounce = Math.abs(Math.cos(Math.PI * h.dribblePhase)); // 1 = at the hand, 0 = floor
    const y = 0.18 + (1.0 - 0.18) * bounce;
    game.ball.pos.set(h.pos.x + h.carryX, y, h.pos.z + h.carryZ);
  }
  // まだ収まっていない: fresh off an off-target catch the ball is NOT secured —
  // it stays where the two-handed catch met it, OUT IN FRONT OF THE CHEST,
  // held BETWEEN both palms. The shake is a SMOOTH low-frequency sway (phased
  // off the draining gatherT, no per-frame noise): the hands are aimed at the
  // same swaying point (holdBallHands in poseHands), so ball and arms move as
  // ONE unit — the tremble reads in the upper arms, not as the ball rattling
  // loose between static palms. Decays as the 硬直 drains, then the normal
  // one-hand carry takes over.
  if (h.gatherT > 0) {
    const amp = Math.min(0.03, h.gatherT * 0.06);   // a small tremble, not a big wobble
    const ph = h.gatherT * 16 + h.idx;              // smooth sweep as gatherT drains
    const prog = h.gatherDur > 0 ? clamp(1 - h.gatherT / h.gatherDur, 0, 1) : 1;
    const c = h.chestFront(0.30);
    let tx = c.x, tz = c.z, ty = 1.0;
    const rimF = game.attackFloor(h.team);
    if (h.catchIntent === "shield") {
      // PRESSURED: the ball tucks to the FAR HIP — but a hip his HAND can actually
      // reach. The chest is twisting away from the defender (updateFacing), so we
      // place the ball just IN FRONT of that twisted chest and nudge it to the far
      // side; it ends up shielded behind the turned upper body WITHOUT ever landing
      // straight behind his back (the old world-space "away from the defender"
      // offset put it where no palm could reach when the man was dead in front).
      const front = h.chestFront(0.18);            // in front of the twisted-away chest
      let hx = front.x, hz = front.z;
      const nd = game.nearestDefender(h);
      if (nd) {
        const f = h.chestFront(1);                 // chest forward (unit)
        let fx = f.x - h.pos.x, fz = f.z - h.pos.z;
        const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
        let lx = -fz, lz = fx;                     // lateral (perpendicular) axis
        const ax = h.pos.x - nd.pos.x, az = h.pos.z - nd.pos.z;   // away from the defender
        if (lx * ax + lz * az < 0) { lx = -lx; lz = -lz; }        // pick the far-hip side
        hx += lx * 0.16; hz += lz * 0.16;          // shift onto the far hip (still within reach)
      }
      tx = c.x + (hx - c.x) * prog;                // settle from the catch spot to the far hip
      tz = c.z + (hz - c.z) * prog;
      ty = 1.0 - prog * 0.08;                      // dip a touch to a protected carry
    } else if (h.catchIntent === "shoot") {
      // CATCH-AND-SHOOT: bring it up in front of the chest into the shot pocket,
      // rising into his form as the catch settles.
      const sp = h.chestFront(0.26);
      tx = sp.x; tz = sp.z;
      ty = 1.0 + prog * 0.35;                       // raise into the pocket
    } else {
      // OPEN: carry it out toward his next move — led a step toward the rim (the
      // drive direction), ready to go, rather than tucked.
      const dx = rimF.x - h.pos.x, dz = rimF.z - h.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      tx = c.x + (dx / dl) * 0.14 * prog;
      tz = c.z + (dz / dl) * 0.14 * prog;
    }
    game.ball.pos.set(
      tx + Math.sin(ph) * amp,
      ty + Math.sin(ph * 1.7 + 0.9) * amp * 0.45,   // chest height, gentle vertical bob
      tz + Math.sin(ph * 1.35 + 2.1) * amp,
    );
  }
}
