// オフェンスの状況判断エンジン（方式B: GameState 集約）。ボールを持った選手の
// 意思決定（decide）とドライブ実行（driveDecision）、およびその補助を関数として集約。
// 状態は Game に集約し、各関数は第一引数 game を受け取る。循環回避のため
// pickSide/setDriveSide/setDrive は Game 側に残置し game.X 経由で呼ぶ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, COURT, THREE_DIST, SHOT_CLOCK, PALM_HITBOX, MAX_PASS } from "../config";
import { clamp, dist2D, dist2DTo, moveToward2D, chance, rand } from "../util";
import { twWeight, gatherFor, effShootRange, wontLoadUp, reactionLag, palmRadius,
  jukeDeception, jukeDiscipline, deepThreeOK, stripEdge, shotWindupFor } from "../eval";
import { TACTICS, rate } from "../attributes";
import { denySmother } from "./defense";
import { pass, passToReceiver } from "./passing";
import { updateOffBallMotion, bestOpenSpot } from "./offball";
import { shoot, finishAtRim } from "./shooting";
import { laneVetoed, passRisk } from "../resolution/pass-risk";
import type { Game } from "../game";

// ダブルチーム記憶: 直近でトラップに遭った選手を no-feed 対象に保つ秒数
const TRAP_MEMORY = 2.5;
// この D精度未満のハンドラーはドリブルで抜け（クロスオーバー/ブロウバイ/ポスト）を
// 仕掛けられず、キープ（シールド/にじり寄り/味方へ渡す）のみ
const KEEP_DRIBBLE_THRESH = 0.55;

export function runOffense(game: Game, dt: number, h: Player): void {
    const team = h.team;
    const rimFloor = game.attackFloor(team);
    const dHoop = dist2D(h.pos, rimFloor);
    const dDef = game.nearestDefenderDist(h);

    // off-ball players run motion (cuts, give-and-go, perimeter movement)
    updateOffBallMotion(game, dt, team, h);

    // handler decision — a high offensive IQ reads the floor faster
    h.decisionT -= dt;
    if (h.decisionT <= 0) {
      // the next action can only START when the ball is back in his hand. A poor
      // handler's slow dribble (see dribblePhase cadence) leaves the ball on the
      // floor longer, so he waits — a beat of sluggishness a quick handler never
      // has. (A committed move / dead clock is exempt — the ball's already up.)
      const committed = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
      if (!committed && !game.ballInHand(h) && game.shotClock > 1) {
        h.decisionT = 0.02;   // hold — re-check almost immediately, act when it's up
      } else {
        h.decisionT = rand(0.25, 0.45) * (1.35 - rate(h.attr.offense) * 0.7);
        decide(game, h, dHoop, dDef, rimFloor);
      }
    }

    // movement: how the committed 1-on-1 move plays out. D速度 sets how much of
    // his top speed survives while dribbling; a ball pushed out FRONT adds a
    // little more (and a ball tucked to the hip pushes nothing).
    let mult = 0.84 + rate(h.attr.dribbleSpd) * 0.18;
    if (dHoop > 0.5) {
      const frontness = (h.carryX * (rimFloor.x - h.pos.x) + h.carryZ * (rimFloor.z - h.pos.z)) / dHoop;
      mult *= 1 + clamp(frontness, 0, 0.6) * 0.1;
    }
    if (h.jukeT > 0) {
      // executing a dribble move — the visible footwork (jab step-in, side-step,
      // or step-back) that shakes the defender before the drive resolves
      h.jukeT = Math.max(0, h.jukeT - dt);
      moveToward2D(h.pos, h.jukeTarget.x, h.jukeTarget.z, h.accelToward(dt, h.jukeTarget.x, h.jukeTarget.z, 0.95) * dt);
    } else if (h.beatenT > 0) {
      // SPEED blow-by: burst past the beaten defender to the rim
      h.beatenT = Math.max(0, h.beatenT - dt);
      mult *= 1.12 + rate(h.attr.agility) * 0.14;        // quick handlers burst harder
      // the burst goes past the recovering defender's SHOULDER on the beaten
      // side — never through his chest (running straight at the rim used to
      // grind the blow-by to a halt in the body-collision step)
      let btx = h.driveTarget.x, btz = h.driveTarget.z;
      const bd = game.onBallDefender(h);
      if (bd && dist2D(h.pos, bd.pos) < 1.7
          && dist2D(bd.pos, rimFloor) < dist2D(h.pos, rimFloor)) {
        const dx = rimFloor.x - h.pos.x, dz = rimFloor.z - h.pos.z;
        const dl = Math.hypot(dx, dz) || 1;
        const lx = -dz / dl, lz = dx / dl;               // lateral, driveSide space
        btx = bd.pos.x + lx * h.driveSide * 1.05 + (dx / dl) * 0.5;
        btz = bd.pos.z + lz * h.driveSide * 1.05 + (dz / dl) * 0.5;
      }
      moveToward2D(h.pos, btx, btz, h.accelToward(dt, btx, btz, mult) * dt);
    } else if (h.powerT > 0) {
      // POWER drive: grind straight at the rim INTO the defender. He advances
      // slower, but the collision step (holdWeight²) shoves the weaker man back,
      // so a strong handler bulls his way to the basket and a weak one bogs down.
      h.powerT = Math.max(0, h.powerT - dt);
      mult *= 0.5 + rate(h.attr.balance) * 0.35;         // strong = keeps churning through contact
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, mult) * dt);
      // PHYSICAL WALL: a defender bodying him up who actually wins the strength
      // battle (higher holdWeight — mostly ボディバランス) stonewalls the drive
      // instead of getting walked to the rim; a weaker one still gets bulldozed.
      const dm = game.onBallDefender(h);
      // PUSH-BACK zone: the range at which he can wall the drive = his palm hit-zone
      // (sized by def − off), so a better defender pushes the advance back from
      // FARTHER and more firmly; falls back to the old 0.95 m contact when disabled.
      const wallR = PALM_HITBOX && dm ? clamp(palmRadius(dm, h) * 0.62, 0.6, 1.5) : 0.95;
      if (dm && dist2D(h.pos, dm.pos) < wallR) {
        const overlap = PALM_HITBOX ? clamp(1 - dist2D(h.pos, dm.pos) / wallR, 0, 1) : 1;
        // a set, strong-bodied defender (ボディバランス, + some 守判断) can
        // stonewall a committed bull drive; the handler's own strength (and post
        // footwork) makes him harder to stop — a weak defender just gets bulldozed
        const stop = rate(dm.attr.balance) * 0.85 + rate(dm.attr.defense) * 0.2
          - rate(h.attr.balance) * 0.75 - (h.has("post") ? 0.15 : 0);
        if (chance(clamp(stop, 0, 0.85) * dt * 2.5 * (0.55 + overlap * 0.9))) {
          h.powerT = 0;
          h.stalledT = rand(0.3, 0.5);                   // couldn't move him — walled off
          dm.defWin("stop");                             // held his ground — brace/assert
        }
      }
    } else if (h.stalledT > 0) {
      // WALLED OFF: the defender held his ground — the handler is contained and
      // has to pull the ball back out, losing a step of tempo.
      h.stalledT = Math.max(0, h.stalledT - dt);
      game.setDrive(h, rimFloor, dist2D(h.pos, rimFloor) + 0.5); // retreat dribble
      moveToward2D(h.pos, h.driveTarget.x, h.driveTarget.z, h.accelToward(dt, h.driveTarget.x, h.driveTarget.z, 0.5) * dt);
    } else {
      // probing dribble between moves. A big backing his man down keeps the
      // grind (the balance battle is the point of a post-up); anyone else READS
      // the body in his lane and steps AROUND it instead of ploughing straight
      // into the jostle and letting the collision push sort it out.
      const imp = driveImpeder(game, h);
      const posting = game.isBig(h) || h.has("post");
      let tx = h.driveTarget.x, tz = h.driveTarget.z;
      if (imp && posting) {
        const edge = clamp(rate(h.attr.balance) - rate(imp.attr.balance)
          + (h.has("post") ? 0.12 : 0), -0.6, 1);
        const base = game.isBig(h) ? 0.34 : 0.38;
        mult *= clamp(base + edge * 0.6, 0.2, 0.95);
      } else {
        const av = game.steerAround(h, tx, tz, true);
        tx = av.x; tz = av.z;
        if (imp) mult *= 0.8;   // brushing right past a body still isn't free
      }
      // KEEP DRIBBLE: a marked poor handler only inches — his dribble crawls (じり
      // じり), so he can't grind through (this also throttles the post ゴリゴリ push)
      if (h.keepShieldT > 0) mult = Math.min(mult, 0.28);
      moveToward2D(h.pos, tx, tz, h.accelToward(dt, tx, tz, mult) * dt);
    }
    game.clampCourt(h.pos);
    // once established, the handler must not dribble back across halfway
    if (game.frontT) {
      const s = game.attackSign(h.team);
      if (h.pos.z * s < 0.05) h.pos.z = 0.05 * s;
    }
  }

  // The ball-handler's choice — shoot / drive / pass / reset — blending the
  // player's own tendencies & skills with the team's tactical game plan.
