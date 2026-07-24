// シュート機構（方式B: GameState 集約）。ジャンプショットのため/放ち/飛翔/着弾判定、
// リムフィニッシュ、コンテスト/ブロック、シューティングファウル、アシスト評価までを
// 関数として集約。状態は Game に集約し各関数は第一引数 game を受け取る。
// contestLeap は defense からも使うため Game 残置（game.contestLeap 経由）。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, COURT, THREE_DIST, SHOT_CLOCK, SHOT_CLOCK_PARTIAL, PALM_HITBOX, TEAM_COLORS, SHOT_SET_Y, SHOT_GATHER_Y } from "../config";
import { clamp, dist2D, dist2DTo, moveToward2D, chance, rand } from "../util";
import { palmRadius, twWeight, reactionLag, gatherFor, effShootRange, shotWindupFor,
  stripEdge, deepThreeOK } from "../eval";
import { TACTICS, rate } from "../attributes";
import { jumpShotMakeProbability, rimFinishOutcome } from "../resolution/shot-outcome";
import { bestBlocker, evadeBlockProbability } from "../resolution/contest-block";
import { shootingFoulChance } from "../resolution/foul";
import { looseSecureChance } from "../resolution/rebound";
import { endQuarter } from "./gameflow";
import { swishNet } from "./visuals";
import { benchCheer } from "./bench";
import type { Game } from "../game";

export function shoot(game: Game, h: Player, dHoop: number, dDef: number): void {
    // BUZZER BEATER: no time to gather — he just flings it up as the horn sounds.
    // It's a pure accuracy trade-off (releaseShot already floors the make%), so
    // there's no charge phase and no wind-up (the ball goes NOW).
    if (game.gameClock > 0 && game.gameClock < 0.9) {
      game.shotWindup = 0;
      releaseShot(game, h, dHoop, dDef);
      return;
    }
    const windup = shotWindupFor(h, dHoop);
    game.shotWindup = windup;
    game.chargeShooter = h;
    game.chargeDHoop = dHoop;
    game.chargeDDef = dDef;
    game.chargeT = windup;
    game.shooter = h;              // pose owner during the gather
    game.handler = null;
    game.ballMode = "charge";
    // the ball STARTS at the gather pocket (chest) and is lifted over the head
    // across the wind-up (see chargeBallY) — the jump-shot pocket he releases from
    game.ball.pos.set(h.pos.x, chargeBallY(game), h.pos.z);
  }

  // The ball climbs from the pocket to overhead across the wind-up so the load
  // reads as a motion, not a frozen pose: overhead by ~80% of the gather, then
  // held there for the release window. Eased (smoothstep) for an unhurried lift.
export function chargeBallY(game: Game, ): number {
    const w = game.shotWindup || 0.001;
    const p = clamp(1 - game.chargeT / w, 0, 1);   // 0 at gather start → 1 at release
    const rise = clamp(p / 0.8, 0, 1);
    const e = rise * rise * (3 - 2 * rise);
    return SHOT_GATHER_Y + (SHOT_SET_Y - SHOT_GATHER_Y) * e;
  }

  // One frame of the gather: hold the ball loaded, and let the on-ball defender
  // READ the shot and CLOSE OUT / leave his feet to contest. A defender who was
  // caught leaning on the drive (beaten / recovering) can't get there — that's
  // how over-playing the dribble gives up a clean look.
