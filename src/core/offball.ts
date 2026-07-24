// オフボール移動・スペーシング。Option B: 状態は Game(=GameState)が持ち、ここは game を
// 受け取る関数群。スクリーンは ScreenSystem、トラップ救済等は Game 側のヘルパーを使う。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, THREE_DIST, LANE_W } from "../config";
import { rate } from "../attributes";
import { clamp, chance, rand, dist2D, dist2DTo, moveToward2D } from "../util";
import { deepThreeOK } from "../eval";
import { laneBlock } from "../resolution/pass-risk";
import type { Game } from "../game";

// オフボール全員の駆動: スポット確保、リムへのカット、ギブ&ゴー、オープンスポットへの
// ローテ、ボールから離れたスペーシング。
export function updateOffBallMotion(game: Game, dt: number, team: number, exclude: Player | null): void {
  const spots = game.formationSpots(team);
  const rim = game.attackFloor(team);
  for (const p of game.teamPlayers(team)) {
    if (p === exclude) continue;
    if (p.rooted) continue;   // パス/シュートのフォロースルー中 — 保持

    // トラップ救済(最優先): ハンドラーがダブルチーム → 味方1人がスポットを離れてボールへ
    // フラッシュし、トラップの逆側に安全なアウトレットを作る。他は間合いを保つ。
    if (game.handler && game.handler !== p && game.tightlyTrapped(game.handler)
        && p === game.trapReliever(team)) {
      const t = game.trapReliefSpot(game.handler);
      moveToward2D(p.pos, t.x, t.z, p.accelToward(dt, t.x, t.z, 1.2) * dt);
      spacingNudge(game, dt, p, 1.6);
      game.clampCourt(p.pos);
      p.cutting = false;
      continue;
    }

    // ポゼッション交代後の持ち運び: プライマリのハンドラーがボールへ戻ってアウトレットを
    // 受ける(ビッグが持った時、あるいは自分がカバーされ/レーンが塞がれた時)。
    if (!game.frontT && game.handler && dist2D(game.handler.pos, rim) > 10) {
      const outlet = game.teamPlayers(team)
        .filter((q) => q !== game.handler)
        .sort((a, b) => b.playmaking - a.playmaking)[0];
      if (p === outlet) {
        const wanted = game.isBig(game.handler)
          || game.nearestDefenderDist(p) < 1.4
          || laneBlock(game.oppTeam(game.handler), game.handler, p) !== null;
        if (wanted) {
          const s = game.attackSign(team);
          const bx = game.handler.pos.x, bz = game.handler.pos.z;
          const otx = bx * 0.5, otz = bz + s * 2.0;
          moveToward2D(p.pos, otx, otz, p.accelToward(dt, otx, otz, 1.1) * dt);
          game.clampCourt(p.pos);
          continue;
        }
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
      game.screen.update(dt, p);
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
      // スポットが混んだら再配置(ハンドラーが近づいた/味方が入ってきた)。ボールとの
      // トリガは広め(4.5m): ドリブラーから実質的な間合いを取る。
      if ((game.handler && dist2DTo(game.handler.pos, spot.x, spot.z) < 4.5)
          || nearestTeammateDist(game, p) < (atPost ? 2.0 : 3.2)) {
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
      spacingNudge(game, dt, p, atPost ? 1.6 : 3.5);
      // …そしてボールからの連続的な分離: ドリブラーが寄ってきたら離れて実質的な間合いを保つ
      ballSpacingNudge(game, dt, p, atPost ? 2.4 : 4.6);

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
  const busy = game.screen.countScreening(team) + countCutting(game, team);
  const screenChance = (game.isBig(p) ? 0.7 : 0.3) * (p.evalRole === "スクリーナー" ? 1.5 : 1);
  if (busy === 0 && game.screen.handlerPressured() && game.screen.goodScreener(p) && chance(screenChance)) {
    game.screen.start(p);
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
    const step = p.accelSpeed(dt, 0.7) * dt * Math.min(1, rl);
    moveToward2D(p.pos, p.pos.x + rx / rl, p.pos.z + rz / rl, step);
  }
}

// ボールハンドラーからの連続的な分離(spacingNudge は味方のみ)。ドリブラーが min 以内に
// 来たらオフボールの男が真っ直ぐ離れて実質的な間合いを保つ。
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
  const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;              // handler → rim
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
  const len2 = dx * dx + dz * dz || 1;
  for (const o of hits) {
    const t = clamp(((o.x - p.pos.x) * dx + (o.z - p.pos.z) * dz) / len2, 0, 1);
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
    const fromHandler = game.handler ? dist2DTo(game.handler.pos, s.x, s.z) : 5;
    const lane = game.handler ? laneOpenness(game, game.handler.pos, s.x, s.z) : 1;
    const clog = game.handler ? clogPenalty(game.handler.pos, rimFloor, s.x, s.z) : 0;

    // ローブロック(idx 5/6)はビッグの領域: ガードやストレッチビッグは張らない
    if (i >= 5 && !game.prefersPost(self)) continue;

    let score: number;
    if (i >= 5) {
      score = 6.0 + Math.min(open, 2.0) * 0.5 + lane * 0.8
        - clog * 2.5
        - dist2DTo(self.pos, s.x, s.z) * 0.1
        + (self.has("centerSpot") ? 1.5 : 0);
    } else {
      score = open * (self.has("positioning") ? 1.35 : 1)
        + Math.min(fromHandler, 6) * 0.3
        + lane * 2.0
        - clog * 2.5
        - dist2DTo(self.pos, s.x, s.z) * 0.1;
      if (self.has("sideSpot") && (i === 3 || i === 4)) score += 1.5;
      if (game.prefersPost(self)) score = Math.min(score, 4.0) - 1.5;
    }
    if (score > bestScore) { bestScore = score; bestI = i; }
  }
  return bestI;
}

// from から点(x,z)へのパスレーンの開き具合: 1=守備なし、守備が真正面に座るほど0へ。
function laneOpenness(game: Game, from: Vector3, x: number, z: number): number {
  const dx = x - from.x, dz = z - from.z;
  const len2 = dx * dx + dz * dz || 1;
  let minPerp = Infinity;
  for (const d of game.teamPlayers(1 - game.possession)) {
    const t = ((d.pos.x - from.x) * dx + (d.pos.z - from.z) * dz) / len2;
    if (t <= 0.1 || t >= 0.95) continue;
    const px = from.x + dx * t, pz = from.z + dz * t;
    minPerp = Math.min(minPerp, Math.hypot(d.pos.x - px, d.pos.z - pz));
  }
  return minPerp === Infinity ? 1 : clamp(minPerp / LANE_W, 0, 1);
}

// 点(x,z)がハンドラーのリムへの直線ドライブをどれだけ塞ぐか: 1=走路のど真ん中、0=走路外。
function clogPenalty(from: Vector3, rim: Vector3, x: number, z: number): number {
  const dx = rim.x - from.x, dz = rim.z - from.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = ((x - from.x) * dx + (z - from.z) * dz) / len2;
  if (t <= 0.05 || t >= 1) return 0;                  // ハンドラーとリムの間でない
  const px = from.x + dx * t, pz = from.z + dz * t;
  const perp = Math.hypot(x - px, z - pz);
  return clamp(1 - perp / 2.0, 0, 1);                 // 走路~2m以内=塞ぐ
}
