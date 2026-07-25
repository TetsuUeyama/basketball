// ルーズボール物理。自由球の飛翔・反射、選手の追走、接触判定、確保(secureLoose)を集約。
import { Player } from "../objects/player/player";
import { COURT, SHOT_CLOCK, OOB_WALL } from "../config";
import { rate, dist2DTo, moveToward2D, chance, rand, nearestOf } from "../util";
import { looseSecureChance } from "../move/reaction/rebound";
import { stepBallFlight } from "../move/basic/ball";
import type { Game } from "../game";

  // ボール自由飛翔の1フレーム（物理は move/basic/ball.ts のベースに委譲）。
  // ルーズボールと得点後の落下演出で共有する。生きたルーズボール(reflect = false)は
  // ラインを越えてアウトオブバウンズになれる（updateLoose が越えを検出）。
export function stepBallFreeFlight(game: Game, dt: number, reflect = true): void {
    stepBallFlight(game.ball, dt, reflect);
  }

export function updateLoose(game: Game, dt: number): void {
    if (game.blockHoldT > 0) {
      // ブロック接触: はたかれたボールは一拍止まってから、はじく速度が解放される
      game.blockHoldT -= dt;
      if (game.blockHoldT <= 0) game.ball.vel.copyFrom(game.blockHoldVel);
    } else {
      stepBallFreeFlight(game, dt, false);   // 生きたルーズボールはラインを越えることがある
      // アウトオブバウンズ: ラインを越えても壁(エプロン外)までは軌道のまま飛ばし、
      // 壁に達したら最後に触っていないチームのスローインにする。
      const b = game.ball.pos;
      if (Math.abs(b.x) > COURT.halfW + OOB_WALL || Math.abs(b.z) > COURT.halfL + OOB_WALL) {
        const to = game.lastTouch ? 1 - game.lastTouch.team : 1 - game.looseOff;
        game.inbound.startAt(to, b.x, b.z);
        return;
      }
    }
    for (const p of game.players) if (p.touchCool > 0) p.touchCool = Math.max(0, p.touchCool - dt);

    game.looseAge += dt;
    chaseLoose(game, dt);
    // 確保を一拍遅らせ、争奪として見えるようにする
    if (game.looseAge >= game.looseGrabAfter) resolveLooseContact(game);
    if (game.ballMode !== "loose") return;   // このフレームで誰かが確保した

    game.looseT -= dt;
    if (game.looseT <= 0) {                    // 安全網
      const b = game.ball.pos;
      if (Math.abs(b.x) > COURT.halfW || Math.abs(b.z) > COURT.halfL) {
        // ラインの外（エプロン内）で止まった → スローイン
        const to = game.lastTouch ? 1 - game.lastTouch.team : 1 - game.looseOff;
        game.inbound.startAt(to, b.x, b.z);
        return;
      }
      const near = nearestOf(game.players, (p) => dist2DTo(game.ball.pos, p.pos.x, p.pos.z))!;
      secureLoose(game, near);
    }
  }

  // ルーズボールを争うのは数人だけ、残りは次に備えて広がる。争う者は各チームの最も
  // 近い者＋本当に近い者、合計3人まで。
export function chaseLoose(game: Game, dt: number): void {
    const bx = game.ball.pos.x, bz = game.ball.pos.z;
    const distToBall = (p: Player) => dist2DTo(p.pos, bx, bz);

    // 各選手のルーズボール反応遅延を減らす
    for (const p of game.players) if (p.looseReactT > 0) p.looseReactT -= dt;

    const contest = new Set<Player>();
    if (game.looseFromTip) {
      // 開始タップ: 狙われたガードに確保させ、最も近い相手1人だけが挑む。
      // それ以外は所定位置へ離れる（団子回避）。
      contest.add(game.tipoff.guard);
      const opp = nearestOf(game.teamPlayers(1 - game.tipoff.guard.team), distToBall);
      if (opp) contest.add(opp);
    } else {
      for (const team of [0, 1]) {                 // 各チームで最も近い者が行く
        contest.add(nearestOf(game.teamPlayers(team), distToBall)!);
      }
      const order = [...game.players].sort((a, b) => distToBall(a) - distToBall(b));
      for (const p of order) {                      // 3人まで足す。ただし本当に近い者だけ
        if (contest.size >= 3) break;
        if (!contest.has(p) && distToBall(p) < 2.5) contest.add(p);
      }
      // 専任リバウンダーは本物のリバウンド（ミスショット）の争奪だけに飛び込む。
      // ティップオフやスティールは対象外。
      for (const p of game.players) {
        if (p.evalRole === "リバウンダー" && game.looseIsRebound && distToBall(p) < 7) contest.add(p);
      }
    }

    for (const p of game.players) {
      if (contest.has(p)) {
        // まだ反応中 → 動き出していない（反応が速い相手が追走で先行する）
        if (p.looseReactT > 0) continue;
        // 邪魔な体を避けてボールを追う
        const cv = game.steerAround(p, bx, bz);
        moveToward2D(p.pos, cv.x, cv.z, p.accelSpeed(dt, game.isBig(p) ? 1.0 : 0.9) * dt);
        game.clampCourt(p.pos);
        // 上空1ストライド以内のボールに跳躍を合わせる
        if (!p.airborne && game.ball.pos.y > 1.7 && distToBall(p) < 1.3) {
          p.jump(0.55 + rate(p.attr.jump) * 0.45, 0.6);
        }
      } else {
        // 争っていない → スペーシングの位置へ流れて備える
        const spot = game.formationSpots(p.team)[p.slot];
        moveToward2D(p.pos, spot.x, spot.z, p.accelSpeed(dt, 0.8) * dt);
        game.clampCourt(p.pos);
      }
    }
  }

  // ボールに手を掛けられる最も好位置の選手が接触する。