export function updateCharge(game: Game, dt: number): void {
    const h = game.chargeShooter;
    if (!h) { game.ballMode = "held"; return; }
    game.chargeT -= dt;
    game.ball.pos.set(h.pos.x, chargeBallY(game), h.pos.z);   // lifted from the pocket over the head
    const d = game.teamPlayers(1 - h.team)[h.slot];   // the man guarding the shooter
    const beaten = h.beatenT > 0 || h.powerT > 0;     // he blew by → the closeout is late
    if (d && !beaten) {
      const gap = dist2D(d.pos, h.pos);
      if (!d.airborne && d.landT <= 0) {
        // hard closeout toward the shooter
        if (gap > 0.75) {
          const clo = d.accelToward(dt, h.pos.x, h.pos.z, 1.15) * dt;
          moveToward2D(d.pos, h.pos.x, h.pos.z, clo);
          game.clampCourt(d.pos);
        }
        // as the release nears, a defender who's close and read it LEAVES HIS FEET
        // to challenge — 反応/守判断 time it, ジャンプ gives the length to reach it
        if (game.chargeT < 0.13 && gap < 1.7) {
          const read = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.5;
          if (chance((0.25 + read * 1.5) * dt * 9)) game.contestLeap(d, h.pos, 0.5 + rate(d.attr.jump) * 0.35, 0.6);
        }
      }
      // STRIP ON THE GATHER: while the ball is loaded OVERHEAD, a defender in his
      // airspace swipes at it — per frame, so a LONGER gather (a deep / slow load)
      // is far more likely to be knocked loose BEFORE the release. He has to reach
      // the high ball (airborne helps a lot); a taller shooter holds it away.
      if (gap < 1.2) {
        const poke = rate(d.attr.reaction) * 0.4 + rate(d.attr.agility) * 0.35
          + rate(d.attr.defense) * 0.25 + (d.has("interceptor") ? 0.12 : 0);
        const secure = rate(h.attr.handling) * 0.5 + clamp((h.height - d.height) * 0.6, -0.15, 0.35);
        const reach = d.airborne ? 1.3 : 0.5;   // the ball is overhead — he must get up to it
        if (chance(Math.max(0, poke - secure) * reach * dt * 5)) { stripGather(game, h, d); return; }
      }
    }
    if (game.chargeT <= 0) releaseShot(game, h, game.chargeDHoop, game.chargeDDef);
  }

  // The loaded (overhead) ball is knocked out of the shooter's hands before the
  // release — a live loose ball, sprayed toward the defender who tipped it.
export function stripGather(game: Game, h: Player, d: Player): void {
    game.chargeShooter = null;
    d.stats.stl++;
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.6 - rate(h.attr.handling) * 0.3, 0.05, 0.9);
    const power = rand(2.8, 4.8);   // knocked well clear so the loose ball is a real scramble
    game.ball.pos.set(h.pos.x, SHOT_SET_Y, h.pos.z);
    game.ball.vel.set((ax / len) * power * grip + rand(-1, 1) * (1 - grip), rand(-0.4, 0.9),
                      (az / len) * power * grip + rand(-1, 1) * (1 - grip));
    game.setEvent("STRIP!", d.team);
    game.lastTouch = d;   // the stripper last touched it
    h.touchCool = 0.4;
    game.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.35 });
  }

