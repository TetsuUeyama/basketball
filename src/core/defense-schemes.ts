// ディフェンスの特殊スキーム（ゾーン / フルコートプレス / スキーム選択）。Option B:
// 状態は Game(=GameState)が持ち、ここは game を受け取る関数群。man ディフェンス本体は
// runDefense(game 側)に残し、そこからスキーム時にこれらへ分岐する。
import { Player } from "../player";
import { RIM } from "../config";
import { rate } from "../attributes";
import { clamp, chance, dist2D, moveToward2D } from "../util";
import { defEffort, defendOnBall, getBackOnDefense } from "./defense";
import type { Game } from "../game";

// この停止/ポゼッションで守備がどのスキームを敷くか(man/zone/press)を抽選して決める。
export function pickDefScheme(game: Game): void {
  const defTeam = 1 - game.possession;
  const tac = game.tactics[defTeam].defense;
  game.pressOn = chance(tac.press);
  // プレスのポゼッションもボールが上がれば man に落ちる。非プレスのみセットのゾーンに commit。
  if (!game.pressOn && chance(tac.zone)) {
    const bigs = game.teamPlayers(defTeam).filter((p) => game.isBig(p));
    const tall = bigs.length ? bigs.reduce((s, p) => s + p.height, 0) / bigs.length : 2;
    // 高いフロントラインは 2-3、そうでなければ時々 3-2 でアークを守る
    game.zoneScheme = (tall > 2.02 || chance(0.6)) ? "2-3" : "3-2";
  } else {
    game.zoneScheme = "";
  }
}

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
        const stl = rate(d.attr.reaction) * 0.4 + rate(d.attr.agility) * 0.3 + rate(d.attr.defense) * 0.3;
        const resist = rate(h.attr.dribbleAcc) * 0.6 + rate(h.attr.handling) * 0.4;
        if (chance(Math.max(0.004, 0.025 + stl * 0.08 - resist * 0.06) * close * dt)) { game.steal(d); return; }
      }
      continue;
    }

    const home = homes.get(d)!;
    let tx = home.x + shiftX, tz = home.z;
    // マッチアップ風味: この守備者の区域にいるオフェンスを拾う(バンプ)。ただし後方の
    // ビッグはアークの外まで追わない — それが外のシューターを空ける(ゾーンの代償)
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
  const dx = protect.x - h.pos.x, dz = protect.z - h.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;          // リム方向(ダウンコート)
  const lx = -uz, lz = ux;                     // 横

  // PRIMARY: ボール側でボディアップ、中央を切る(バックコートのプレスでは全力)
  {
    const side = h.pos.x >= 0 ? 1 : -1;        // 近いサイドラインへ追い込む
    const tx = h.pos.x + ux * 0.55 - lx * 0.5 * side;
    const tz = h.pos.z + uz * 0.55 - lz * 0.5 * side;
    moveToward2D(primary.pos, tx, tz, primary.accelToward(dt, tx, tz, 1.1) * dt);
    game.clampCourt(primary.pos);
  }
  // TRAPPER: 反対側から挟むが2人目の押しは加えない(押すのは primary のみ)。腕一本分の
  // 距離で逃げ道を塞ぎ、そこからボールを狙う(ディグのポーズは poseHands、リップは下の trapped)。
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
  // SAFETY: 自軍リムへ中央で下がり over-the-top のレイアップを止める
  {
    const tx = 0, tz = protect.z - Math.sign(protect.z || 1) * 6;
    moveToward2D(safety.pos, tx, tz, safety.accelToward(dt, tx, tz, 1.0) * dt);
    game.clampCourt(safety.pos);
  }

  // トラップがボールを吐き出させる: 両トラッパーが密着し、速い手(反応/敏捷)がリップ/暴投を
  // 強要。保持力(技術/D精度)とキープ特化はより多く割る。
  const trapped = dist2D(primary.pos, h.pos) < 1.6 && dist2D(trapper.pos, h.pos) < 1.9;
  if (trapped) {
    const hands = rate(primary.attr.reaction) * 0.25 + rate(primary.attr.agility) * 0.2
      + rate(trapper.attr.reaction) * 0.25 + rate(trapper.attr.agility) * 0.2;
    const secure = rate(h.attr.dribbleAcc) * 0.5 + rate(h.attr.handling) * 0.4
      + (h.has("keepDribble") ? 0.2 : 0);
    const p = Math.max(0.01, 0.06 + hands * 0.12 - secure * 0.14);
    // トラッパーが奪う(自由な手でボールを狙っているのは彼、primary はボディアップで手一杯)
    if (chance(p * dt * 6)) { game.steal(trapper); return; }
  }
}
