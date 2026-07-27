// オフボール移動・スペーシング。スクリーンは move/action/screen、トラップ救済等は Game 側のヘルパー。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { RIM, THREE_DIST, LANE_W } from "../config";
import { rate, clamp, chance, rand, dist2D, dist2DTo, moveToward2D, dirTo2D, segPerp } from "../util";
import { deepThreeOK } from "../eval";
import { laneBlock } from "../move/reaction/pass-risk";
import { countScreening, handlerPressured, goodScreener, setScreen, updateScreen } from "../move/action/screen";
import { tightlyTrapped, trapReliever, trapReliefSpot } from "./reads";
import type { Game } from "../game";

// オフボール全員の駆動: スポット確保、リムへのカット、ギブ&ゴー、オープンスポットへの
// ローテ、ボールから離れたスペーシング。
export function updateOffBallMotion(game: Game, dt: number, team: number, exclude: Player | null): void {
  const spots = game.formationSpots(team);
  const rim = game.attackFloor(team);
  for (const p of game.teamPlayers(team)) {
    if (p === exclude) continue;
    if (p.rooted) continue;   // パス/シュートのフォロースルー中 — 保持

    // スローイン後の前進(トラップ救済より優先): 非PMビッグの投げ手はバックコートに
    // 残らず、自分側のフロントコート(ローブロック)へ全力で抜ける。ガードが降りて組み立てる。
    if (p.frontRunT > 0) {
      if (game.frontT) { p.frontRunT = 0; }   // フロントコート確立で解除→通常のポスト play
      else {
        p.frontRunT = Math.max(0, p.frontRunT - dt);
        const s = game.attackSign(team);
        const side = p.pos.x >= 0 ? 1 : -1;
        const tx = side * 2.8, tz = s * RIM.z - s * 1.4;   // フォーメーションのローブロック相当
        moveToward2D(p.pos, tx, tz, p.accelToward(dt, tx, tz, 1.2) * dt);
        game.clampCourt(p.pos);
        p.cutting = false;
        continue;
      }
    }

    // トラップ救済(最優先): ハンドラーがダブルチーム時、味方1人がボールへフラッシュしアウトレットを作る。
    if (game.handler && game.handler !== p && tightlyTrapped(game, game.handler)
        && p === trapReliever(game, team)) {
      const t = trapReliefSpot(game, game.handler);
      moveToward2D(p.pos, t.x, t.z, p.accelToward(dt, t.x, t.z, 1.2) * dt);
      spacingNudge(game, dt, p, 1.6);
      game.clampCourt(p.pos);
      p.cutting = false;
      continue;
    }

    // 運び上げの支援: 最良の非ビッグ・ハンドラー候補(ガード)が常にハンドラーの近くへ
    // 降りて逃がし所を作る。プレス時はより近く。これで苦し紛れのパスもビッグでなくガードへ。
    if (!game.frontT && game.handler && game.handler !== p && dist2D(game.handler.pos, rim) > 9) {
      const outlet = game.teamPlayers(team)
        .filter((q) => q !== game.handler && !game.isBig(q) && q.frontRunT <= 0)
        .sort((a, b) => b.playmaking - a.playmaking)[0];
      if (p === outlet) {
        const s = game.attackSign(team);
        const bx = game.handler.pos.x, bz = game.handler.pos.z;
        const pressed = game.isBig(game.handler)
          || game.nearestDefenderDist(game.handler) < 1.7
          || laneBlock(game.oppTeam(game.handler), game.handler, p) !== null;
        // ハンドラーの逆サイド・ほぼ同じ高さに付いて安全な逃がし所を作る(スペーシング確保)。
        const sideX = bx >= 0 ? -1 : 1;
        const otx = sideX * (pressed ? 3.0 : 4.2);
        const otz = bz - s * (pressed ? 0.4 : 1.4);   // やや後方
        moveToward2D(p.pos, otx, otz, p.accelToward(dt, otx, otz, pressed ? 1.25 : 1.0) * dt);
        game.clampCourt(p.pos);
        continue;
      }
    }

    // レーンを埋める: 速攻でウィング(ハンドラー以外)が自分の側をリムへ走り込む。ビッグは後追い。
    if (game.pushT > 0 && game.handler && p !== game.handler && !game.isBig(p)) {
      const s = game.attackSign(team);
      const side = p.pos.x >= 0 ? 1 : -1;
      const fb = game.steerAround(p, side * 4.5, s * (RIM.z - 1.5));
      moveToward2D(p.pos, fb.x, fb.z, p.accelToward(dt, fb.x, fb.z, 1.25) * dt);
      game.clampCourt(p.pos);
      continue;
    }

    // 司令塔(とキープで時間を作るハンドラー)がチーム全体の再配置を速める
    let tick = game.teamHas(team, "general") ? 1.3 : 1;
    if (game.handler?.has("keepDribble")) tick *= 1.2;
    if (p.has("positioning")) tick *= 1.25;
    p.offTimer -= dt * tick;

    if (p.screening) {
      updateScreen(game, dt, p);
    } else if (p.cutting) {
      // カットに沿って走る(スポットより少し速い)。走路の守備を避けて曲がる。
      const ct = game.steerAround(p, p.offTarget.x, p.offTarget.z, true);
      moveToward2D(p.pos, ct.x, ct.z,
        p.accelToward(dt, ct.x, ct.z, p.has("lineMove") ? 1.22 : 1.08) * dt);
      spacingNudge(game, dt, p, 1.7);
      if (dist2DTo(p.pos, p.offTarget.x, p.offTarget.z) < 0.6) {
        const atRim = dist2DTo(p.offTarget, rim.x, rim.z) < 1.6;
        if (atRim) {
          // リムでボールをもらえなかった — オープンスポットへ抜ける
          p.spotIdx = bestOpenSpot(game, team, spots, p);
          p.offTarget.copyFrom(spots[p.spotIdx]);
        } else {
          p.cutting = false;
          p.offTimer = rand(2.5, 4.5);
        }
      }
    } else if (clearDriveLane(game, dt, p)) {
      // このフレームはハンドラーのドライブレーンから退いた
    } else if (isoHandler(game)) {
      // 釣り出し: スターがボール — 自分の守備を外へ広く釘付け
      const t2 = isoSpreadTarget(game, p, isoHandler(game)!);
      moveToward2D(p.pos, t2.x, t2.z, p.accelToward(dt, t2.x, t2.z) * dt);
      spacingNudge(game, dt, p, 1.7);
      game.clampCourt(p.pos);
    } else if (p.shakeOpenT > 0) {
      // マーク外し中: 分離方向へバーストして空きを作る（クイックは離れる、パワーはシールを押し込む）。
      const burst = p.shakePower ? 0.85 : 1.15;
      const tx = p.pos.x + p.shakeDirX * 2.0, tz = p.pos.z + p.shakeDirZ * 2.0;
      moveToward2D(p.pos, tx, tz, p.accelToward(dt, tx, tz, burst) * dt);
      spacingNudge(game, dt, p, 3.2);
      game.clampCourt(p.pos);
    } else {
      let spot = spots[p.spotIdx];
      const atPost = p.spotIdx >= 5;
      // ダンカースライド: ハンドラーがペイントへドライブしたら、ブロックのビッグはベース
      // ライン沿いに自分側のショートコーナーへ退きリムを空ける
      if (atPost && game.handler
          && ((game.handler.beatenT > 0 || game.handler.powerT > 0)
                && dist2D(game.handler.pos, p.pos) < 6.5
              || dist2D(game.handler.pos, p.pos) < 3.2)) {
        const s = game.attackSign(team);
        const sx = (spot.x || p.pos.x) > 0 ? 1 : -1;
        const tx = sx * 4.8, tz = s * (RIM.z - 0.9);
        moveToward2D(p.pos, tx, tz, p.accelToward(dt, tx, tz, 1.1) * dt);
        spacingNudge(game, dt, p, 1.6);
        game.clampCourt(p.pos);
        continue;
      }
      // スポットが混んだら再配置(ハンドラー/味方が近づいた)。ボールのトリガは広め(4.8m)、
      // 味方が近い(過密)なら空きスペースへ移す。
      if ((game.handler && dist2DTo(game.handler.pos, spot.x, spot.z) < 4.8)
          || nearestTeammateDist(game, p) < (atPost ? 2.3 : 3.8)) {
        p.spotIdx = bestOpenSpot(game, team, spots, p);
        spot = spots[p.spotIdx];
      }
      // ディープシューター(L精度/L速度とも90+)だけはスポットより一歩外へ
      let spx = spot.x, spz = spot.z;
      if (deepThreeOK(p)) {
        const dxs = spot.x - rim.x, dzs = spot.z - rim.z;
        const dl = Math.hypot(dxs, dzs);
        if (dl > THREE_DIST - 0.4) {
          const k = (dl + 1.1) / dl;
          spx = rim.x + dxs * k;
          spz = rim.z + dzs * k;
        }
      }
      const sj = game.steerAround(p, spx, spz, true);   // 通り抜けず迂回
      moveToward2D(p.pos, sj.x, sj.z, p.accelToward(dt, sj.x, sj.z) * dt);
      spacingNudge(game, dt, p, atPost ? 2.0 : 4.2);   // 味方と近づきすぎない（間合いを広く）
      // ボールからの連続的な分離: ドリブラーが寄ってきたら離れる
      ballSpacingNudge(game, dt, p, atPost ? 2.4 : 4.6);
      // マーク外し: 担当守備を振り切ってパスコースを作る（クイックネス or パワー勝負）
      tryShake(game, dt, p);

      if (p.offTimer <= 0) {
        p.offTimer = rand(2.0, 4.0);
        pickOffBallAction(game, team, spots, p);
      }
    }

    game.clampCourt(p.pos);
  }
}

