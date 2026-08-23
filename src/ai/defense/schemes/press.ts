// フルコートプレス: 型に入る前のバックコートでボールをトラップする。
import { rate, clamp, chance, dist2D, moveToward2D, dirTo2D, towardPoint } from "../../../util";
import { ballSecurity } from "../../../eval";
import type { Game } from "../../../game";

// フルコートプレス/トラップ。ボール保持者の男が嫌がらせ、2人目がトラップ(ダブル)、
// 残りはアウトレットを denial、1人がセーフティで over-the-top のレイアップを止める。
export function runPress(game: Game, dt: number): void {
  const defTeam = 1 - game.possession;
  const defenders = game.teamPlayers(defTeam);
  const offense = game.teamPlayers(game.possession);
  const h = game.handler!;
  const protect = game.attackFloor(game.possession);   // 守るリム
  // 主嫌がらせ = ハンドラーの担当守備者
  const primary = game.onBallDefender(h) ?? defenders[0];
  // トラッパー = 最寄りの別守備者、セーフティ = 最も後方、残り2人が担当のアウトレットを denial
  const others = defenders.filter((d) => d !== primary);
  let trapper = others[0], tBest = Infinity;
  for (const d of others) { const dd = dist2D(d.pos, h.pos); if (dd < tBest) { tBest = dd; trapper = d; } }
  const rest = others.filter((d) => d !== trapper);
  // セーフティ = 自軍リムに最も近い残り(最後の砦)
  const safety = rest.reduce((a, b) => (dist2D(a.pos, protect) <= dist2D(b.pos, protect) ? a : b));
  const deny = rest.filter((d) => d !== safety);

  // ハンドラー→リム方向と、挟み込む横軸
  const { ux, uz } = dirTo2D(h.pos.x, h.pos.z, protect.x, protect.z);   // リム方向(ダウンコート)
  const lx = -uz, lz = ux;                     // 横

  // PRIMARY: ボール側でボディアップ、中央を切る(バックコートのプレスでは全力)
  {
    const side = h.pos.x >= 0 ? 1 : -1;        // 近いサイドラインへ追い込む
    const tx = h.pos.x + ux * 0.55 - lx * 0.5 * side;
    const tz = h.pos.z + uz * 0.55 - lz * 0.5 * side;
    moveToward2D(primary.pos, tx, tz, primary.accelToward(dt, tx, tz, 1.1) * dt);
    game.clampCourt(primary.pos);
  }
  // TRAPPER: 反対側から挟む(押すのは primary のみ)。腕一本分の距離で逃げ道を塞ぎボールを狙う。
  {
    const side = h.pos.x >= 0 ? 1 : -1;
    const tx = h.pos.x + ux * 0.35 + lx * 1.0 * side;
    const tz = h.pos.z + uz * 0.35 + lz * 1.0 * side;
    moveToward2D(trapper.pos, tx, tz, trapper.accelToward(dt, tx, tz, 1.15) * dt);
    game.clampCourt(trapper.pos);
    game.pressTrapper = trapper;
  }
  // DENY: ボールと担当の間(ボール側)のパスレーンに立つ
  for (const d of deny) {
    const man = offense[d.slot];
    const tx = man.pos.x * 0.55 + h.pos.x * 0.45 + (h.pos.x - man.pos.x) * 0.05;
    const tz = man.pos.z * 0.55 + h.pos.z * 0.45;
    moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, 1.05) * dt);
    d.decayLean(dt);
    game.clampCourt(d.pos);
  }
  // SAFETY: over-the-top のレイアップを止める最後の砦。固定点に凍結させず、リム→ボール
  // 方向の一定距離(7m)に置いてボールのサイド/進行に連動させる(静止=棒立ちを防ぐ)。
  {
    const sp = towardPoint(protect.x, protect.z, h.pos.x, h.pos.z, 7);   // リムから7m、ボール方向
    const tx = clamp(sp.x, -3.5, 3.5);                     // 中央寄りに締めつつボール側へ寄る
    moveToward2D(safety.pos, tx, sp.z, safety.accelToward(dt, tx, sp.z, 1.0) * dt);
    game.clampCourt(safety.pos);
  }

  // トラップがボールを吐き出させる: 両トラッパー密着で速い手がリップ/暴投を強要。
  const trapped = dist2D(primary.pos, h.pos) < 1.6 && dist2D(trapper.pos, h.pos) < 1.9;
  if (trapped) {
    const hands = rate(primary.attr.reaction) * 0.25 + rate(primary.attr.agility) * 0.2
      + rate(trapper.attr.reaction) * 0.25 + rate(trapper.attr.agility) * 0.2;
    const secure = ballSecurity(h);
    const p = Math.max(0.01, 0.06 + hands * 0.12 - secure * 0.14);
    // トラッパーが奪う(primary はボディアップで手一杯)
    if (chance(p * dt * 6)) { game.steal(trapper); return; }
  }
}
