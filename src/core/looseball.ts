// ルーズボール物理（方式B: GameState 集約）。空中/地面を転がる自由球の飛翔・反射、
// 選手の追走、接触判定、確保(secureLoose)までを関数として集約。エントリ点である
// goLoose/startRebound/leakOut/crashBoards は多所から使うため Game 残置。
import { Player } from "../objects/player/player";
import { COURT, SHOT_CLOCK, SHOT_CLOCK_PARTIAL } from "../config";
import { dist2DTo, moveToward2D, chance, rand } from "../util";
import { looseSecureChance } from "../reaction/rebound";
import { rate } from "../attributes";
import type { Game } from "../game";

  // ボールの自由飛翔の1フレーム: 重力、少しエネルギーを残す床バウンド（本物の
  // バスケットボールのように弾んで静止する）、そしてコート境界での反射。ルーズボールと、
  // 得点後の演出的な落下で共有する。`restY` は床接触の高さ（ボール半径）。
export function stepBallFreeFlight(game: Game, dt: number, reflect = true): void {
    const b = game.ball;
    b.vel.y -= 9.0 * dt;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // 床で弾んでエネルギーを失う（転がって静止するドリブル）
    if (b.pos.y < 0.12) { b.pos.y = 0.12; b.vel.y = Math.abs(b.vel.y) * 0.62; b.vel.x *= 0.72; b.vel.z *= 0.72; }
    // コート境界で反射させてインプレーに保つ — ただし生きたルーズボール
    // (reflect = false) はラインを越えることを許され、アウトオブバウンズになって
    // スローインになれる（updateLoose が越えを検出する）。
    if (reflect) {
      const mw = COURT.halfW - 0.1, ml = COURT.halfL - 0.1;
      if (b.pos.x < -mw) { b.pos.x = -mw; b.vel.x = Math.abs(b.vel.x) * 0.6; }
      if (b.pos.x > mw) { b.pos.x = mw; b.vel.x = -Math.abs(b.vel.x) * 0.6; }
      if (b.pos.z < -ml) { b.pos.z = -ml; b.vel.z = Math.abs(b.vel.z) * 0.6; }
      if (b.pos.z > ml) { b.pos.z = ml; b.vel.z = -Math.abs(b.vel.z) * 0.6; }
    }
    // 速度をクランプして、悪いバウンドでも飛んでいかないようにする（決定論的に保つ）
    const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    if (sp > 10) { const k = 10 / sp; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }
  }