export function releaseShot(game: Game, h: Player, dHoop: number, dDef: number): void {
    game.chargeShooter = null;
    game.pendingAssist = assistCreditFor(game, h);
    const isThree = dHoop > THREE_DIST;
    game.shotPoints = isThree ? 3 : 2;
    game.shotWasDunk = false;   // jump shot, not a dunk

    // make% は効果層(resolution/shot-outcome)へ分離。ここでは文脈(最寄り守備者・
    // ヘルプ人数・クラッチ・ブザー・手のひら判定)を渡して確率だけ受け取り、抽選する。
    const p = jumpShotMakeProbability(h, dHoop, dDef, {
      nearestDef: game.nearestDefender(h),
      helpCount: game.defendersWithin(h, 2.4),
      clutch: game.clutchFactor(h),
      buzzer: game.gameClock > 0 && game.gameClock < 1.0,
      palmHitbox: PALM_HITBOX,
    });
    game.shotMade = chance(p);

    game.shooter = h;   // own the shot NOW so a block freezes HIS follow-through
    game.lastTouch = h;   // the shooter last touched it (an airball out → other team's ball)
    // ミドル/ゴール下のジャンプシュートも、レイアップ/ダンク同様に S技術 で
    // ブロックをかわして打てる（3Pは対象外）。
    const blocker = tryBlock(game, h, false, !isThree);
    if (blocker) { swatShot(game, h, blocker); return; }
    if (tryShootingFoul(game, h, dDef, false)) return;

    game.shotFrom.set(h.pos.x, 2.05, h.pos.z);
    aimShotTarget(game, dHoop);   // rim on a make; a big off-target point on a long miss
    game.shotT = 0;
    // Beyond the arc the ball is HEAVED, not flicked: the farther out, the
    // higher and slower the rainbow (a buzzer bomb hangs in the air long enough
    // to follow). Inside the arc nothing changes (far = 0 → the old 0.85/2.2).
    const far = Math.min(12, Math.max(0, dHoop - THREE_DIST));
    game.shotDur = 0.85 + far * 0.11;
    // 弾道高さ: the jumper's arc rises with the rating (≈1.6 low .. 2.8 high,
    // centred on the old 2.2), plus the deep-heave lift. A higher arc reads as a
    // rainbow and is harder to block (tryBlock reads the same rating).
    game.shotApex = (1.6 + rate(h.attr.bank) * 1.2) + far * 0.45;
    game.longShot = far > 0.5;   // deep enough that the ball cam should chase it
    game.longShotHoldT = 0;      // a new flight owns the camera call

    game.ballMode = "shot";
    game.shooter = h;
    game.shooterFinishing = false;
    game.handler = null;
    h.jump(0.4, 0.8);          // shooter rises on the jump shot
    contestJump(game, h);       // nearest defender contests
    // follow-through: the shooter is rooted through the shot's flight and a beat
    // of landing, so he can't instantly crash the boards or get back
    h.coolT = game.shotDur + rand(0.4, 0.7) * h.recoveryMult();
    // team-mates and defenders can crash the boards while the ball is in the air
  }

  // Layup or dunk: a high-percentage finish at the rim with a flat, quick arc.
export function finishAtRim(game: Game, h: Player, dDef: number): void {
    game.pendingAssist = assistCreditFor(game, h);
    game.shotPoints = 2;
    // make% とダンク判定は効果層(resolution/shot-outcome)へ分離。文脈(最寄り守備者・
    // 人だかり・クラッチ)を渡し、dunk フラグと確率を受け取って抽選する。
    const { dunk, p } = rimFinishOutcome(h, dDef, {
      nearestDef: game.nearestDefender(h),
      crowd: game.defendersWithin(h, 2.4),
      clutch: game.clutchFactor(h),
    });
    game.shotWasDunk = dunk;   // ダンクはベンチの盛り上がりが大きい
    game.shotMade = chance(p);

    game.shooter = h;   // own the shot NOW so a block freezes HIS follow-through
    game.lastTouch = h;   // the shooter last touched it (an airball out → other team's ball)
    game.evadedFinish = false;
    const blocker = tryBlock(game, h, true);
    if (blocker) { swatShot(game, h, blocker); return; }
    if (tryShootingFoul(game, h, dDef, true)) return;

    game.shotFrom.set(h.pos.x, dunk ? 2.6 : 1.7, h.pos.z);
    game.shotT = 0;
    // an evaded block reads as a DOUBLE CLUTCH — he hangs a beat longer to let
    // the swat whiff past before laying it in
    game.shotDur = (dunk ? 0.45 : 0.55) + (game.evadedFinish ? 0.14 : 0);
    game.shotApex = dunk ? 0.25 : 0.7;
    // take off SHORT of the rim (on the approach side) and reach the ball up to
    // the hoop, rather than planting the body directly under it. A dunker gets
    // closer than a layup. If he's already right under the rim, gather from the
    // mid-court side.
    {
      const rimFloor = game.attackFloor(h.team);
      let dx = h.pos.x - rimFloor.x, dz = h.pos.z - rimFloor.z;
      let len = Math.hypot(dx, dz);
      if (len < 0.4) { dx = 0; dz = -game.attackSign(h.team); len = 1; }   // approach from mid-court
      const standoff = dunk ? 0.6 : 0.9;
      game.finishSpot.set(rimFloor.x + (dx / len) * standoff, 0, rimFloor.z + (dz / len) * standoff);
    }
    // carry his DRIVE MOMENTUM into the leap: he takes off at the speed he was
    // running (a stride into the finish, not a dead-stop planted jump), and that
    // horizontal speed decays in the air (crashBoards). Capped so a fast break
    // doesn't sail him past the rim.
    {
      const cap = h.runSpeed * 1.05;
      const sp = Math.hypot(h.velX, h.velZ);
      const k = sp > cap ? cap / sp : 1;
      game.finishVX = h.velX * k;
      game.finishVZ = h.velZ * k;
    }
    game.shotTarget.copyFrom(game.attackRim(game.possession));   // point-blank: a miss just rims out
    game.ballMode = "shot";
    game.longShot = false;   // a rim finish is never ball-cam material
    game.longShotHoldT = 0;  // and it cancels a lingering long-shot hold
    game.shooter = h;
    game.shooterFinishing = true;
    game.handler = null;
    // SQUARE UP to the rim at take-off: the body is frozen while airborne, so if he
    // leaves the floor angled the dunk/layup reads as a "back dunk". Snap his chest
    // (and the feet it can't cover) to the basket now so he finishes facing it.
    { const rf = game.attackFloor(h.team); h.faceChestToward(rf.x, rf.z); }
    // elevation scales with ジャンプ
    h.jump(dunk ? 0.85 + rate(h.attr.jump) * 0.3 : 0.55 + rate(h.attr.jump) * 0.2,
      dunk ? 0.7 : 0.6);
    contestJump(game, h);
    // the finisher drives in during the shot (handled in crashBoards), then a
    // short recovery before he can move again
    h.coolT = game.shotDur + rand(0.25, 0.45) * h.recoveryMult();
    game.setEvent(dunk ? "DUNK!" : "LAYUP", h.team);
  }

  // The nearest defender jumps to contest a shot/finish.