export function decide(game: Game, h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    const tac = game.tactics[h.team].offense;
    const prio = h.offPriority;
    // ロール由来の行動プロファイル: 何をするかはオフェンスロールが支配する。
    // canCreate = 自分から仕掛ける役（エース/スラッシャー/得点ビッグ/balanced）、
    // passFirst = まず配球（ハンドラー/フロアジェネラル/ハブビッグ）、
    // noCreate = 無理に作らない（スポット/カッター/スクリーナー/リバウンダー等）。
    const act = h.offAction;
    const canCreate = act === "score" || act === "slash" || act === "postScore" || act === "balanced";
    const passFirst = act === "distribute" || act === "postHub";
    const noCreate = act === "spot" || act === "cut" || act === "run" || act === "screen" || act === "rebound";

    // BUZZER BEATER: almost no time on the game/shot clock and no chance to work
    // a good look — heave it up from wherever he is, however off-balance. shoot()
    // already floors the make% for a desperation distance, so it's a real prayer.
    // game buzzer → always heave. Shot-clock buzzer → heave UNLESS a hard deny
    // has him smothered (then he can't get it off and the clock dies = violation).
    const gameBuzzer = game.gameClock > 0 && game.gameClock < 0.9;
    const shotBuzzer = game.shotClock < 0.45;
    // he can only launch the deep one if there's clock left to GATHER it — a low
    // L速度 player heaving from way behind the arc needs wind-up time he doesn't
    // have, so the shot clock dies (violation) instead of an ugly deep prayer.
    // (the end-of-quarter game buzzer is exempt: any desperation heave goes up.)
    const canGather = game.shotClock >= gatherFor(h, dHoop);
    if ((gameBuzzer || (shotBuzzer && canGather && !denySmother(game, h, dDef))) && dHoop > 1.8) {
      shoot(game, h, dHoop, dDef); return;
    }

    // ゴール至近でフリーで受けた: 迷わずフィニッシュ。ここから外へ持ち出して
    // ゴールに向き直る「時間をかける攻め」は不要 — マークが居ないなら即アタック。
    if (dDef > 1.0 && game.frontT) {
      if (dHoop <= 2.3) { finishAtRim(game, h, dDef); return; }
      if (dHoop <= 4.0 && laneClear(game, h, rimFloor)) { game.setDrive(h, rimFloor, 1.2); return; }
    }

    // change of possession: the ball has to be carried up, and that's a guard's
    // job. A PF/C who ends up with it before the frontcourt is set looks for the
    // point guard first, then the shooting guard, and hands it off rather than
    // dribbling it up himself. (An offensive rebound keeps frontT, so a big
    // still finishes at the rim there — this only fires while bringing it up.)
    // (a プレイメイキングビッグ is exempt — he brings it up and runs the
    // offence himself, ヨキッチ-style)
    if (!game.frontT && game.isBig(h) && h.evalRole !== "プレイメイキングビッグ" && dHoop > 10) {
      // the two best playmakers get first call (normally PG then SG — but a
      // designated メインハンドラー outranks them wherever he plays)
      const guards = game.teamPlayers(h.team).filter((g) => g !== h)
        .sort((a, b) => b.playmaking - a.playmaking);
      for (const g of guards.slice(0, 2)) {
        if (outletTo(game, h, g)) return;
      }
      advanceSafely(game, h);                     // no guard free yet — hold/drift, don't attack
      return;
    }

    // FAST BREAK: a guard/wing with the ball and an open floor pushes it hard
    // at the rim before the defence sets (the big already outlet above).
    if (game.pushT > 0) { pushBreak(game, h, dHoop); return; }

    // at the rim → finish; shot-clock dying → put one up
    // at the rim → finish. A handler arriving at full burst takes off earlier —
    // the driving layup/floater launches from a step further out
    if (dHoop < (h.beatenT > 0 ? 2.3 : 1.8)) { finishAtRim(game, h, dDef); return; }

    // FORMING DOUBLE-TEAM → give it up EARLY: a help defender is rotating over to
    // trap and hasn't sprung it yet — beat it by moving the ball to a team-mate
    // NOW instead of waiting to get stuck. The worse the handle (D精度), the
    // earlier he lets go (球離れ) — a poor dribbler bails almost every time a trap
    // shows, a secure handler backs himself to split it a beat longer. (A move
    // already committed rides it out; if no safe outlet exists, fall through.)
    const committing = h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0;
    if (!committing && game.shotClock > 1 && doubleTeamApproaching(game, h)) {
      const bail = clamp(0.15 + (1 - rate(h.attr.dribbleAcc)) * 1.0
        + (1 - rate(h.attr.handling)) * 0.15, 0.12, 0.96);
      if (chance(bail) && pass(game, h)) return;
    }

    // LOW D精度, MARKED UP: a poor ball-handler can't beat his man off the dribble
    // or bull him in the post — he can only KEEP it. Body angled, ball shielded
    // behind him, his ONLY reads are: give it to a team-mate who came to help,
    // inch forward, or hold. No crossover, no blow-by, no ゴリゴリ post grind.
    if (mustKeepDribble(game, h, dDef)) { keepDribbleDecide(game, h, dHoop, dDef, rimFloor); return; }

    // a committed 1-on-1 move is already under way — see it through (the burst /
    // bull drive carries him; the finish check above ends it at the rim) rather
    // than re-deciding every tick, which is what made the old drive look mushy
    if (h.beatenT > 0 || h.powerT > 0 || h.jukeT > 0) return;
    // walled off: contained this rep — kick it out to a better look, otherwise
    // keep pulling it back out (movement handles the retreat) and re-attack once
    // the stall clears
    if (h.stalledT > 0) { if (chance(0.5) && pass(game, h)) return; return; }

    // mid-combo: the last shake didn't spring him but the defender is rocking —
    // go straight back into the duel with the next move the other way
    if (h.comboN > 0) {
      if (canIso(game, h, dHoop)) { driveDecision(game, h); return; }
      h.comboN = 0;                        // situation changed — abandon the combo
    }

    // the man guarding him has LEFT HIS FEET (an early-contest gamble or a
    // fake he bought) — put the ball on the floor and walk past the floater.
    // Quick, sharp handlers punish it almost every time; slower ones sometimes
    // hesitate and the moment passes. (only the shot-creators exploit it off the
    // dribble — a spot-up/distributor doesn't suddenly iso.)
    if (canCreate) {
      const od = game.onBallDefender(h);
      if (od && od.airborne && dDef < 2.2 && canIso(game, h, dHoop)
          && chance(0.45 + rate(h.attr.reaction) * 0.3 + rate(h.attr.handling) * 0.15)) {
        h.driveSide = game.pickSide(h);
        h.beatenT = rand(0.6, 0.9);
        od.reactT = Math.max(od.reactT, reactionLag(od));
        game.setDriveSide(h);
        return;
      }
      // ATTACK THE CLOSEOUT: a defender still flying at him under control-less
      // momentum (high closing speed) can be driven straight past — the handle
      // (技術) and quickness (敏捷性) beat him, and his ボディバランス is what
      // lets him stop and stay down instead of blowing by. A slow, balanced
      // closeout isn't punished.
      if (od && !od.airborne && dDef < 2.4 && od.curSpd > od.runSpeed * 0.55
          && canIso(game, h, dHoop)) {
        const edge = rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.35
          + rate(h.attr.dribbleAcc) * 0.25 - rate(od.attr.balance) * 0.5;
        if (chance(clamp(0.3 + edge, 0.08, 0.75))) {
          h.driveSide = game.pickSide(h);
          h.beatenT = rand(0.55, 0.85);
          od.reactT = Math.max(od.reactT, reactionLag(od));
          game.setDriveSide(h);
          return;
        }
      }
    }

    // 目の前の守備を抜けない（直前のドライブが止められた）: 単騎の壁でも
    // キックアウトの引き出し（ジャンプパス/バウンドパス）で打開を試みる
    if (h.stalledT > 0 && dDef < 1.6 && trapKickOut(game, h)) return;

    // DOUBLE-TEAM / TRAP: a GENUINE trap is two men BOTH collapsed tight on the
    // ball (not merely two defenders loosely in the area, which is constant in a
    // half-court). Only then does the trap read take over; otherwise fall through
    // to the normal decision. The correct read is to KICK OUT (a double team
    // leaves a team-mate open) or keep it and reset — not bull into the wall.
    {
      const d1 = game.onBallDefender(h);
      let tight = 0, contain = 0;
      let d2: Player | null = null, d2d = Infinity;
      for (const dn of game.teamPlayers(1 - h.team)) {
        const dd = dist2D(dn.pos, h.pos);
        if (dd < 1.6) {
          tight++;
          contain += rate(dn.attr.defense) * 0.4 + rate(dn.attr.agility) * 0.35 + rate(dn.attr.balance) * 0.25;
        }
        if (dn !== d1 && dd < 1.9 && dd < d2d) { d2d = dd; d2 = dn; }
      }
      // remember the trap ON THE MAN, so even after it momentarily loosens the
      // ball isn't swung straight back into it (kills the A→B→A relay)
      if (tight >= 2) h.trappedT = TRAP_MEMORY;
      // real trap: two men within 1.6 m AND actual on-ball pressure (dDef tight)
      if (tight >= 2 && dDef < 1.4) {
        // Splitting the trap off the dribble. A designated slasher — スラッシャー
        // special ability ("driver") OR スラッシャー offence role (offAction
        // "slash") — does it READILY; anyone else only rarely forces it (a low,
        // non-zero floor so the read isn't robotic). It is NOT just an ability
        // check: a real SEAM has to exist between the two trappers, and a team-mate
        // bodying one of them opens it up further. Success is RELATIVE to the trap.
        if (canIso(game, h, dHoop)) {
          // SEAM measured along the lane to the rim: split to either side → a gap
          // down the MIDDLE; overloaded to one side → the OUTSIDE is the opening;
          // stacked on the ball → no lane.
          let seam = 0;
          if (d1 && d2) {
            let ux = rimFloor.x - h.pos.x, uz = rimFloor.z - h.pos.z;
            const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
            const px = -uz, pz = ux;                                    // lateral axis
            const lat1 = (d1.pos.x - h.pos.x) * px + (d1.pos.z - h.pos.z) * pz;
            const lat2 = (d2.pos.x - h.pos.x) * px + (d2.pos.z - h.pos.z) * pz;
            seam = lat1 * lat2 < 0 ? Math.min(Math.abs(lat1), Math.abs(lat2)) : 0.8;
          }
          const seamScore = clamp((seam - 0.4) / 1.2, 0, 1);           // ~bodies..wide-open
          // a TEAM-MATE bodying / screening one trapper occupies him, so the trap
          // is effectively short-handed and the handler slips his mark
          let screen = 0;
          for (const mate of game.teamPlayers(h.team)) {
            if (mate === h) continue;
            if (d1 && dist2D(mate.pos, d1.pos) < 1.2) screen = Math.max(screen, 0.5);
            if (d2 && dist2D(mate.pos, d2.pos) < 1.2) screen = Math.max(screen, 0.5);
          }
          const attack = rate(h.attr.handling) * 0.35 + rate(h.attr.agility) * 0.35
            + rate(h.attr.dribbleAcc) * 0.20 + rate(h.attr.speed) * 0.10;
          const rel = attack - contain / tight;                        // edge over the trap
          const slasher = h.has("driver") || act === "slash";
          const openness = seamScore * (slasher ? 0.28 : 0.14) + screen * (slasher ? 0.22 : 0.12);
          const splitChance = slasher
            ? clamp(0.05 + rel * 1.5 + openness, 0.03, 0.65)
            : clamp(0.02 + rel * 0.45 + openness, 0.015, 0.24);
          if (chance(splitChance)) { driveDecision(game, h); return; }
        }
        // can't split → SOLVE IT WITH PASSING: kick out to the man the trap left
        // open (a good passer threads a bounce/jump pass between them). If nobody
        // is open yet, EVADE — retreat-dribble out of the trap and reset, rather
        // than standing there keeping the ball in the double-team.
        if (trapKickOut(game, h)) return;
        retreatFromTrap(game, h);
        return;
      }
    }

    // ROLE-DRIVEN ACTION — the ball has reached him; what he does now follows
    // his OFFENSIVE ROLE, so funnelling usage to a distributor/big/spacer does
    // NOT turn him into a gunner or a reckless dribbler.
    if (passFirst) {
      // ハンドラー/フロアジェネラル/ハブビッグ: まず配球。ただし「打たずにパス回し
      // だけ」にならないよう、空いた球は打ち、レーンが開けば仕掛けてギャップを作る。
      if (!game.frontT) { bringUpLane(game, h); return; }
      if (game.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
        // ヒーブを投げ捨てる前に: まだ1秒以上あるなら、まずラインまで急いで寄る
        // （深い3は効き射程外＝確率を捨てるだけ）。1秒を切ったら腹を括って打つ。
        if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        shoot(game, h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= effShootRange(h) + 0.3;
      const clockPush = clamp((SHOT_CLOCK * 0.5 - game.shotClock) / (SHOT_CLOCK * 0.5), 0, 1);   // 遅いほど打つ(残半分から)
      // a clean lane → attack to bend the defence (a big posts instead of dribbling)
      if (laneClear(game, h, rimFloor) && dHoop <= 8 && canIso(game, h, dHoop)
          && chance(clamp(0.2 + rate(h.attr.handling) * 0.25 + clockPush * 0.3, 0, 0.6))) {
        if (game.isBig(h)) postMove(game, h); else driveDecision(game, h);
        return;
      }
      const open = dDef > 1.7;
      const pS = clamp(0.16 + rate(h.attr.threeAcc) * 0.28 + (dDef - 1.7) * 0.2 + clockPush * 0.5, 0.04, 0.9);
      if (inRange && open && chance(pS)) { shoot(game, h, dHoop, dDef); return; }
      if (pass(game, h)) return;
      game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));   // probe/reset — never backs a man OUT of the paint
      return;
    }
    if (noCreate) {
      // スポット/カッター/ランナー/スクリーナー/リバウンダー: キャッチ&シュートが
      // 基本。無理な単独クリエイトはしないが、「クローズアウトには仕掛ける」ことで
      // ギャップを作り、開いた球はしっかり打つ（打たずに回すだけにしない）。
      if (!game.frontT) { bringUpLane(game, h); return; }
      if (game.shotClock < SHOT_CLOCK * 0.3 && dHoop > 1.8 && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
        // ヒーブを投げ捨てる前に: まだ1秒以上あるなら、まずラインまで急いで寄る
        // （深い3は効き射程外＝確率を捨てるだけ）。1秒を切ったら腹を括って打つ。
        if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
        shoot(game, h, dHoop, dDef);
        return;
      }
      const inRange = dHoop <= effShootRange(h) + 0.3;
      const clockPush = clamp((SHOT_CLOCK * 0.5 - game.shotClock) / (SHOT_CLOCK * 0.5), 0, 1);
      // ATTACK THE CLOSEOUT: a shooter with a live handle drives past a defender
      // flying at him — the main way an off-ball scorer creates a gap.
      const od = game.onBallDefender(h);
      if (od && !od.airborne && dDef < 2.3 && od.curSpd > od.runSpeed * 0.5
          && canIso(game, h, dHoop) && rate(h.attr.handling) > 0.45
          && chance(clamp(0.28 + rate(h.attr.handling) * 0.4 + rate(h.attr.agility) * 0.3
              - rate(od.attr.balance) * 0.4, 0.1, 0.7))) {
        h.driveSide = game.pickSide(h); h.beatenT = rand(0.5, 0.8);
        od.reactT = Math.max(od.reactT, reactionLag(od));
        game.setDriveSide(h); return;
      }
      const isThreeL = dHoop > THREE_DIST;
      const open = dDef > (h.has("isoShooter") ? 1.3 : 1.5);
      const pS = clamp(0.42 + rate(h.attr.aggression) * 0.2 + (dDef - 1.5) * 0.22
        + (isThreeL ? tac.threeBias * 0.2 * twWeight(h) : 0.12) + clockPush * 0.4, 0.06, 0.95);
      if (inRange && open && chance(pS)) { shoot(game, h, dHoop, dDef); return; }
      if (pass(game, h)) return;
      game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
      return;
    }

    // BIGS (PF/C) — and anyone with the ポスト ability — work in the post: back
    // the defender down to the rim for a layup/dunk rather than settle for a
    // jumper. Kick out if bodied up hard or if a clearly better look is open.
    if (game.isBig(h) || h.has("post")) {
      if (dDef < 1.1 && chance(0.3)) {
        const better = betterOptionAvailable(game, h);
        if (better && passToReceiver(game, h, better)) return;
      }
      if (dHoop > 6 && chance(dHoop > 10 ? 0.85 : 0.45) && pass(game, h)) return;
      postMove(game, h);
      return;
    }

    // 残クロックに対する相対しきい値(SHOT_CLOCK 依存)。7秒クロックでは ~2.5秒前後で
    // 初めて「打ち急ぎ」に入る（up-tempo は少し早い）。絶対秒だと短クロックで早過ぎた。
    const urgent = game.shotClock < SHOT_CLOCK * (0.42 + tac.pace * 0.14 * twWeight(h));
    // 打ち急ぎ圏でギャザーが間に合わない（深すぎる）: 外で持て余さず、ワインド
    // アップの要らないレイアップを狙ってリムへ切り込む
    if (urgent && game.shotClock > 0.8 && wontLoadUp(h, dHoop, dDef)) {
      driveDecision(game, h);
      return;
    }
    if (urgent && canGather && !wontLoadUp(h, dHoop, dDef) && !denySmother(game, h, dDef)) {
      // 打ち急ぎでも深い3は投げ捨てない: 効き射程の外に居てまだ1秒以上あるなら、
      // まずラインへ寄る（1秒を切ったらどこからでも打つ）
      if (dHoop > effShootRange(h) + 0.6 && game.shotClock > 1.0) { game.setDrive(h, rimFloor, THREE_DIST + 0.2); return; }
      shoot(game, h, dHoop, dDef);
      return;
    }

    // desire to do each thing = personality + skill + tactics(×連携) + scoring
    // role + 特殊能力 (ドリブラー/ストライカー/ドリブルキープ)
    const tw = twWeight(h);
    let driveDesire = rate(h.attr.aggression) * 0.35 + rate(h.attr.handling) * 0.25 + tac.driveBias * 0.4 * tw;
    if (h.has("driver")) driveDesire += 0.25;        // ドリブラー: hunts the blow-by
    let shootDesire = rate(h.attr.aggression) * 0.4 + prio * 0.4 + tac.pace * 0.2 * tw;
    if (h.has("striker")) shootDesire += 0.15;       // ストライカー: scorer's mentality
    if (h.has("keepDribble")) shootDesire -= 0.08;   // キープ型は攻め急がない
    let passDesire = (1 - rate(h.attr.aggression)) * 0.25 + rate(h.attr.passAcc) * 0.2
      + tac.ballMovement * 0.4 * tw + (1 - prio) * 0.25; // lower options give it up more

    // ペイント内で持った場合、連携が低い選手ほどチーム戦術やパスより「自分で決める」
    // ことを優先する: ドライブ/フィニッシュ意欲を上げ、キックアウト意欲を下げる。連携が
    // 高い選手はここでも設計どおりボールを動かす。(オープンなリム至近は上流で即フィニッシュ
    // 済みなので、ここが効くのは競り合った状態のペイント。)
    if (dHoop <= 4.3 && Math.abs(h.pos.x) <= 2.6) {
      const selfish = (1 - rate(h.attr.teamwork)) * 0.4;   // 連携100→+0, 連携0→+0.4
      driveDesire += selfish;
      shootDesire += selfish;
      passDesire = Math.max(0, passDesire - selfish * 1.2);
    }

    const laneOpen = laneClear(game, h, rimFloor);
    const beaten = h.beatenT > 0;
    const isThree = dHoop > THREE_DIST;

    // clear path to the rim within range → usually attack (a layup beats a jumper),
    // unless a pass-first player kicks it or an elite shooter has a wide-open look
    if ((beaten || laneOpen) && dHoop <= 9) {
      if (!beaten && isThree && dDef > 2.0 && rate(h.attr.threeAcc) > 0.65
          && dHoop <= effShootRange(h) + 0.3           // within his EFFECTIVE range (deep 3 = elite only)
          && chance(0.25 + tac.threeBias * 0.4 * tw)) { shoot(game, h, dHoop, dDef); return; }
      const driveChance = beaten ? 1 : clamp(0.35 + driveDesire * 0.55, 0.25, 0.95);
      if (chance(driveChance)) { driveDecision(game, h); return; }
      if (chance(passDesire * 0.7) && pass(game, h)) return;
      driveDecision(game, h);
      return;
    }

    // no clean lane: an open look is taken (the primary option most readily);
    // a tough, contested look is swung to a higher scoring option if one is open.
    // L速度 (range) decides how far out this player is a willing shooter.
    if (dHoop <= effShootRange(h) + 0.3) {
      // 1対1シュート: happy to rise over a single defender
      const open = dDef > (h.has("isoShooter") ? 1.4 : 1.7);
      // クロック連動の撃ち急ぎ: 残クロックが減るほどオープンな射程内の球は打つ。
      // (この主判断ルートには従来 clockPush が無く、開いていても回してしまい
      //  ショットクロック違反を量産していた。)
      const clockPush = clamp((SHOT_CLOCK * 0.6 - game.shotClock) / (SHOT_CLOCK * 0.6), 0, 1);
      let pShoot = 0.20 + shootDesire * 0.55 - (dHoop - 2) * 0.04 + (dDef - 1) * 0.3 + clockPush * 0.5;
      if (isThree) pShoot += tac.threeBias * 0.22 * tw - 0.05;
      pShoot = clamp(pShoot, 0.03, 0.96);
      if (open && chance(pShoot)) { shoot(game, h, dHoop, dDef); return; }

      // a defender closing out on a shooter with a handle can be punished with a
      // STEP-BACK: bait the closeout, then blow by or rise into clean space
      if (!open && dDef < 1.5 && canIso(game, h, dHoop) && h.jukeT <= 0
          && (rate(h.attr.midAcc) > 0.55 || rate(h.attr.threeAcc) > 0.6)
          && chance(clamp(0.05 + rate(h.attr.dribbleAcc) * 0.14 + rate(h.attr.agility) * 0.1, 0, 0.32))) {
        const d = game.onBallDefender(h);
        if (d) { stepBack(game, h, d, dHoop); return; }
      }

      // not a clean look → this is where a scorer ATTACKS his man off the dribble
      // (a real isolation), trying to beat him with speed or power rather than
      // settling or resetting. This is the main source of half-court penetration.
      if (canIso(game, h, dHoop) && chance(clamp(0.2 + driveDesire * 0.5, 0.08, 0.7))) {
        driveDecision(game, h); return;
      }

      // difficult shot → look to swing it to a better (open) scoring option
      const better = betterOptionAvailable(game, h);
      if (better && passToReceiver(game, h, better)) return;

      if (chance(pShoot)) { shoot(game, h, dHoop, dDef); return; } // else back yourself
    }
    // out of shooting range (or declined to shoot): attack off the dribble to get
    // downhill, else move the ball, else probe and reset. As the clock drains the
    // offence STOPS dawdling — the drive urge climbs and the "swing it around and
    // reset" urge falls, so a possession doesn't idle its way into a violation.
    const clockCommit = clamp((SHOT_CLOCK * 0.6 - game.shotClock) / (SHOT_CLOCK * 0.6), 0, 1); // 0 early .. 1 late
    if (canIso(game, h, dHoop) && chance(clamp(driveDesire * 0.45 + clockCommit * 0.75, 0, 0.95))) {
      driveDecision(game, h); return;
    }
    const passUrge = clamp((passDesire * 0.6 + (dDef < 1.3 ? 0.2 : 0)) * (1 - clockCommit * 0.85), 0, 0.85);
    if (chance(passUrge) && pass(game, h)) return;
    // clock is getting away and he still hasn't committed → stop resetting, go
    if (game.shotClock < SHOT_CLOCK * 0.5 && canIso(game, h, dHoop)) { driveDecision(game, h); return; }
    // still bringing it up (backcourt) → carry it up a SIDE lane, not the gut;
    // in the frontcourt it's just a reset probe toward the rim
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, rimFloor, Math.min(4.5, Math.max(dHoop, 1.2)));
  }

  // The side (−1 left / +1 right) with more room — fewer team-mates on it — so
  // the ball comes up away from the crowd and the floor stays spread.
