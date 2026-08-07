// ルーズボール物理。自由球の飛翔・反射、選手の追走、接触判定、確保(secureLoose)を集約。
import { Player } from "../objects/player/player";
import { COURT, SHOT_CLOCK, OOB_WALL } from "../config";
import { rate, clamp, chance, dist2DTo, moveToward2D, rand, nearestOf } from "../util";
import { twoHandedCatch } from "../move/reaction/rebound";
import { stepBallFlight } from "../move/basic/ball";
import { flashBall } from "./visuals";
import { twoHandGrab } from "./poses";
import type { Game } from "../game";

// 空中リバウンド確保をプットバックにするリムまでの距離(m)。ダンク/レイアップが打てる至近のみ。
// これを超える(距離が離れている)とプットバックせず、アウトレット/キック→着地して通常オフェンス。
const PUTBACK_RANGE = 2.0;
// ボールの重力(move/basic/ball.ts の BALL.gravity と同じ)。上げ直しの初速を解くのに使う。
const BALL_G = 9.0;

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
    contestShove(game, dt);   // 競り合いの押し合い: バランスで弱い方を中心からずらす
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
      // 最寄りが遠い間はボールを手元へワープさせない: 追走を続けさせ(chaseLoose が最寄りを寄せる)、
      // 届いた選手が resolveLooseContact(0.6m)で確保する。長く誰も届かない時だけ最後の手段で確保。
      if (dist2DTo(game.ball.pos, near.pos.x, near.pos.z) > 1.2 && game.looseAge < 6) {
        game.looseT = 0.4;   // 安全網を延長して追走を継続(ワープ回避)
        return;
      }
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
        // 争っていない → 攻めの定位置へ流れて備える。ただし攻撃性が高いほど先行(先走り)、低い選手は
        // 確保が決まるまで先走らず備える(相手ボールになった時に守れる=まだ相手攻撃中に攻めへ行かない)。
        const eager = clamp((rate(p.attr.aggression) - 0.55) / 0.40, 0, 1);   // 攻撃性95→現状, 低→遅い
        const spot = game.formationSpots(p.team)[p.slot];
        moveToward2D(p.pos, spot.x, spot.z, p.accelSpeed(dt, 0.25 + eager * 0.6) * dt);
        game.clampCourt(p.pos);
      }
    }
  }

  // 競り合いの押し合い: ボール至近で相手と体が重なったら、ボディバランス差で弱い方を
  // ボール中心から外へずらす（強い方は踏みとどまり確保に近づく）。接触点でのボックスアウト。
  const SHOVE_RATE = 1.5;   // 最大バランス差での押し退け速度(m/s)
export function contestShove(game: Game, dt: number): void {
    const b = game.ball.pos;
    const near = game.players.filter((p) => dist2DTo(b, p.pos.x, p.pos.z) < 1.6);
    for (const p of near) {
      // 最も近い相手（体が重なる距離のみ）
      let q: Player | null = null, qd = 0.85;
      for (const o of near) {
        if (o.team === p.team) continue;
        const dd = dist2DTo(o.pos, p.pos.x, p.pos.z);
        if (dd < qd) { qd = dd; q = o; }
      }
      if (!q) continue;
      const edge = clamp(rate(q.attr.balance) - rate(p.attr.balance), 0, 0.6);  // 相手が強い分だけ押される
      if (edge <= 0) continue;
      const rx = p.pos.x - b.x, rz = p.pos.z - b.z;                              // ボール中心から外向き
      const rl = Math.hypot(rx, rz) || 1;
      const push = edge * SHOVE_RATE * dt;
      p.pos.x += (rx / rl) * push;
      p.pos.z += (rz / rl) * push;
      game.clampCourt(p.pos);
    }
  }

  // ボールに手を掛けられる最も好位置の選手が接触する。
export function resolveLooseContact(game: Game, ): void {
    let best: Player | null = null;
    let bestReach = -Infinity;
    const reachers: Player[] = [];
    for (const p of game.players) {
      if (p.touchCool > 0) continue;
      if (p.looseReactT > 0) continue;   // まだ反応していない
      if (dist2DTo(game.ball.pos, p.pos.x, p.pos.z) > 0.6) continue;
      const top = p.reachTopY();
      if (game.ball.pos.y > top || game.ball.pos.y < 0.3) continue; // 高すぎ／低すぎて届かない
      reachers.push(p);
      if (top > bestReach) { bestReach = top; best = p; }
    }
    if (!best) return;
    // 競り: best 以外に同じボールへ手が届く相手がいれば競り合い(崩れて弾く)
    const contested = reachers.some((q) => q !== best && q.team !== best!.team);
    contactLooseBall(game, best, contested);
  }

  // 手がボールに届く: 好位置で両手が添えば確保（キャッチ）、崩れ（伸び切り/横/競り）は
  // タップ（軌道をはじく）。何度もはじき続けたら確保させ、ピンボール化を防ぐ。