export function contestJump(game: Game, shooter: Player): void {
    let near: Player | null = null;
    let best = 2.6; // only contest from within this range
    for (const d of game.teamPlayers(1 - shooter.team)) {
      const dd = dist2D(d.pos, shooter.pos);
      if (dd < best) { best = dd; near = d; }
    }
    if (near) game.contestLeap(near, shooter.pos, 0.5, 0.65);
  }

  // Can a defender swat the shot? Every defender who can reach the shot gets a
  // crack at it — not just the single nearest — so a weak-side rim protector
  // blocks a guard who beat his man, which is where blocks actually come from.
  // Rim finishes are challenged with ヘッド (dunk/rim protection) + ジャンプ +
  // 守判断; jumpers with ジャンプ + 反応 + 守判断; both reward a real height edge
  // and a tight contest. The best available shot-blocker is the one who goes up.
  // evadeOK: whether the shooter may dodge a would-be block with S技術 (the
  // double-clutch). Finishes always can; jump shots inside the arc (ミドル/ゴール下)
  // now can too, so a high-S技術 scorer shoots OVER/AROUND a contest instead of
  // always being swatted. Threes don't (evadeOK=false there).
export function tryBlock(game: Game, shooter: Player, isFinish: boolean, evadeOK = isFinish): Player | null {
    // ブロック確率の算出は効果層(resolution/contest-block)へ分離。ここでは最も
    // 止められる守備者と確率を受け取り、抽選と状態変更(evade/jump/shotMade)を行う。
    const cand = bestBlocker(game.teamPlayers(1 - shooter.team), shooter, isFinish,
      game.shotWindup, PALM_HITBOX);
    if (!cand || !chance(cand.p)) return null;
    const best = cand.def;
    // イベイド（ダブルクラッチ）: フィニッシュ限定 — 伸びてきたブロックの手を
    // 空中でかわしてシュートまで行く。
    if (evadeOK) {
      const pEvade = evadeBlockProbability(shooter, best);
      if (chance(pEvade)) {
        // the swat WHIFFS — the blocker still rises, the shooter hangs and
        // re-shapes the shot. The adjusted release is a touch harder to convert,
        // but S技術 keeps the mechanics clean even mid-air.
        if (!best.airborne) best.jump(0.9, 0.6);
        // the double-clutch re-route is a FINISH motion (ball pulled under the
        // swat, around the blocker); a jump shot just gets it off over the hand,
        // so the curved-ball visual (evadedFinish) is finish-only.
        if (isFinish) {
          game.evadedFinish = true;
          const ex = shooter.pos.x - best.pos.x, ez = shooter.pos.z - best.pos.z;
          const el = Math.hypot(ex, ez) || 1;
          game.evadeDirX = ex / el;
          game.evadeDirZ = ez / el;
        }
        if (game.shotMade && chance(0.18 * (1 - rate(shooter.attr.shotTech)))) game.shotMade = false;
        return null;
      }
    }
    return best;
  }

  // The shot is swatted: the blocker goes up, the ball comes loose at the rim.