export function openSide(game: Game, h: Player): number {
    let l = 0, r = 0;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      if (p.pos.x < -0.5) l++; else if (p.pos.x > 0.5) r++;
    }
    return l <= r ? -1 : 1;
  }

  // Bring the ball up a WING lane into the frontcourt rather than straight up the
  // middle (which jams the paint and kills the passing angles). Once he's off
  // centre he keeps his side; from dead centre he picks the open side.
export function bringUpLane(game: Game, h: Player): void {
    const s = game.attackSign(h.team);
    const side = Math.abs(h.pos.x) > 1.5 ? Math.sign(h.pos.x) : openSide(game, h);
    // BREAK to the sideline first (mostly lateral) while still central, THEN
    // carry it up hugging that side — keeps the middle clear and opens the
    // left/right passing angles instead of jamming straight up the gut.
    const ahead = Math.abs(h.pos.x) < 4 ? 1.8 : 5.0;
    h.driveTarget.set(side * 5.5, 0, h.pos.z + s * ahead);
  }

  // A double-team that is still FORMING — the on-ball man is up on the handler and
  // a SECOND defender is rotating over, closing fast, but the two haven't sprung
  // the trap yet. This is the moment to give the ball up and beat it, rather than
  // wait for both to arrive and get stuck (the ダブルチームに嵌まる往復). Returns the
  // approaching help defender, or null if no trap is developing.
