// 守備の入口。ポゼッション毎に型(man/zone/press)を決め、man の時は守備者1人ずつを
// 対オンボール(./vs-onball)とオフボール(./offball)へ振り分ける。
import { Player } from "../../objects/player/player";
import { rate, dist2D, moveToward2D, towardPoint } from "../../util";
import { tickScreenCoverage, defendScreen } from "../../move/reaction/screen";
import { defendHandler } from "./vs-onball";
import { defendOffBall } from "./offball";
import { getBackOnDefense } from "./shared";
import { pickDefScheme } from "./schemes";
import { runZoneDefense } from "./schemes/zone";
import { runPress } from "./schemes/press";
import type { Game } from "../../game";

export function runDefense(game: Game, dt: number): void {
  const defTeam = 1 - game.possession;
  const protect = game.attackFloor(game.possession); // 守るリム
  const defenders = game.teamPlayers(defTeam);
  const offense = game.teamPlayers(game.possession);

  // ポゼッション毎に守備の型を1回決める
  if (game.possession !== game.schemePoss) { game.schemePoss = game.possession; pickDefScheme(game); }

  // フルコートプレス: 型に入る前のバックコートでトラップ
  game.pressTrapper = null;   // 毎tickリセット — ライブプレスのみ割り当て
  if (game.pressOn && !game.frontT && game.handler) { runPress(game, dt); return; }

  // ハーフコートゾーン: man-match/PnRスイッチ無し、区域とボールを守る
  if (game.zoneScheme) { runZoneDefense(game, dt); return; }

  // ピック&ロールのカバレッジ窓
  tickScreenCoverage(game, dt);

  // 常駐リムアンカー: オフボール守備者で最もリムに近い1人(ビッグ優先 −1.2m)を常時ペイントの
  // 壁役に固定する。抜かれた時だけでなく常にゴール下へ残し、センターがゴール下を空けないようにする。
  let anchor: Player | null = null;
  {
    let best = Infinity;
    for (const d of defenders) {
      if (offense[d.slot] === game.handler) continue;   // オンボールは除外
      const score = dist2D(d.pos, protect) - (game.isBig(d) ? 1.2 : 0);
      if (score < best) { best = score; anchor = d; }
    }
  }

  for (const d of defenders) {
    const man = offense[d.slot]; // index一致の man-to-man
    const isOnBall = man === game.handler;
    if (!isOnBall) d.decayLean(dt);

    // ピック&ロール: スクリーンの2守備者はカバレッジスキームで動く
    if (game.screen.cov && (d === game.screen.screenerDef || d === game.screen.handlerDef)) {
      defendScreen(game, dt, d, protect);
      continue;
    }

    if (isOnBall) {
      if (defendHandler(game, dt, d, man, protect, defTeam)) return;   // スティール/ファウルで局面が変わった
      continue;
    }
    defendOffBall(game, dt, d, man, protect, defTeam, anchor);
  }
}

// デッドボール気味(アウトレット/スローイン等)の守備: デュエルは無いが、ビッグは自陣へ
// 戻り、各自は担当のゴールサイドに付く。
// offTeam は攻める側。交代中はまだ possession が切り替わっていない場面があるので
// 呼び出し側が明示できる（省略時は現在のポゼッション）。
export function runDefenseDuringDeadish(game: Game, dt: number, offTeam = game.possession): void {
  const defTeam = 1 - offTeam;
  const protect = game.attackFloor(offTeam);
  const defenders = game.teamPlayers(defTeam);
  const offense = game.teamPlayers(offTeam);
  // 交代でコートへ歩いている選手。体は updateSubs が運ぶので、ここでは動かさない
  const walk = (p: Player) => game.subWalkers.find((w) => w.p === p);
  for (const d of defenders) {
    // パスジャンパーはインターセプト地点へ走っている — 任せる
    if (game.ballMode === "pass" && game.passSteal?.def === d) continue;
    if (walk(d)) continue;                     // 自分が入場中 — 二重に動かさない
    d.decayLean(dt);   // ボールが飛んでいる間は誰もデュエルしない
    const man = offense[d.slot];
    // マークが入場中ならベンチではなく「これから立つ位置」を守る
    const mw = walk(man);
    const mx = mw ? mw.tx : man.pos.x, mz = mw ? mw.tz : man.pos.z;
    // アウトレット/スローインはビッグが自陣へ全力で戻る場面
    if (!mw && getBackOnDefense(game, dt, d, man)) continue;
    // 非脅威(アーク付近の非シューター)はアーク内(リムから約5m)まで下がってゾーンを守る。
    // ペイント/得点圏の脅威か本物のシューターのみ 1.5m でタイトに付く。
    const mRim = Math.hypot(mx - protect.x, mz - protect.z);
    const shooter3 = rate(man.attr.threeAcc) >= 0.82;
    const sag = (mRim < 4.5 || shooter3) ? 1.5 : Math.max(1.5, mRim - 5.0);
    const gs = towardPoint(mx, mz, protect.x, protect.z, sag);
    moveToward2D(d.pos, gs.x, gs.z, d.accelSpeed(dt) * dt);
    game.clampCourt(d.pos);
  }
}