export function swatShot(game: Game, shooter: Player, blocker: Player): void {
    blocker.stats.blk++;
    shooter.stats.fga++;             // a blocked shot is a missed attempt
    if (game.shotPoints === 3) shooter.stats.tpa++;
    game.pendingAssist = null;
    // the blocker rises and meets the ball with his hand right at the release —
    // but he may ALREADY be up (he jumped during the gather), so don't re-jump
    // (that would reset his leap and break the contact read)
    if (!blocker.airborne) game.contestLeap(blocker, shooter.pos, 0.95, 0.6);
    game.setEvent("BLOCK!", blocker.team);
    game.handler = null;

    // The hand SWATS the ball off its flight: it is knocked away from the block
    // point (the shooter's release), rejected back OUT away from the rim with a
    // sideways spray, then falls under gravity as a live loose ball. A stronger
    // blocker (ジャンプ/守判断) sends it further.
    const rim = game.attackFloor(shooter.team);
    let ox = shooter.pos.x - rim.x, oz = shooter.pos.z - rim.z;
    let ol = Math.hypot(ox, oz);
    if (ol < 0.9) {                            // a rim finish: swat it out toward the floor
      ox = rand(-1, 1); oz = -Math.sign(rim.z || 1) * rand(0.6, 1.3);
      ol = Math.hypot(ox, oz) || 1;
    }
    ox /= ol; oz /= ol;
    const px = -oz, pz = ox, kick = rand(-0.8, 0.8);   // sideways spray off the hand
    const power = 4.4 + (rate(blocker.attr.jump) * 0.5 + rate(blocker.attr.defense) * 0.5) * 4.0;   // swatted well clear
    // CONTACT POINT = the BLOCKER's hand, not the shooter's space: place the ball
    // just in front of the blocker (toward the shooter), up at the top of his reach,
    // so it's WITHIN his reach and the hand visibly lands on it — the ball is
    // knocked away FROM his hand, not teleported off the shooter.
    let hx = shooter.pos.x - blocker.pos.x, hz = shooter.pos.z - blocker.pos.z;
    const hl = Math.hypot(hx, hz) || 1;
    game.ball.pos.set(blocker.pos.x + (hx / hl) * 0.45, 2.6, blocker.pos.z + (hz / hl) * 0.45);
    // the ball STOPS DEAD on the hand for a beat (blockHoldT) — the contact reads —
    // then it's swatted mostly OUT and DOWN. Hold the deflection velocity until the
    // pin releases (updateLoose), keeping the ball pinned at the hand until then.
    game.blockHoldVel.set((ox + px * kick) * power, rand(-0.6, 1.0), (oz + pz * kick) * power);
    game.blockHoldT = 0.13;
    game.ball.vel.setAll(0);
    blocker.reach(game.ball.pos, true);        // hand on the ball at contact
    game.lastTouch = blocker;                  // he last touched it → out-of-bounds stays with the offence
    // the SHOOTER can't recover it while he is still in his shot motion / landing
    // (no instantly re-grabbing his own blocked shot), and grabAfter keeps it a
    // clear, free, rolling loose ball before ANYONE can secure it.
    shooter.touchCool = 1.0;
    // FREEZE his follow-through: releaseShot never got to set coolT (the block
    // returned first), so set it here — otherwise the loose-ball pose lets his
    // airborne arms snap toward the swatted ball as if he threw it there. With
    // coolT up, poseHands excludes him from the scramble and holds his release form.
    shooter.coolT = 0.6 + rand(0.3, 0.6) * shooter.recoveryMult();
    blocker.defWin("block");                   // triumphant fists-up once he lands
    game.goLoose(shooter.team, 2.6, { rebound: true, grabAfter: 0.6 });
  }

  // Was the shot fouled? Contact is more likely on contested layups. If so,
  // send the shooter to the line (and-one if the shot still went in).