export function doubleTeamApproaching(game: Game, h: Player): Player | null {
    const opps = game.teamPlayers(1 - h.team);
    // the on-ball defender must actually be pressuring first
    let onD = Infinity;
    for (const d of opps) { const dd = dist2D(d.pos, h.pos); if (dd < onD) onD = dd; }
    if (onD > 2.6) return null;
    // a second man driving in toward the handler = the trap closing
    for (const d of opps) {
      const dx = h.pos.x - d.pos.x, dz = h.pos.z - d.pos.z;
      const dd = Math.hypot(dx, dz) || 1;
      if (dd <= onD + 0.05) continue;             // that's the on-ball man himself
      if (dd < 1.9 || dd > 4.5) continue;         // already trapped (<1.9) / too far to be closing in
      const sp = Math.hypot(d.velX, d.velZ);
      if (sp < 0.7) continue;                     // must be moving, not just standing near
      const closing = (dx * d.velX + dz * d.velZ) / (dd * sp); // 1 = sprinting straight at him
      if (closing > 0.5) return d;
    }
    return null;
  }

export function betterOptionAvailable(game: Game, h: Player): Player | null {
    let best: Player | null = null;
    let bestPrio = h.offPriority + 0.1;          // must be a meaningfully better option
    for (const p of game.teamPlayers(h.team)) {
      if (p === h || p.offPriority <= bestPrio) continue;
      if (p === game.assistFrom && game.assistTo === h && !p.cutting) continue; // no ping-pong
      if (dist2D(h.pos, p.pos) > MAX_PASS) continue;            // out of range
      if (game.frontT && game.attackSign(h.team) * p.pos.z < 0.4) continue; // backcourt
      if (game.nearestDefenderDist(p) < 2.0) continue;          // not actually open
      if (game.doubleTeamed(p) || p.trappedT > 0) continue;      // never swing back into a (recent) trap
      if (p.justPassedT > 0) continue;                           // he just gave it up — no ping-pong
      if (laneVetoed(game.oppTeam(h), h, p) || passRisk(game.oppTeam(h), h, p) > 0.25) continue; // レーン無し
      bestPrio = p.offPriority;
      best = p;
    }
    return best;
  }

  // A poor ball-handler (low D精度) who is MARKED can't advance the dribble — he
  // may only keep it. True in the frontcourt, when a defender is on him, with
  // enough clock that he isn't forced to gamble. (Bring-up and a dying clock are
  // exempt; so is a clean handle.)