export function resolveLooseContact(game: Game, ): void {
    let best: Player | null = null;
    let bestReach = -Infinity;
    for (const p of game.players) {
      if (p.touchCool > 0) continue;
      if (p.looseReactT > 0) continue;   // まだ反応していない
      if (dist2DTo(game.ball.pos, p.pos.x, p.pos.z) > 0.6) continue;
      const top = p.reachTopY();
      if (game.ball.pos.y > top || game.ball.pos.y < 0.3) continue; // 高すぎ／低すぎて届かない
      if (top > bestReach) { bestReach = top; best = p; }
    }
    if (best) contactLooseBall(game, best);
  }

  // 手がボールに届く: 確保する（キャッチ）か、タップする（軌道をはじく）。
export function contactLooseBall(game: Game, p: Player): void {
    game.lastTouch = p;   // 手が触れた — 以後のアウトオブバウンズを決める
    // 確保確率は reaction/rebound へ分離。抽選と確保/はじきの処理はここ。
    const defending = p.team !== game.looseOff;
    if (chance(looseSecureChance(p, defending, game.looseTips))) {
      secureLoose(game, p);
    } else {
      // タップ: ボールを上へ、外へはじく
      game.looseTips++;
      p.touchCool = 0.22;
      const a = rand(0, Math.PI * 2);
      game.ball.vel.set(Math.cos(a) * rand(0.6, 1.9), rand(2.4, 3.8), Math.sin(a) * rand(0.6, 1.9));
      p.jump(0.4, 0.45);
      game.setEvent("TIP", p.team);
    }
  }

  // 選手がルーズボールを確保して着地し、プレイが再開する。
export function secureLoose(game: Game, p: Player, label?: string): void {
    game.lastTouch = p;
    const offensive = p.team === game.looseOff;
    if (game.looseIsRebound) p.stats.reb++;   // ミスショットからのリバウンドだけを数える
    if (!offensive && game.looseStealBy) {    // 守備がはたき落としたボールを確保した
      game.looseStealBy.stats.stl++;          // スティールははたき出した者に記録
      if (game.looseStealVictim) game.looseStealVictim.stats.tov++;
    }
    game.looseStealBy = game.looseStealVictim = null;
    game.handler = p;
    game.possession = p.team;
    game.ballMode = "held";
    // ショットクロック: ポゼッション交代は完全リセット、リム接触のオフェンスリバウンドは
    // 部分リセット、それ以外のオフェンス確保はそのまま走らせる。
    if (!offensive) game.shotClock = SHOT_CLOCK;
    else if (game.looseFromRim) game.partialShotClock();
    p.decisionT = 0.4;
    game.ball.vel.set(0, 0, 0);
    game.resetMotion();
    if (!offensive) game.maybeStartPush();   // ポゼッション交代 → 速攻を走らせる
    game.leakOut();          // 飛び出しランナーが走り出す
    // 手で拾い上げる（跳ねない）: 床から持ち上げるすくい上げ。空中のボールはキャッチする。
    if (game.ball.pos.y < 1.2) {
      p.pickupT = p.pickupDur = 0.35;
      game.ball.pos.set(p.pos.x, Math.max(0.22, game.ball.pos.y), p.pos.z);
    }
    game.setEvent(label ?? (offensive ? "OFF. REBOUND" : "REBOUND"), p.team);
  }