export function tryShootingFoul(game: Game, h: Player, dDef: number, layup: boolean): boolean {
    // ファウル確率は効果層(resolution/foul)へ分離。od は下の突き飛ばし演出でも使う。
    const od = game.onBallDefender(h);
    if (!chance(shootingFoulChance(h, dDef, layup, od))) return false;

    if (game.shotMade) {
      // AND-ONE: by rule the basket has to actually GO IN — so don't
      // short-circuit here. Let the shot fly and drop like any other make;
      // resolveShot sees the pending foul, counts it, then awards the one shot.
      game.pendingAndOne = h;
      return false;
    }

    // fouled on the MISS: no basket — straight to the line for two (three)
    contestJump(game, h);
    game.handler = null;
    game.pendingAssist = null;
    // knocked away from the contesting defender, harder if he's strong/aggressive
    const fpx = od ? h.pos.x - od.pos.x : 0;
    const fpz = od ? h.pos.z - od.pos.z : 0;
    const fs = od ? clamp(0.3 + rate(od.attr.balance) * 0.4 + rate(od.attr.aggression) * 0.2
      - rate(h.attr.balance) * 0.35, 0.1, 1) : 0.5;
    h.foulReaction("hurt", fpx, fpz, fs);   // sell the contact during the dead-ball beat
    game.setEvent("SHOOTING FOUL", h.team, 1.8);
    const count = game.shotPoints;
    // hold so the foul reads, then go to the line
    game.pauseThen(1.3, () => game.ft.start(h, count));
    return true;
  }

  // Where the ball actually flies. A make heads for the rim centre; a miss heads
  // for a point AROUND the rim / off the backboard — never dead-centre (that
  // reads like a make) and never way out of bounds. A farther shot scatters a
  // bit more, but it always stays by the basket, so it can be rebounded.
export function aimShotTarget(game: Game, dHoop: number): void {
    const rim = game.attackRim(game.possession);
    game.shotTarget.copyFrom(rim);
    if (game.shotMade) return;
    const scatter = 0.4 + Math.min(1, Math.max(0, dHoop - THREE_DIST) / 8) * 0.55;   // 0.4 .. ~0.95
    const zSign = Math.sign(rim.z) || 1;
    game.shotTarget.x = rim.x + rand(-1, 1) * scatter;
    game.shotTarget.z = rim.z + zSign * rand(0.05, 0.3 + scatter * 0.5);   // biased long, toward the backboard
    game.shotTarget.y = RIM.height + rand(-0.2, 0.5);
  }

export function updateShot(game: Game, dt: number): void {
    game.crashBoards(dt); // everyone converges on the glass while the shot is up

    game.shotT += dt;
    const k = Math.min(1, game.shotT / game.shotDur);
    const b = game.shotTarget;   // rim on a make, off-target on a miss
    // FINISH (dunk / layup): the ball rides up out of the finisher's HAND and into
    // the rim on ONE smooth arc — no mid-air kink. Horizontally it eases from where
    // his hand IS (he's gliding in) to the rim; vertically it rises to a peak (a
    // slam sits above the rim) then drops through. The arm tracks the ball the whole
    // way (poseHands), so the hand and ball stay linked.
    if (game.shooterFinishing && game.shooter) {
      const fin = game.shooter;
      const e = k * k * (3 - 2 * k);                 // smoothstep — continuous velocity
      const top = game.shotFrom.y;                   // take-off hand height (2.6 dunk / 1.7 layup)
      const peak = Math.max(top, b.y) + game.shotApex;
      let x = fin.pos.x + (b.x - fin.pos.x) * e;
      let y = top + (b.y - top) * e + Math.sin(k * Math.PI) * (peak - Math.max(top, b.y));
      let z = fin.pos.z + (b.z - fin.pos.z) * e;
      // ダブルクラッチ: イベイドしたフィニッシュはボールを一度スワットの下へ
      // 引き込み、ブロッカーと反対側へ体側で回してからリムへ運び直す。腕は
      // poseHands でボールに追従するので、この軌道の曲がりがそのまま「手を
      // かわす」動きとして見える（窓は飛行の18..68%、両端でゼロ=軌道は滑らか）。
      if (game.evadedFinish) {
        const c = Math.sin(clamp((k - 0.18) / 0.5, 0, 1) * Math.PI);
        y -= c * 0.38;                               // pull DOWN out of the swat
        x += game.evadeDirX * c * 0.25;              // swing around the blocker's side
        z += game.evadeDirZ * c * 0.25;
      }
      game.ball.pos.set(x, y, z);
      if (k >= 1) resolveShot(game);
      return;
    }
    const a = game.shotFrom;
    const baseY = a.y + (b.y - a.y) * k;
    const apex = Math.sin(k * Math.PI) * game.shotApex;
    game.ball.pos.set(a.x + (b.x - a.x) * k, baseY + apex, a.z + (b.z - a.z) * k);

    if (k >= 1) resolveShot(game);
  }