export function mustKeepDribble(game: Game, h: Player, dDef: number): boolean {
    if (!game.frontT) return false;                          // bring-up handled elsewhere
    if (dDef > 1.8) return false;                            // nobody on him → dribble freely
    if (game.shotClock < 4) return false;                    // clock dying → must try to score
    return rate(h.attr.dribbleAcc) < KEEP_DRIBBLE_THRESH;    // only a genuinely poor handle
  }

  // KEEP-ONLY reads for a marked poor handler: give it to a team-mate who came to
  // help, inch forward, or just hold and shield. No crossover / blow-by / post grind.
export function keepDribbleDecide(game: Game, h: Player, dHoop: number, dDef: number, rimFloor: Vector3): void {
    // right at the rim with a crack of space → still lay it in (never refuse a bunny)
    if (dHoop < 2.0 && dDef > 0.85) { finishAtRim(game, h, dDef); return; }
    // HELP HAS COME → give it up immediately (the release valve the offence wants)
    if (pass(game, h)) return;
    // otherwise KEEP: mostly hold & shield, occasionally inch toward the rim (じりじり)
    if (chance(0.3) && dHoop > 1.9) {
      game.setDrive(h, rimFloor, Math.max(1.7, dHoop - 0.5));  // a slow, protected step in
    } else {
      game.setDrive(h, rimFloor, dHoop);                       // hold: target ≈ here → no advance
    }
    h.keepShieldT = 0.5;   // throttle the dribble to a crawl + angle the body (movement + facing)
  }

  // A big backs his man down: drive straight at the rim (no crossover/feint).
  // How fast he gets there — and whether he bulls the defender backward — is the
  // strength battle resolved in runOffense and the collision step.