// スポットを一定時間保った後の次の動き: スクリーン設定 / バスケットカット / より
// オープンなスポットへドリフト。同時にスクリーナー/カッターは最大1人で間合いを保つ。
function pickOffBallAction(game: Game, team: number, spots: Vector3[], p: Player): void {
  const rim = game.attackFloor(team);
  const busy = countScreening(game, team);   // 他のスクリーナーのみ排他（カットとは併存可）
  const screenChance = (game.isBig(p) ? 1.0 : 0.6) * (p.evalRole === "スクリーナー" ? 1.5 : 1);
  if (busy === 0 && handlerPressured(game) && goodScreener(game, p) && chance(screenChance)) {
    setScreen(game, p);
    return;
  }
  // ステーションのポストビッグがいるとカットのスペースが減る
  const postHome = game.teamPlayers(team)
    .some((q) => q !== p && q.spotIdx >= 5 && !q.cutting && !q.screening);
  if (countCutting(game, team) === 0
      && !(game.handler && (game.handler.beatenT > 0 || game.handler.powerT > 0
        || game.handler.jukeT > 0))
      && chance((0.2 + p.offPriority * 0.25 + rate(p.attr.aggression) * 0.15
        + (p.has("lineMove") ? 0.15 : 0)) * (postHome ? 0.55 : 1))) {
    p.cutting = true;
    // ポストが占有していればエルボーへ、空いていればリムまで
    let occL = false, occR = false;
    for (const q of game.teamPlayers(team)) {
      if (q !== p && q.spotIdx >= 5 && !q.cutting && !q.screening) {
        if (spots[q.spotIdx].x > 0) occR = true; else occL = true;
      }
    }
    const sgn = Math.sign(rim.z);
    let tx: number, tz: number;
    if (occL || occR) {
      const ex = occR ? -1 : occL ? 1 : (chance(0.5) ? 1 : -1);
      tx = rim.x + ex * rand(1.6, 2.4);
      tz = rim.z - sgn * rand(3.6, 5.0);            // エルボー/FTライン付近
    } else {
      tx = rim.x + rand(-0.6, 0.6);
      tz = rim.z - sgn * 0.4;                       // リムまで
    }
    // 走路がステーションのビッグ/ハンドラーを貫くならカットしない
    if (!cutLaneClear(game, team, p, tx, tz)) { p.cutting = false; return; }
    p.offTarget.set(tx, 0, tz);
    return;
  }
  // それ以外はパスレーンを開け、ドライブギャップを空けるよう再配置
  if (chance(game.teamHas(team, "general") ? 0.7 : 0.5)) {
    p.spotIdx = bestOpenSpot(game, team, spots, p);
  }
}

