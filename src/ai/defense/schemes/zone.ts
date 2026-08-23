// ハーフコートゾーン(2-3 / 3-2)。man-match も PnR スイッチもせず、区域とボールを守る。
import { Player } from "../../../objects/player/player";
import { RIM } from "../../../config";
import { clamp, chance, dist2D, moveToward2D } from "../../../util";
import { defHands, ballSecurity } from "../../../eval";
import { defEffort, getBackOnDefense } from "../shared";
import { defendOnBall } from "../vs-onball";
import type { Game } from "../../../game";

// ゾーンの各守備者のホーム位置。
function zoneHomes(game: Game, defTeam: number, s: number): Map<Player, { x: number; z: number }> {
  const ds = game.teamPlayers(defTeam);
  const rimZ = s * RIM.z;
  const dir = -s;                              // ミッドコート方向
  const topN = game.zoneScheme === "3-2" ? 3 : 2;
  const order = [...ds].sort((a, b) => a.slot - b.slot);  // ガード優先
  const top = order.slice(0, topN);
  const back = order.slice(topN);
  const topXs = topN === 3 ? [-4.4, 0, 4.4] : [-2.9, 2.9];
  const backXs = back.length === 3 ? [-3.5, 0, 3.5] : [-2.9, 2.9];
  const topDepth = 6.9;
  const m = new Map<Player, { x: number; z: number }>();
  // 左右順を安定させ守備者が交差しないように
  top.sort((a, b) => a.pos.x - b.pos.x).forEach((d, i) =>
    m.set(d, { x: topXs[i], z: rimZ + dir * topDepth }));
  back.sort((a, b) => a.pos.x - b.pos.x).forEach((d, i) => {
    const mid = back.length === 3 && i === 1;   // 中央後方はリム上
    m.set(d, { x: backXs[i], z: rimZ + dir * (mid ? 1.1 : 2.1) });
  });
  return m;
}

export function runZoneDefense(game: Game, dt: number): void {
  const defTeam = 1 - game.possession;
  const s = game.attackSign(game.possession);
  const rim = game.attackFloor(game.possession);
  const defenders = game.teamPlayers(defTeam);
  const offense = game.teamPlayers(game.possession);
  const h = game.handler;
  const b = game.ball.pos;
  const homes = zoneHomes(game, defTeam, s);
  const shiftX = clamp(b.x * 0.4, -2.8, 2.8);        // ゾーン全体がボール側へスライド

  // ボールがある区域の守備者が前に出て圧力
  let ballDef: Player | null = null;
  if (h) {
    let best = Infinity;
    for (const d of defenders) {
      const dd = dist2D(d.pos, h.pos);
      if (dd < best) { best = dd; ballDef = d; }
    }
  }

  for (const d of defenders) {
    if (getBackOnDefense(game, dt, d, offense[d.slot])) continue;   // まずトランジション
    d.decayLean(dt);

    if (d === ballDef && h) {
      // ゾーン内でボールに圧力(ソフトな man-up)、トップからつつく
      defendOnBall(game, dt, d, h, rim);
      const gap = dist2D(d.pos, h.pos);
      if (gap < 1.4) {
        const close = 1 - gap / 1.4;
        const stl = defHands(d);
        const resist = ballSecurity(h);
        if (chance(Math.max(0.004, 0.025 + stl * 0.08 - resist * 0.06) * close * dt)) { game.steal(d); return; }
      }
      continue;
    }

    const home = homes.get(d)!;
    let tx = home.x + shiftX, tz = home.z;
    // マッチアップ風味: 区域内のオフェンスを拾う。後方ビッグはアークの外まで追わない。
    const reach = game.isBig(d) ? 3.0 : 3.8;
    let claim: Player | null = null;
    let bestD = reach;
    for (const o of offense) {
      if (o === h) continue;
      const dd = Math.hypot(o.pos.x - (home.x + shiftX), o.pos.z - home.z);
      if (dd < bestD) { bestD = dd; claim = o; }
    }
    if (claim) {
      // 区域内の男へクローズアウトしつつゾーンの深さを保つ(ペイントを空けない)
      tx = claim.pos.x * 0.6 + (home.x + shiftX) * 0.4;
      tz = claim.pos.z * 0.45 + home.z * 0.55;
    }
    // ボールがペイントへドライブしてきたらリムをヘルプ
    if (h && (h.beatenT > 0 || h.powerT > 0) && game.isBig(d) && dist2D(h.pos, rim) < 6) {
      tx = (tx + rim.x) / 2; tz = (tz + rim.z) / 2;
    }
    const effort = defEffort(game, d, rim);
    moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, effort) * dt);
    game.clampCourt(d.pos);
  }
}