export function postMove(game: Game, h: Player): void {
    const rim = game.attackFloor(h.team);
    h.driveTarget.set(rim.x, 0, rim.z);
  }

  // Hand the ball off to a guard bringing it up: only when he's a realistic
  // outlet (in range and not smothered — he's come back toward the ball, so with
  // the defence ahead in transition this usually lands).
export function outletTo(game: Game, h: Player, g: Player): boolean {
    if (dist2D(h.pos, g.pos) > MAX_PASS) return false;
    if (game.nearestDefenderDist(g) < 1.2) return false;   // still covered — wait
    return passToReceiver(game, h, g);
  }

  // No guard is open for the outlet yet — the big keeps carrying it up toward the
  // top of the key rather than stalling short of halfway (which used to freeze him
  // right at the centre line). The outlet is re-checked every decision tick, so he
  // still hands off the instant a guard comes free; if none ever does, he brings it
  // up himself rather than getting stuck.
export function advanceSafely(game: Game, h: Player): void {
    // a big who ends up bringing it up also uses a side lane, not the middle
    if (!game.frontT) bringUpLane(game, h);
    else game.setDrive(h, game.attackFloor(h.team), 8);   // ~top of the key, in the frontcourt
  }

  // SOLVE THE TRAP WITH PASSING: the double-team leaves a man open — hit him. Only
  // force it to a GENUINELY OPEN team-mate through a lane that isn't dead-blocked
  // (no wild kick-outs into coverage that read as throw-aways). The forced pass
  // still skips the normal risk gate, so a skilled passer threads a tightish lane,
  // but a covered man / a body in the lane is never forced.
export function trapKickOut(game: Game, h: Player): boolean {
    let best: Player | null = null, bestScore = 0;
    let bestVet = false;
    for (const mate of game.teamPlayers(h.team)) {
      if (mate === h) continue;
      if (dist2D(h.pos, mate.pos) > MAX_PASS) continue;
      // don't kick out of one trap straight into another — skip a mate who is
      // (or was just) double-teamed himself
      if (game.doubleTeamed(mate) || mate.trappedT > 0) continue;
      const open = game.nearestDefenderDist(mate);
      if (open < 1.6) continue;                         // only a genuinely open man
      // a body dead in the lane no longer kills the option — the BOUNCE pass goes
      // under his hands — it just costs a little in the scoring
      const vet = laneVetoed(game.oppTeam(h), h, mate);
      const score = open - passRisk(game.oppTeam(h), h, mate) * 2 - (vet ? 0.6 : 0);
      if (score > bestScore) { bestScore = score; best = mate; bestVet = vet; }
    }
    if (!best) return false;
    if (bestVet || chance(0.25)) {
      // 頭上のレーンが塞がれている(または気まぐれに) → バウンドパス:
      // トラッパーの手の下を突き、床で一つ跳ねて味方の手元へ
      return passToReceiver(game, h, best, true, "bounce");
    }
    // 頭上が使える → 本物のジャンプパス: ダンク級に跳び、最高点から頭上を越す
    h.jump(0.5, 0.6);
    game.pendingPassTo = best;
    game.pendingPassT = 0.22;
    return true;
  }

  // EVADE THE TRAP: retreat-dribble to open floor to break the double-team and
  // open a passing angle, instead of standing in it. NOT simply "away from the
  // defenders": for a handler herded into a corner that direction points OUT OF
  // BOUNDS, and the court clamp then pins him on the corner exactly as the trap
  // wants — the classic 角で固められる. Instead sample legal headings and take
  // the one that actually gains separation while staying on the floor (biased
  // a touch toward the middle / up-court, where his outlets live).
export function retreatFromTrap(game: Game, h: Player): void {
    const defs = game.teamPlayers(1 - h.team).slice()
      .sort((a, b) => dist2D(a.pos, h.pos) - dist2D(b.pos, h.pos));
    const a = defs[0], b2 = defs[1] ?? defs[0];
    const s = game.attackSign(h.team);
    let bx = 0, bz = game.frontT ? s * 2 : 0;   // fallback: head for centre floor
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const ang = (i / 12) * Math.PI * 2;
      const tx = h.pos.x + Math.cos(ang) * 3.0;
      const tz = h.pos.z + Math.sin(ang) * 3.0;
      if (Math.abs(tx) > COURT.halfW - 0.7 || Math.abs(tz) > COURT.halfL - 0.7) continue;
      if (game.frontT && s * tz < 0.5) continue;   // never retreat into a backcourt violation
      const sep = Math.min(dist2DTo(a.pos, tx, tz), dist2DTo(b2.pos, tx, tz));
      let score = sep - Math.abs(tx) * 0.08;       // slight pull off the sideline
      if (!game.frontT) score += s * (tz - h.pos.z) * 0.10;   // bringing it up: prefer forward escapes
      if (score > bestScore) { bestScore = score; bx = tx; bz = tz; }
    }
    h.driveTarget.set(bx, 0, bz);
  }

  // FAST BREAK: the handler pushes the ball hard at the rim before the defence
  // gets set. If a wing has beaten his man down the floor and is open near the
  // rim, hit him for the layup instead. SPEED / 加速力 (how fast the handler
  // covers ground and the runners fill the lanes) decide whether it lands.