// マーク外し: 担当守備者を振り切って自分へのパスコースを作る。守備が近く(deny)て
// 1パスアウェイの時だけ発動。クイックネス(offense+敏捷 vs 守備+敏捷)か、パワー
// (バランスで背中に押し込む vs 守備のバランス)の勝負。成功で shakeOpenT を立て、
// deny が緩む＋守備の読みが鈍る＝オープンになりパスを呼び込む。
function tryShake(game: Game, dt: number, p: Player): void {
  if (p.shakeT > 0 || !game.handler || game.handler === p) return;
  const d = game.teamPlayers(1 - p.team)[p.slot];   // 担当守備者(index一致)
  if (!d) return;
  if (dist2D(d.pos, p.pos) > 2.2) return;            // 守備が離れている → 既に空き、不要
  if (dist2D(p.pos, game.handler.pos) > 7) return;   // ウィークサイドは対象外
  p.shakeT = rand(1.4, 2.8);                         // 試行クールダウン
  // ビッグ/高バランスはパワー勝負を選びやすく、それ以外は基本クイックネス
  const power = game.isBig(p)
    ? rate(p.attr.balance) > 0.5
    : rate(p.attr.balance) > 0.72 && chance(rate(p.attr.balance) - 0.45);
  if (power) {
    // パワー: バランスで守備を背中に押し込みパスコースを確保
    const off = rate(p.attr.balance) * 0.8 + rate(p.attr.aggression) * 0.2;
    const def = rate(d.attr.balance) * 0.8 + rate(d.attr.defense) * 0.2;
    if (chance(clamp(0.45 + (off - def) * 0.9, 0.1, 0.9))) {
      p.shakeOpenT = rand(0.7, 1.2);
      p.shakePower = true;
      // ボール→自分 の延長方向へシール（守備を背にボールを呼び込む）
      const bx = p.pos.x - game.handler.pos.x, bz = p.pos.z - game.handler.pos.z;
      const bl = Math.hypot(bx, bz) || 1;
      p.shakeDirX = bx / bl; p.shakeDirZ = bz / bl;
    }
  } else {
    // クイックネス: offense+敏捷 が 守備の defense+敏捷 を上回れば振り切る
    const off = rate(p.attr.offense) * 0.45 + rate(p.attr.agility) * 0.55;
    const def = rate(d.attr.defense) * 0.5 + rate(d.attr.agility) * 0.5;
    if (chance(clamp(0.42 + (off - def) * 1.1, 0.08, 0.92))) {
      p.shakeOpenT = rand(0.6, 1.0);
      p.shakePower = false;
      // 守備の横（逆側）へ鋭くカットして分離する
      const rx = p.pos.x - d.pos.x, rz = p.pos.z - d.pos.z;
      const rl = Math.hypot(rx, rz) || 1;
      const side = chance(0.5) ? 1 : -1;
      p.shakeDirX = (-rz / rl) * side; p.shakeDirZ = (rx / rl) * side;
    }
  }
}