export function resolveShot(game: Game, ): void {
    // a deep bomb keeps the ball cam on through the landing/bounce, so the
    // viewer sees whether it dropped before the frame eases back out
    if (game.longShot) { game.longShotHoldT = 1.6; game.longShot = false; }
    const shooter = game.possession;
    const sh = game.shooter;
    if (sh) { sh.stats.fga++; if (game.shotPoints === 3) sh.stats.tpa++; }
    const andOne = game.shotMade && sh !== null && game.pendingAndOne === sh;
    if (game.shotMade) {
      game.score[shooter] += game.shotPoints;
      if (sh) {
        sh.stats.pts += game.shotPoints; sh.stats.fgm++;
        if (game.shotPoints === 3) sh.stats.tpm++;
      }
      if (game.pendingAssist) game.pendingAssist.stats.ast++;
      game.setEvent(andOne ? "AND-1" : game.shotPoints === 3 ? "3 POINTS!" : "2 POINTS",
        shooter, 1.8, { scorer: sh?.name, assist: game.pendingAssist?.name });
      // a dunk or a three brings the whole bench up bouncing; a routine two is a
      // smaller pop
      const big = game.shotPoints === 3 || game.shotWasDunk;
      benchCheer(game, shooter, big ? 2.6 : 1.7, big ? 1.0 : 0.4);
      // the ball drops through the net and bounces on the floor during the hold
      const rim = game.attackRim(shooter);
      game.ball.pos.set(rim.x, RIM.height - 0.15, rim.z);
      game.ball.vel.set(rand(-0.5, 0.5), -2.4, -Math.sign(rim.z || 1) * rand(0.2, 0.8));
      game.ballFalling = true;
      swishNet(game, shooter);   // net snaps + rim flashes on the make
      // hold on the made basket so the viewer sees it, then subs, then inbound —
      // unless the buzzer already sounded (buzzer beater): the period ends here.
      // An AND-1 continues at the line instead: basket counts + one free throw.
      game.handler = null;
      // AND-1: the scorer flexes over the made bucket, THEN heads to the line
      if (andOne) { sh!.foulReaction("and1"); game.pauseThen(1.4, () => game.ft.start(sh!, 1)); }
      else if (game.gameClock <= 0) game.pauseThen(1.4, () => endQuarter(game));
      else game.pauseThen(1.4, () => game.withSubs(() => game.inbound.start(1 - shooter)));
    } else {
      game.setEvent("MISS", shooter);
      if (game.gameClock <= 0) { game.handler = null; endQuarter(game); }
      else game.startRebound();
    }
    game.pendingAssist = null;
    game.pendingAndOne = null;
  }

  // The teammate (if any) whose pass set up this shooter — credited an assist if
  // the shot drops. Requires the shooter to be the player who caught the pass.
export function assistCreditFor(game: Game, shooter: Player): Player | null {
    return (game.assistTo === shooter && game.assistFrom && game.assistFrom !== shooter)
      ? game.assistFrom : null;
  }