export function updateLoose(game: Game, dt: number): void {
    if (game.blockHoldT > 0) {
      // ブロック接触: はたかれたボールはブロッカーの手の上で一拍ぴたりと止まり、
      // ヒットが見えるようにしてから、はじく速度が解放される。
      game.blockHoldT -= dt;
      if (game.blockHoldT <= 0) game.ball.vel.copyFrom(game.blockHoldVel);
    } else {
      stepBallFreeFlight(game, dt, false);   // 生きたルーズボールはラインを越えることがある
      // アウトオブバウンズ → 最後に触っていないチームのスローイン（例えば守備者の
      // 手からはたき出されたブロックはオフェンスのボールのまま）。
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
    // 確保を一拍遅らせ、スティール／はじきが本物の争奪として見えるようにする
    if (game.looseAge >= game.looseGrabAfter) resolveLooseContact(game);
    if (game.ballMode !== "loose") return;   // このフレームで誰かが確保した

    game.looseT -= dt;
    if (game.looseT <= 0) {                    // 安全網: 最も近い選手がボールを確保する
      let near = game.players[0];
      for (const p of game.players) {
        if (dist2DTo(game.ball.pos, p.pos.x, p.pos.z) < dist2DTo(game.ball.pos, near.pos.x, near.pos.z)) near = p;
      }
      secureLoose(game, near);
    }
  }

  // ルーズボールを実際に争うのは数人だけ。残りは全員が団子になるのでなく、次のプレイに
  // 備えて広がる。争う者: 各チームの最も近い者（だから本物の争いになる）、加えて本当に
  // 近い者を足し、合計3人までに制限する。
export function chaseLoose(game: Game, dt: number): void {
    const bx = game.ball.pos.x, bz = game.ball.pos.z;
    const distToBall = (p: Player) => dist2DTo(p.pos, bx, bz);

    // 各選手のルーズボールへの反応遅延を減らす
    for (const p of game.players) if (p.looseReactT > 0) p.looseReactT -= dt;

    const contest = new Set<Player>();
    if (game.looseFromTip) {
      // 開始タップ: タップは特定のガードを狙っている — 彼に確保させ、最も近い相手
      // 1人だけが挑む。それ以外は全員、10人がセンターのボールに群がるのでなく所定の
      // 位置へ離れる（団子回避）。
      contest.add(game.tipoff.guard);
      let opp: Player | null = null, od = Infinity;
      for (const p of game.teamPlayers(1 - game.tipoff.guard.team)) {
        const dd = distToBall(p); if (dd < od) { od = dd; opp = p; }
      }
      if (opp) contest.add(opp);
    } else {
      for (const team of [0, 1]) {                 // 各チームで最も近い者が行く
        let near = game.teamPlayers(team)[0];
        for (const p of game.teamPlayers(team)) if (distToBall(p) < distToBall(near)) near = p;
        contest.add(near);
      }
      const order = [...game.players].sort((a, b) => distToBall(a) - distToBall(b));
      for (const p of order) {                      // 3人まで足す。ただし本当に近い者だけ
        if (contest.size >= 3) break;
        if (!contest.has(p) && distToBall(p) < 2.5) contest.add(p);
      }
      // 専任のリバウンダーは届く限りの争奪すべてに飛び込む — ただし本物のリバウンド
      // （ミスショットからの）だけで、ティップオフやスティールは対象外。だからオープン
      // フロアのルーズボールが全ビッグを団子に吸い込まない。
      for (const p of game.players) {
        if (p.evalRole === "リバウンダー" && game.looseIsRebound && distToBall(p) < 7) contest.add(p);
      }
    }

    for (const p of game.players) {
      if (contest.has(p)) {
        // ボールがこぼれたことにまだ反応中 → まだ動き出していないので、反応の
        // 速い（反応が高い）相手が追走で先行する
        if (p.looseReactT > 0) continue;
        // 邪魔な体を避けてボールを追う — 争奪だからといって、誰かの背中を
        // まっすぐ突き抜けて走ってよいわけではない
        const cv = game.steerAround(p, bx, bz);
        moveToward2D(p.pos, cv.x, cv.z, p.accelSpeed(dt, game.isBig(p) ? 1.0 : 0.9) * dt);
        game.clampCourt(p.pos);
        // 空中に上がっていて1ストライド以内のボールに、跳躍のタイミングを合わせる
        if (!p.airborne && game.ball.pos.y > 1.7 && distToBall(p) < 1.3) {
          p.jump(0.55 + rate(p.attr.jump) * 0.45, 0.6);
        }
      } else {
        // 争っていない → スペーシングの位置へ流れ、次に何が来ても備える
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
      if (p.looseReactT > 0) continue;   // まだルーズボールに反応していない
      if (dist2DTo(game.ball.pos, p.pos.x, p.pos.z) > 0.6) continue;
      const top = p.reachTopY();
      if (game.ball.pos.y > top || game.ball.pos.y < 0.3) continue; // 高すぎ／低すぎて届かない
      if (top > bestReach) { bestReach = top; best = p; }
    }
    if (best) contactLooseBall(game, best);
  }

  // 手がボールに届く: 確保する（クリーンキャッチ）か、タップする（軌道をはじく）。
  // ジャンプ/反応/バランスと身長が確保の頻度を決める。守備者はボックスアウト(守判断)で
  // 優位を得る。数回タップが続くと次は確保が強制される。
export function contactLooseBall(game: Game, p: Player): void {
    game.lastTouch = p;   // ボールに手が触れた — 以後のアウトオブバウンズを決める
    // 確保確率は効果層(resolution/rebound)へ分離。抽選と確保/はじきの処理はここに残す。
    const defending = p.team !== game.looseOff;
    if (chance(looseSecureChance(p, defending, game.looseTips))) {
      secureLoose(game, p);
    } else {
      // タップ: ボールを上へ、外へはじく — 軌道が実際に変わる
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
      game.looseStealBy.stats.stl++;          // スティールははたき出した者に記録される
      if (game.looseStealVictim) game.looseStealVictim.stats.tov++;
    }
    game.looseStealBy = game.looseStealVictim = null;
    game.handler = p;
    game.possession = p.team;
    game.ballMode = "held";
    // ショットクロック: ポゼッション交代は完全リセット。リムに当たってのオフェンス
    // リバウンドは部分リセット。それ以外のオフェンスの確保（ブロックされたシュート、
    // はたき、ファンブル — リム接触なし）は、そのままクロックを走らせてプレイ続行。
    if (!offensive) game.shotClock = SHOT_CLOCK;
    else if (game.looseFromRim) game.shotClock = Math.max(game.shotClock, SHOT_CLOCK_PARTIAL);
    p.decisionT = 0.4;
    game.ball.vel.set(0, 0, 0);
    game.resetMotion();
    if (!offensive) game.maybeStartPush();   // ポゼッション交代 → 速攻を走らせる
    game.leakOut();          // ポゼッション交代で飛び出しランナーが走り出す
    // 手で拾い上げる（跳ねない）: ボールが床から持ち上がってキャリーへ入る短いすくい上げ。
    // 手はそれを下→上と追う（ドリブルキャリーの pickup 分岐を参照）。まだ空中にある
    // ボールはすくうのでなくキャッチする。
    if (game.ball.pos.y < 1.2) {
      p.pickupT = p.pickupDur = 0.35;
      game.ball.pos.set(p.pos.x, Math.max(0.22, game.ball.pos.y), p.pos.z);
    }
    game.setEvent(label ?? (offensive ? "OFF. REBOUND" : "REBOUND"), p.team);
  }