function countCutting(game: Game, team: number): number {
  let n = 0;
  for (const p of game.teamPlayers(team)) if (p.cutting) n++;
  return n;
}

// 間合いを保とうとしている最寄りの味方(ハンドラー/カッター/スクリーナーは除く)。
function nearestTeammateDist(game: Game, self: Player): number {
  let best = Infinity;
  for (const q of game.teamPlayers(self.team)) {
    if (q === self || q === game.handler || q.cutting || q.screening) continue;
    best = Math.min(best, dist2D(self.pos, q.pos));
  }
  return best;
}

// オフボール選手を味方のパーソナルスペースから押し出し、毎フレーム間合いを保つ(boids風分離)。
function spacingNudge(game: Game, dt: number, p: Player, min = 3.5): void {
  const MIN = min;
  let rx = 0, rz = 0;
  for (const q of game.teamPlayers(p.team)) {
    if (q === p) continue;
    const dx = p.pos.x - q.pos.x, dz = p.pos.z - q.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < MIN && d > 1e-3) {
      const w = (MIN - d) / MIN;
      rx += (dx / d) * w; rz += (dz / d) * w;
    }
  }
  const rl = Math.hypot(rx, rz);
  if (rl > 1e-3) {
    const step = p.accelSpeed(dt, 0.8) * dt * Math.min(1, rl);   // 分離を押し出す
    moveToward2D(p.pos, p.pos.x + rx / rl, p.pos.z + rz / rl, step);
  }
}

// ボールハンドラーからの連続的な分離(spacingNudge は味方のみ)。min 以内なら真っ直ぐ離れる。
function ballSpacingNudge(game: Game, dt: number, p: Player, min: number): void {
  const h = game.handler;
  if (!h || h === p) return;
  const dx = p.pos.x - h.pos.x, dz = p.pos.z - h.pos.z;
  const d = Math.hypot(dx, dz);
  if (d >= min || d < 1e-3) return;
  const step = p.accelSpeed(dt, 0.8) * dt * ((min - d) / min);
  moveToward2D(p.pos, p.pos.x + dx / d, p.pos.z + dz / d, step);
}