export function pushBreak(game: Game, h: Player, dHoop: number): void {
    // ahead-of-the-ball runner open at the rim → drop it off
    const rim = game.attackFloor(h.team);
    let best: Player | null = null, bestGap = 1.6;
    for (const p of game.teamPlayers(h.team)) {
      if (p === h) continue;
      const dRim = dist2D(p.pos, rim);
      const ahead = game.attackSign(h.team) * (p.pos.z - h.pos.z) > 1.5;
      if (ahead && dRim < 4.5) {
        const g = game.nearestDefenderDist(p);
        if (g > bestGap) { bestGap = g; best = p; }
      }
    }
    if (best && dHoop > 3 && passToReceiver(game, h, best)) return;
    // otherwise attack the rim himself (a beaten defender behind him can't stop it)
    if (dHoop < 1.9) { finishAtRim(game, h, game.nearestDefenderDist(h)); return; }
    game.setDrive(h, rim, 1.5);
  }

  // Whether the handler is in a spot to take his man off the dribble: close
  // enough to drive on, in the frontcourt, and with time on the clock. No point
  // isolating from 20 feet out or with the shot clock about to expire.
export function canIso(game: Game, h: Player, dHoop: number): boolean {
    if (dHoop > 9 || dHoop < 1.8) return false;
    if (game.shotClock < 3) return false;
    if (game.frontT && game.attackSign(h.team) * h.pos.z < 0.4) return false; // backcourt
    return true;
  }

  // The heart of the 1-on-1: choose which way to attack, throw in the odd
  // crossover, and blow by when the defender is caught leaning the wrong way.
  // The 1-on-1 read: a dribble move that tries to shift the defender's weight
  // (his centre of gravity) the wrong way with a fake, then attacks the opening.
  // A high-handle, quick creator sells the move and turns the corner far more
  // often; a disciplined, quick-footed defender bites less and stays in front.