export function contactLooseBall(game: Game, p: Player, contested: boolean): void {
    game.lastTouch = p;   // 手が触れた — 以後のアウトオブバウンズを決める
    const horiz = dist2DTo(game.ball.pos, p.pos.x, p.pos.z);
    if (twoHandedCatch(p, game.ball.pos.y, horiz, contested)) {
      secureLoose(game, p);
      return;
    }
    if (game.looseTips >= 3) { secureLoose(game, p); return; }   // ピンボール化させない
    game.looseTips++;
    flashBall(game, "tip", p.team);   // はたいた側の色（消えたらルーズの白へ戻る）
    // 自分の真上へ上げ直す（タップ・トゥ・セルフ）。競り合いで弾かれ続けて
    // ボールがすぐ場外へ流れるのを防ぐ。バランスと反応が高いほど成功しやすい。
    const ctl = 0.20 + rate(p.attr.balance) * 0.40 + rate(p.attr.reaction) * 0.25
      - (contested ? 0.30 : 0);
    if (chance(clamp(ctl, 0.05, 0.85))) {
      const vy = rand(3.6, 4.4);                       // 滞空 ~0.8-1.0秒（次のジャンプに間に合う）
      const t = vy / BALL_G;                           // 頂点までの時間
      // 頂点が自分の頭上へ来るように水平成分を決める（少し前へ落として取りやすく）
      const b = game.ball.pos;
      game.ball.vel.set((p.pos.x - b.x) / t, vy, (p.pos.z - b.z) / t);
      p.touchCool = 0.40;                              // 上げた直後に自分で触り直さない
      p.jump(0.35, 0.4);
      game.setEvent("TIP", p.team);
      return;
    }
    // 制御できなかった: 従来どおり上へ、外へはじく
    p.touchCool = 0.22;
    const a = rand(0, Math.PI * 2);
    game.ball.vel.set(Math.cos(a) * rand(0.6, 1.9), rand(2.4, 3.8), Math.sin(a) * rand(0.6, 1.9));
    p.jump(0.4, 0.45);
    game.setEvent("TIP", p.team);
  }

  // 選手がルーズボールを確保して着地し、プレイが再開する。
export function secureLoose(game: Game, p: Player, label?: string): void {
    game.lastTouch = p;
    // 掴んだ手の数を確定させる(画面に出ていた形と同じ判定)。この後の保持ポーズと
    // アウトレットの投げ方をここへ揃える。
    p.grabTwoHand = twoHandGrab(game, p, game.ball.pos);
    const offensive = p.team === game.looseOff;
    if (game.looseIsRebound) p.stats.reb++;   // ミスショットからのリバウンドだけを数える
    if (!offensive && game.looseStealBy) {    // 守備がはたき落としたボールを確保した
      game.looseStealBy.stats.stl++;          // スティールははたき出した者に記録
      if (game.looseStealVictim) game.looseStealVictim.stats.tov++;
    }
    game.looseStealBy = game.looseStealVictim = null;
    game.handler = p;
    flashBall(game, "secure", p.team);   // 確保した側の色
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
    // 空中でリバウンドを掴んだ: 着地を待たず、次tickでそのままプットバック/アウトレットへ。
    // オフェンスリバウンドかつリム至近ならプットバック、それ以外はアウトレット/キック。
    if (game.looseIsRebound && p.airborne && game.ball.pos.y >= 1.2) {
      const rimF = game.attackFloor(p.team);
      p.reboundGo = true;
      // 落ち際で掴んだ球は押し込めない(滞空が残っていないと一瞬で放り上げる形になる)
      p.reboundPutback = offensive && dist2DTo(p.pos, rimF.x, rimF.z) < PUTBACK_RANGE
        && p.jumpRemaining > 0.25;
    }
    // 確保: ボールを瞬間移動させず、今ある位置を起点に手元へ地続きで収める。
    // 起点を記録し、liveball の pickup が実位置→手元へ補間する(高い球=降ろす/横=引き寄せる/
    // 床=すくい上げ)。距離が遠い/高いほど収めに少し時間をかける。空中プットバック/アウトレット
    // (reboundGo)は次tickでシュート/パスへ移り pickup は消費されない(不成立で着地時のみ効く)。
    p.grabFromX = game.ball.pos.x;
    p.grabFromY = game.ball.pos.y;
    p.grabFromZ = game.ball.pos.z;
    {
      const gdx = game.ball.pos.x - p.pos.x, gdz = game.ball.pos.z - p.pos.z;
      const gd3 = Math.hypot(gdx, gdz, game.ball.pos.y - 0.95);
      // 床際のボールはしゃがんですくい上げるぶん時間がかかる(low=1 が床、0 が手元の高さ)。
      const low = clamp((0.95 - game.ball.pos.y) / 0.75, 0, 1);
      // 技術(handling)で短縮。10 → 約1.3倍、99 → 約0.7倍。
      const tech = 1.32 - rate(p.attr.handling) * 0.66;
      p.pickupT = p.pickupDur = clamp((0.18 + gd3 * 0.12 + low * 0.34) * tech, 0.14, 0.9);
    }
    // 拾い終わるまでは次の判断へ行かない(すくい上げ中に撃たない)
    p.decisionT = Math.max(p.decisionT, p.pickupDur);
    game.setEvent(label ?? (offensive ? "OFF. REBOUND" : "REBOUND"), p.team);
  }