// 今仕掛けている1対1のスター(エース/スラッシャー)。フロントコートでボールを持つと
// フロアが空けられる。
function isoHandler(game: Game): Player | null {
  const h = game.handler;
  if (!h || !game.frontT) return null;
  return (h.evalRole === "エース" || h.evalRole === "スラッシャー") ? h : null;
}

// 釣り出し(重力スプレッド): スターが仕掛ける間、皆がどこに立つか。両コーナーと逆サイド
// ディープウィング、(非ストレッチの)ビッグは逆サイドのダンカーポケットへ。
function isoSpreadTarget(game: Game, p: Player, h: Player): { x: number; z: number } {
  const s = game.attackSign(h.team);
  const hz = s * RIM.z, dir = -s;
  const hs = h.pos.x >= 0 ? 1 : -1;            // スターが仕掛ける側
  if (game.isBig(p) && game.prefersPost(p)) {
    const bigs = game.teamPlayers(h.team)
      .filter((q) => q !== h && game.isBig(q) && game.prefersPost(q));
    return bigs.indexOf(p) <= 0
      ? { x: -hs * 4.9, z: hz + dir * 0.9 }
      : { x: hs * 6.7, z: hz + dir * 1.5 };     // ディープコーナー3
  }
  const spots = [
    { x: -hs * 6.7, z: hz + dir * 1.5 },       // 逆コーナー(ディープ)
    { x: hs * 6.7, z: hz + dir * 1.5 },        // 強コーナー(ディープ)
    { x: -hs * 6.0, z: hz + dir * 7.0 },       // 逆ディープウィング
    { x: hs * 6.2, z: hz + dir * 7.5 },        // 強ディープウィング
  ];
  const mates = game.teamPlayers(h.team)
    .filter((q) => q !== h && !(game.isBig(q) && game.prefersPost(q)));
  const idx = Math.max(0, mates.indexOf(p));
  return spots[Math.min(idx, spots.length - 1)];
}

// オフボールの味方をハンドラーのドライブレーンから退かせる。処理したら true(フロントコートのみ)。
function clearDriveLane(game: Game, dt: number, p: Player): boolean {
  const h = game.handler;
  if (!h || !game.frontT) return false;
  const rim = game.attackFloor(h.team);
  const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, rim.x, rim.z);   // ハンドラー→リム
  const rx = p.pos.x - h.pos.x, rz = p.pos.z - h.pos.z;
  const along = rx * ux + rz * uz;                 // ハンドラーの前方距離
  if (along < 0.3 || along > 5.5) return false;    // 後方 or 遠すぎ
  const perp = rx * -uz + rz * ux;                 // レーンからの符号付き横オフセット
  if (Math.abs(perp) > 1.25) return false;         // 既に走路外
  const side = Math.abs(perp) < 0.05 ? (p.pos.x >= 0 ? 1 : -1) : (perp > 0 ? 1 : -1);
  const tx = p.pos.x + -uz * side * 2.2, tz = p.pos.z + ux * side * 2.2;
  moveToward2D(p.pos, tx, tz, p.accelToward(dt, tx, tz, 1.15) * dt);
  p.spotIdx = bestOpenSpot(game, p.team, game.formationSpots(p.team), p);
  return true;
}

// p から (tx,tz) へのカットが、ステーションの味方(ポストビッグ1.7m/ハンドラー1.4m)を貫くか。
function cutLaneClear(game: Game, team: number, p: Player, tx: number, tz: number): boolean {
  const hits: { x: number; z: number; r: number }[] = [];
  for (const q of game.teamPlayers(team)) {
    if (q === p || q.cutting || q.screening) continue;
    if (q.spotIdx >= 5) hits.push({ x: q.pos.x, z: q.pos.z, r: 1.7 });
  }
  if (game.handler && game.handler !== p)
    hits.push({ x: game.handler.pos.x, z: game.handler.pos.z, r: 1.4 });
  const dx = tx - p.pos.x, dz = tz - p.pos.z;
  for (const o of hits) {
    // t を [0,1] にクランプした点までの距離で判定
    const t = clamp(segPerp(p.pos.x, p.pos.z, tx, tz, o.x, o.z).t, 0, 1);
    const px = p.pos.x + dx * t, pz = p.pos.z + dz * t;
    if (Math.hypot(o.x - px, o.z - pz) < o.r) return false;
  }
  return true;
}