export function driveDecision(game: Game, h: Player): void {
    const d = game.onBallDefender(h);
    if (!d) {
      // nobody in front — just pick a side and go straight in
      h.comboN = 0;
      h.driveSide = game.pickSide(h);
      h.beatenT = Math.max(h.beatenT, rand(0.4, 0.7));
      game.setDriveSide(h);
      return;
    }
    d.reactT = reactionLag(d);    // any move forces a reaction

    // TWO ways to beat your man off the dribble, and a player attacks the way his
    // tools (and the matchup) favour:
    //  • SPEED — a crossover that shifts the defender's weight, then turn the corner
    //  • POWER — lower the shoulder and bull him back toward the rim
    // NOTE: the defender's containment weighs MORE than the handler's creation,
    // so a quick, high-IQ defender wins the neutral matchup — good on-ball defence
    // actually stops penetration instead of every drive being a coin flip.
    // The defender's containment weighs MORE than the handler's creation (see
    // below); a good on-ball defender should genuinely stop penetration.
    const speedEdge = rate(h.attr.handling) * 0.45 + rate(h.attr.agility) * 0.35
      + rate(h.attr.dribbleAcc) * 0.2 + (h.has("driver") ? 0.1 : 0)
      - (rate(d.attr.agility) * 0.62 + rate(d.attr.reaction) * 0.4
        + rate(d.attr.defense) * 0.55 + (d.has("manMark") ? 0.12 : 0));   // 守判断を増強(基準は pBeat 側で再センタ)
    // POWER is a physical battle — but it still takes HANDLE to keep the ball on
    // a string while bulling in; a strong but clumsy player (a defender-type big
    // with low 技術/D精度) can't just steamroll to the rim. The defender resists
    // mostly with ボディバランス (raw strength) plus 守判断.
    const powerEdge = rate(h.attr.balance) * 0.55 + rate(h.attr.aggression) * 0.2
      + rate(h.attr.dribbleAcc) * 0.2 + rate(h.attr.handling) * 0.15 + (h.has("post") ? 0.15 : 0)
      - (rate(d.attr.balance) * 1.05 + rate(d.attr.defense) * 0.60);   // 守判断を増強(基準は pPower 側で再センタ)

    // a player's OWN tools set his style first: a strong, physical player (high
    // ボディバランス, aggressive) bullies his way in; a quick, high-handle player
    // (敏捷性/技術) crosses over. The matchup then nudges it — attack whichever the
    // defender is weaker against.
    const ownPower = rate(h.attr.balance) + rate(h.attr.aggression) * 0.5 + (h.has("post") ? 0.4 : 0);
    const ownSpeed = rate(h.attr.agility) + rate(h.attr.handling) * 0.7 + (h.has("driver") ? 0.4 : 0);
    const usePower = h.comboN === 0 && chance(clamp(0.5 + (ownPower - ownSpeed) * 0.6
      + (powerEdge - speedEdge) * 0.5, 0.08, 0.92));   // mid-combo he stays with the rock

    if (usePower) {
      // POWER: shoulder into the defender. Win the strength battle and he drives
      // the man back to the rim; lose it and he's walled off and must reset.
      h.driveSide = d.shadeSide !== 0 ? -d.shadeSide : game.pickSide(h);
      const pPower = clamp(0.53 + powerEdge * 1.25, 0.03, 0.9);   // +0.13 = 守判断重み増のフラット70補償
      if (chance(pPower)) {
        h.powerT = rand(0.55, 0.9) * (1 + Math.max(0, powerEdge) * 0.4);
        d.lean = clamp(d.lean * 0.4, -1, 1);             // knocked off his base
      } else {
        h.stalledT = rand(0.35, 0.6);                    // met the wall
      }
      game.setDriveSide(h);
      return;
    }

    // SPEED: shake the defender with a dribble move, then attack the opening.
    // 敏捷性(quickness) + D精度(dribble control) drive the deception; the defender
    // resists with 守判断(defense) + quickness/反応(burst). The move he uses
    // depends on how the defender is playing him.
    const jukeEdge = jukeDeception(h) - jukeDiscipline(d);
    const rim = game.attackFloor(h.team);
    const rl = Math.hypot(rim.x - h.pos.x, rim.z - h.pos.z) || 1;
    const ux = (rim.x - h.pos.x) / rl, uz = (rim.z - h.pos.z) / rl;   // toward rim
    const latx = -uz, latz = ux;                                      // lateral

    // fresh attack → plan the rock: a skilled handler strings 1..3 moves. The
    // early shakes are pure 揺さぶり — they only swing the defender's weight —
    // and only the LAST move attacks, bursting past the side he can no longer
    // recover to. A quick defender resets between shakes; a slow one rocks
    // further off balance with every swing.
    if (h.comboN === 0) {
      h.lastFakeDir = 0;
      let plan = 1;
      const pMore = clamp(0.25 + jukeDeception(h) * 0.55, 0.1, 0.8);
      if (chance(pMore)) plan++;
      if (plan > 1 && chance(pMore * 0.6)) plan++;
      h.comboN = plan;
    }
    const finalShake = h.comboN <= 1;

    // shake the fronting defender: a jab step-in to freeze him, or a hard
    // side-step to drag him one way and attack back the other. Setup shakes
    // ALTERNATE sides to swing his weight; the FINAL move reads his actual
    // lean — one more sell INTO it, then burst past the side he can't recover to.
    const stepIn = h.lastFakeDir === 0 && finalShake && chance(0.35);
    let fakeDir: number;
    if (finalShake) {
      // the GO side = the defender's lean read WEIGHTED BY THE HAND: a
      // one-handed player (低逆手頻度) stays on his strong side unless the
      // weak-side lane is clearly the better read; an ambidextrous handler
      // just takes whatever the lean gives him
      const strong = h.strongSide();
      const beat = (side: number) => clamp(-d.lean * side, -1, 1);
      // scaled so a ROUTINE shade (lean ≈0.3) doesn't pry a one-handed player
      // off his strong hand — only a clear overplay does
      const handEdge = (h.strongSideBias() - 0.5) * 3.2;   // 0 (both hands) .. ~0.65
      const go = beat(strong) + handEdge >= beat(-strong) ? strong : -strong;
      fakeDir = -go;                       // sell the other way, then attack it
    } else {
      fakeDir = h.lastFakeDir !== 0 ? -h.lastFakeDir : -game.pickSide(h);
    }
    let ox: number, oz: number, leanMag: number;
    if (stepIn) {
      ox = ux * 0.35; oz = uz * 0.35; leanMag = 0.7;               // jab toward the rim
      d.reactT = Math.max(d.reactT, reactionLag(d)); // he hesitates
    } else {
      ox = latx * fakeDir * 0.45; oz = latz * fakeDir * 0.45; leanMag = 1.1; // side-step
    }
    h.jukeT = rand(0.18, 0.3);
    h.jukeTarget.set(h.pos.x + ox, 0, h.pos.z + oz);
    game.clampCourt(h.jukeTarget);

    // does he bite? deception vs discipline sets how far his weight shifts
    const bite = clamp(0.3 + jukeEdge * 1.1, 0.03, 0.95);
    if (chance(bite)) {
      // if his weight is still ACROSS from the previous fake, the swing back
      // overshoots — this is what stacks the lean up on a slow-recovering
      // defender while a quick one is square again before each move lands
      const across = Math.max(0, -d.lean * fakeDir);
      d.lean = clamp(d.lean + fakeDir * (rand(0.5, 1.0) * leanMag + across * 0.8), -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;   // committed on THIS duel's axis
    }

    if (!finalShake) {
      // setup shake only — stay live, the next move comes back the other way
      h.comboN--;
      h.lastFakeDir = fakeDir;
      return;
    }

    // the GO move: attack away from the final fake, at the side his committed
    // weight can't recover to
    h.comboN = 0;
    const go = -fakeDir;
    h.driveSide = go;
    // (base lowered when the GO move learned to read the lean — keeps the
    // overall blow-by rate at the previously tuned level)
    const wrongWay = clamp(-d.lean * go, 0, 1);
    const pBeat = clamp(0.49 + speedEdge * 1.2 + wrongWay * 0.45, 0.02, 0.95);   // +0.11 = 守判断重み増のフラット70補償
    if (chance(pBeat)) {
      // the burst carries ALL THE WAY to the rim — a blow-by that dies at the
      // free-throw line isn't a blow-by. Time is scaled to the ground the
      // handler actually has to cover (≈7.5 m/s burst pace).
      h.beatenT = clamp(rl / 7.5, 0.5, 1.3) * rand(0.95, 1.15)
        * (1 + Math.max(0, speedEdge) * 0.2);
      d.reactT = Math.max(d.reactT, reactionLag(d));
      // momentum carries him further wrong — and with his weight committed the
      // wrong way, the chase back (leanFactor) starts at a crawl
      d.lean = clamp(d.lean + go * 0.3, -1, 1);
      d.leanAxisX = latx; d.leanAxisZ = latz;
    } else {
      h.stalledT = rand(0.3, 0.55);
    }
    game.setDriveSide(h);
  }

  // How well a handler sells a dribble move — quickness + dribble control lead.
  // STEP-BACK: retreat off the dribble against a defender contesting a shot. If he
  // over-commits forward (bites the shot fake) the handler blows by him off the
  // step; if he stays down, the handler has bought clean separation for a jumper.
  // Baiting the closeout scales with the handler's shot threat + deception; the
  // defender resists with discipline.
export function stepBack(game: Game, h: Player, d: Player, dHoop: number): void {
    const rim = game.attackFloor(h.team);
    const bx = h.pos.x - rim.x, bz = h.pos.z - rim.z;     // away from the rim
    const bl = Math.hypot(bx, bz) || 1;
    h.jukeT = rand(0.2, 0.32);
    h.jukeTarget.set(h.pos.x + (bx / bl) * 0.7, 0, h.pos.z + (bz / bl) * 0.7);
    game.clampCourt(h.jukeTarget);

    const shotThreat = Math.max(rate(h.attr.threeAcc), rate(h.attr.midAcc));
    const edge = jukeDeception(h) - jukeDiscipline(d);
    const bait = clamp(0.2 + edge * 0.5 + shotThreat * 0.25, 0.05, 0.82);
    if (chance(bait)) {
      // he lunged forward → attack past him off the step-back (burst carries
      // to the rim, like any blow-by)
      h.beatenT = clamp(dHoop / 7.5, 0.5, 1.3) * rand(0.95, 1.15)
        * (1 + Math.max(0, edge) * 0.2);
      d.reactT = Math.max(d.reactT, reactionLag(d));
      d.lean = clamp(d.lean * 0.5, -1, 1);
      h.driveSide = game.pickSide(h);
      game.setDriveSide(h);                              // the burst goes at the rim
    } else {
      // stayed down → the step-back bought a cushion; hold it for the jumper and
      // let the next decision fire the (now open) look
      d.reactT = Math.max(d.reactT, reactionLag(d));
      h.driveTarget.copyFrom(h.jukeTarget);
    }
  }

  // A defender within ~1.2 m ahead and squarely in the drive path; their body
  // contact is what slows the ball-handler down.
export function driveImpeder(game: Game, h: Player): Player | null {
    const tx = h.driveTarget.x - h.pos.x, tz = h.driveTarget.z - h.pos.z;
    const len = Math.hypot(tx, tz) || 1;
    const ux = tx / len, uz = tz / len;
    for (const d of game.teamPlayers(1 - h.team)) {
      const rx = d.pos.x - h.pos.x, rz = d.pos.z - h.pos.z;
      const along = rx * ux + rz * uz;       // how far ahead along the drive
      if (along < 0 || along > 1.2) continue;
      const perp = Math.abs(rx * -uz + rz * ux);
      if (perp < 0.7) return d;
    }
    return null;
  }

  // True if the path from the handler to the rim is free of defenders.
export function laneClear(game: Game, h: Player, rimFloor: Vector3): boolean {
    const ax = h.pos.x, az = h.pos.z;
    const dx = rimFloor.x - ax, dz = rimFloor.z - az;
    const len2 = dx * dx + dz * dz || 1;
    for (const d of game.teamPlayers(1 - h.team)) {
      const t = ((d.pos.x - ax) * dx + (d.pos.z - az) * dz) / len2;
      if (t <= 0.05 || t >= 1) continue;             // not between handler and rim
      const px = ax + dx * t, pz = az + dz * t;
      if (Math.hypot(d.pos.x - px, d.pos.z - pz) < 1.1) return false; // defender in the lane
    }
    return true;
  }
