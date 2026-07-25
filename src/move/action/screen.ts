// スクリーン（ピック&ロール）の攻撃アクション＝選手のMOVE: スクリーン設定・スクリーナーの
// 寄せ・ピック成立の検出・ロール/ポップ。守備のカバレッジ反応は move/reaction/screen。
import { Player } from "../../objects/player/player";
import { rate, clamp, chance, rand, dist2D, moveToward2D } from "../../util";
import { bestOpenSpot } from "../../ai/offball";
import { resolveScreenCoverage } from "../reaction/screen";
import type { Game } from "../../game";

// チーム内でスクリーン中の人数
export function countScreening(game: Game, team: number): number {
  let n = 0;
  for (const p of game.teamPlayers(team)) if (p.screening) n++;
  return n;
}

// ハンドラーがスクリーンで助かる程度に密着で守られているか
export function handlerPressured(game: Game): boolean {
  const h = game.handler;
  if (!h) return false;
  const d = game.onBallDefender(h);
  return !!d && dist2D(d.pos, h.pos) < 1.7;
}

// ピックを掛けに来られる近さの味方か（掛けに行っても間に合う距離）
export function goodScreener(game: Game, p: Player): boolean {
  const h = game.handler;
  return !!h && dist2D(p.pos, h.pos) < 5.0;
}

// ボールスクリーン開始。オンボール守備がシェードしている逆側でハンドラーを解放し、
// ハンドラーはその側を攻めると決める。
export function setScreen(game: Game, p: Player): void {
  const h = game.handler!;
  const d = game.onBallDefender(h);
  p.screening = true;
  p.cutting = false;
  p.screenT = rand(1.2, 2.0);
  p.screenSide = d ? -d.shadeSide : (chance(0.5) ? 1 : -1);
  h.driveSide = p.screenSide;
}

// スクリーナーは守備者の追走進路に体を入れ、ハンドラーがピックを使いに来れば成立。
// 使われなかったピックは失効しポップアウト。
export function updateScreen(game: Game, dt: number, p: Player): void {
  const h = game.handler;
  p.screenT -= dt;
  const d = h ? game.onBallDefender(h) : undefined;
  if (!h || !d) { endScreen(game, p, false); return; }

  const rim = game.attackFloor(p.team);
  const dx = rim.x - h.pos.x, dz = rim.z - h.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len;                 // ハンドラー→リム
  const lx = -fz * p.screenSide, lz = fx * p.screenSide;   // +l = ハンドラーが抜ける側
  // スクリーナーはマークマン(守備者)の、ハンドラーが抜ける側の真横に立ち壁になる。
  // 守備者とハンドラーの間に体を入れ、守備者がハンドラーを追走できないようにする。
  const tx = d.pos.x + lx * 0.55;
  const tz = d.pos.z + lz * 0.55;
  moveToward2D(p.pos, tx, tz, p.accelSpeed(dt) * dt);

  // ハンドラーがピックを使いに来て（スクリーナーに接触）、守備者がまだ守っていれば繋がる。
  if (dist2D(h.pos, p.pos) < 1.4 && dist2D(h.pos, d.pos) < 2.6) {
    resolveScreenCoverage(game, h, p, d);   // 守備のカバレッジを決め、ハンドラーの結末が従う
    endScreen(game, p, true);               // スクリーナーはロール
    return;
  }
  if (p.screenT <= 0) endScreen(game, p, false);       // 未使用のピック — ポップアウト
}

// スクリーン終了。成立ならロール/ポップ、不発ならオープンスポットへ戻る。
export function endScreen(game: Game, p: Player, connected: boolean): void {
  p.screening = false;
  p.screenT = 0;
  if (!connected) {
    p.spotIdx = bestOpenSpot(game, p.team, game.formationSpots(p.team), p);
    return;
  }
  const rim = game.attackFloor(p.team);
  // ピック&ポップ vs ロール: シューターはアークへポップ、それ以外はリムへロール
  const canPop = rate(p.attr.threeAcc) > 0.68 || p.has("range") || p.evalRole === "ストレッチ";
  p.cutting = true;
  p.offTimer = rand(1.5, 2.5);
  if (canPop && chance(0.6)) {
    const dir = -game.attackSign(p.team);              // ミッドコート方向
    const px = clamp(p.pos.x + p.screenSide * 1.5, -6.5, 6.5);
    p.offTarget.set(px, 0, rim.z + dir * 7.2);          // 3Pレンジへ
    p.openRollT = 2.0;                                  // ポップアウト移動中もフィード対象
  } else {
    p.offTarget.set(rim.x + rand(-0.6, 0.6), 0, rim.z - Math.sign(rim.z) * 0.4);   // リムへロール
  }
}