// オープン(守備から遠い)で、ボールから間合いがあり、味方が未占有のフォーメーション
// スポットを選ぶ。
export function bestOpenSpot(game: Game, team: number, spots: Vector3[], self: Player): number {
  const rimFloor = game.attackFloor(team);
  let bestI = self.spotIdx;
  let bestScore = -Infinity;
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    let owned = false;
    for (const q of game.teamPlayers(team)) {
      if (q === self || q.cutting || q.screening || q === game.handler) continue;
      if (q.spotIdx === i || dist2DTo(q.pos, s.x, s.z) < 2.5) { owned = true; break; }
    }
    if (owned) continue;

    let open = Infinity;
    for (const d of game.teamPlayers(1 - team)) open = Math.min(open, dist2DTo(d.pos, s.x, s.z));
    // 味方から最も近い距離: 空きスペース(味方が居ない場所)を選ばせる＝密集回避
    let mate = Infinity;
    for (const q of game.teamPlayers(team)) {
      if (q === self || q === game.handler) continue;
      mate = Math.min(mate, dist2DTo(q.pos, s.x, s.z));
    }
    const fromHandler = game.handler ? dist2DTo(game.handler.pos, s.x, s.z) : 5;
    const lane = game.handler ? laneOpenness(game, game.handler.pos, s.x, s.z) : 1;
    const clog = game.handler ? clogPenalty(game.handler.pos, rimFloor, s.x, s.z) : 0;

    // ローブロック(idx 5/6)はビッグの領域: ガードやストレッチビッグは張らない
    if (i >= 5 && !game.prefersPost(self)) continue;

    let score: number;
    if (i >= 5) {
      score = 6.0 + Math.min(open, 2.0) * 0.5 + lane * 0.8
        + Math.min(mate, 4) * 0.3               // 味方から離れたローブロックを優先
        - clog * 2.5
        - dist2DTo(self.pos, s.x, s.z) * 0.1
        + (self.has("centerSpot") ? 1.5 : 0);
    } else {
      // オフェンスのポジション優先度: ①相手がいない(オープン)を最重視 ②密集回避＝スペーシング
      // ③フリーの味方を作るパスコース ④相手ゴールに近い得点圏 ⑤ボールから適度に離れる。
      const rimDist = dist2DTo(rimFloor, s.x, s.z);
      score = open * (self.has("positioning") ? 1.35 : 1) * 1.15   // ①オープン(相手がいない)を最重視
        + Math.min(mate, 7) * 1.05              // ②密集回避=スペーシング(味方から離れた空きへ)
        + lane * 2.0                            // ③フリーの味方を作る(パスコースが通る位置)
        + Math.max(0, 9 - rimDist) * 0.3        // ④相手ゴールに近い得点圏を加点(上限9m)
        + Math.min(fromHandler, 6) * 0.25       // ⑤ボールから適度に離れる
        - clog * 2.5                            // ドライブレーンを塞がない
        - dist2DTo(self.pos, s.x, s.z) * 0.1;   // 移動コスト
      if (self.has("sideSpot") && (i === 3 || i === 4)) score += 1.5;
      if (game.prefersPost(self)) score = Math.min(score, 4.0) - 1.5;
    }
    if (score > bestScore) { bestScore = score; bestI = i; }
  }
  return bestI;
}

// from から点(x,z)へのパスレーンの開き具合: 1=守備なし、守備が真正面に座るほど0へ。
function laneOpenness(game: Game, from: Vector3, x: number, z: number): number {
  let minPerp = Infinity;
  for (const d of game.teamPlayers(1 - game.possession)) {
    const { t, perp } = segPerp(from.x, from.z, x, z, d.pos.x, d.pos.z);
    if (t <= 0.1 || t >= 0.95) continue;
    minPerp = Math.min(minPerp, perp);
  }
  return minPerp === Infinity ? 1 : clamp(minPerp / LANE_W, 0, 1);
}

// 点(x,z)がハンドラーのリムへの直線ドライブをどれだけ塞ぐか: 1=走路のど真ん中、0=走路外。
function clogPenalty(from: Vector3, rim: Vector3, x: number, z: number): number {
  const { t, perp } = segPerp(from.x, from.z, rim.x, rim.z, x, z);
  if (t <= 0.05 || t >= 1) return 0;                  // ハンドラーとリムの間でない
  return clamp(1 - perp / 2.0, 0, 1);                 // 走路~2m以内=塞ぐ
}
