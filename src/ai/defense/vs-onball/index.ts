// 対オンボール: ボールを持つ相手に付く守備者の動き。クッションを取ってドライブを切り、
// 密着すればボールを突く（リーチイン/スティール）。はたき合いは ./strip。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../../objects/player/player";
import { PALM_HITBOX, THREE_DIST } from "../../../config";
import { rate, clamp, chance, rand, dist2D, dist2DTo, moveToward2D, dirTo2D, towardPoint } from "../../../util";
import { twWeight, palmRadius, effShootRange, shotThreat, defHands, ballSecurity, leapHeight } from "../../../eval";
import { reachInFoulRate } from "../../../move/reaction/foul";
import { defensiveFoul } from "../../../core/deadball";
import { defEffort, denyIntensity, getBackOnDefense } from "../shared";
import type { Game } from "../../../game";

// オンボール守備: ハンドラーが攻める側へシェード(反応ラグ付き)、ゴールサイドを保って
// ドライブを切り、抜かれたら追って復帰。
export function defendOnBall(game: Game, dt: number, d: Player, man: Player, protect: Vector3): void {
  const effort = defEffort(game, d, protect);
  // アーク外の非シューターは脅威でない: 詰めずアークの内側(リムから約6.25m)でゾーン/ドライブを
  // 守り、ボールが運ばれても前(センター)へ迎えに出ない。3Pライン内(射程)に入るか本物の3P
  // シューターなら通常のタイト守備へ移る。「相手が3Pラインに入るまでゾーンを守る」を実現。
  const hRim = dist2D(man.pos, protect);
  const shooter3 = rate(man.attr.threeAcc) >= 0.82;
  if (hRim > THREE_DIST + 0.3 && !shooter3 && man.beatenT <= 0 && man.powerT <= 0) {
    const hold = hRim - (THREE_DIST - 0.5);   // アークの0.5m内側でボールとリムの間に立つ
    const t = towardPoint(man.pos.x, man.pos.z, protect.x, protect.z, hold);
    moveToward2D(d.pos, t.x, t.z, d.accelToward(dt, t.x, t.z, effort) * dt);
    game.clampCourt(d.pos);
    return;
  }
  // 反応ラグが切れたらハンドラーのドライブ側へシェードを合わせる
  if (d.reactT > 0) d.reactT -= dt * (game.teamHas(d.team, "dfLine") ? 1.3 : 1);
  else d.shadeSide = man.driveSide;

  // 体重を少しのシェードへ戻す。敏捷性が重心の戻る速さを決める。
  const targetLean = clamp(d.shadeSide * 0.3, -0.3, 0.3);
  const recover = (d.leanRecoverRate() + rate(d.attr.reaction) * 0.15) * dt;
  d.lean += clamp(targetLean - d.lean, -recover, recover);

  const { ux, uz } = dirTo2D(man.pos.x, man.pos.z, protect.x, protect.z);   // ハンドラー -> ゴール
  // lean をこのデュエルの横軸に乗せ、world 軸を最新に保つ。
  d.leanAxisX = -uz; d.leanAxisZ = ux;

  // クッションを保つ。ポスト/リム際で押してくるビッグにはタイトにボディアップ。
  const postUp = (game.isBig(man) || man.has("post")) && dist2D(man.pos, protect) < 5.5;
  // 密着限界: 守備能力 vs オフェンス能力。深いほどタイト、高い位置ではサグ。
  const diff = clamp(rate(d.attr.defense) - rate(man.attr.offense), -0.5, 0.5);
  const depth = clamp((dist2D(man.pos, protect) - 3) / 6, 0, 1);  // リムで0 .. 約9m超で1
  let gap = postUp
    ? 0.45 - game.tactics[d.team].defense.pressure * 0.1   // ポストでは約0.35(タイト)
    : (1.25 - game.tactics[d.team].defense.pressure * 0.35 - diff * 0.7)
      * (0.45 + 0.55 * depth);
  if (d.has("manMark")) gap *= 0.85;
  if (d.evalRole === "ロックダウン") gap *= 0.85;   // ストッパーは密着
  gap = clamp(gap, 0.3, 2.1);
  // DENY(ショットクロック終盤): 詰めて撃たせない。
  const dny = denyIntensity(game, d.team);
  if (dny > 0) {
    gap = Math.max(0.32, gap - dny * 0.7);
    if (man.beatenT <= 0 && man.powerT <= 0 && man.jukeT <= 0) {
      const edge = rate(man.attr.handling) * 0.5 + rate(man.attr.agility) * 0.4
        - rate(d.attr.agility) * 0.35 - rate(d.attr.defense) * 0.25;
      if (chance(clamp(dny * (0.55 + edge), 0, 0.7) * dt * 3)) {
        man.driveSide = game.pickSide(man);
        man.beatenT = rand(0.5, 0.85);
        d.applyReactLag();
        game.setDriveSide(man);
      }
    }
  }

  // 早仕掛けのギャンブル: 射程で構えるシューターに攻撃的守備が先に跳ぶ。
  if (!d.airborne && d.landT <= 0 && d.shovedT <= 0
      && man.beatenT <= 0 && man.powerT <= 0 && man.jukeT <= 0
      && dist2D(d.pos, man.pos) < 1.7
      && dist2D(man.pos, protect) <= effShootRange(man) + 0.3) {
    const threat = shotThreat(man);
    const gamble = (0.015 + rate(d.attr.aggression) * 0.045
      + game.tactics[d.team].defense.pressure * 0.02) * threat;
    if (chance(gamble * dt * 6)) {
      game.contestLeap(d, man.pos, leapHeight(d), 0.62);
    }
  }

  let tx: number, tz: number;
  if (man.beatenT > 0) {
    // 抜かれた: 切り返してハンドラーとゴールの間の点へ先回り
    tx = man.pos.x + (protect.x - man.pos.x) * 0.45;
    tz = man.pos.z + (protect.z - man.pos.z) * 0.45;
  } else {
    // ゴールサイドで、攻められている側を切るように積極的にスライド
    const lx = -uz, lz = ux;
    const mirror = 0.28 + rate(d.attr.agility) * 0.8 + rate(d.attr.reaction) * 0.22
      + (d.evalRole === "ロックダウン" ? 0.2 : 0);
    const cut = clamp(d.shadeSide * mirror + d.lean * 0.45, -1.1, 1.1) * 0.6;
    tx = man.pos.x + ux * gap + lx * cut;
    tz = man.pos.z + uz * gap + lz * cut;
  }
  const mult = (man.beatenT > 0 ? 1.06 + rate(d.attr.agility) * 0.12 : 1.05) * effort;
  moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, mult) * dt);
  game.clampCourt(d.pos);
}

// ハンドラーに付く1人ぶんの1フレーム。ゲットバック → クッション取り → リーチイン。
// 戻り値 true = スティール/ファウルで局面が変わった（この tick の守備処理を打ち切る）。
export function defendHandler(
  game: Game, dt: number, d: Player, man: Player, protect: Vector3, defTeam: number,
): boolean {
  // 抜かれてボールの後ろに取り残されたら、クッションで追うのでなく全力で自陣へ戻る(ゲットバック)。
  if (getBackOnDefense(game, dt, d, man)) return false;
  // 運び上げ中もセンターへ迎えに出ない: defendOnBall がアーク外の非シューターをアーク内側で
  // 待つ(ゾーン)ので、そのまま任せる。相手が射程に入ったら詰める。
  defendOnBall(game, dt, d, man, protect);
  // クッションからリーチイン(密着時にスティール/ファウル判定)。
  const press = game.tactics[defTeam].defense.pressure * twWeight(d);
  const gap = dist2D(d.pos, man.pos);
  const reach = PALM_HITBOX ? palmRadius(d, man) : 1.5;
  // スティール実行フレーム（発生=踏み込みの後）: まだ密着していれば突く、離れていれば空振り(隙)
  if (d.actKind === "steal" && d.actFired) {
    d.actFired = false;
    if (gap < reach && !man.airborne) { game.steal(d); return true; }
    d.reactT = Math.max(d.reactT, 0.3);   // 空振り: 踏み込んだ分の隙
  }
  if (gap < reach && d.shovedT <= 0) {           // 押し込まれ中は手を出せない
    const close = 1 - gap / reach;               // 密着1、端0
    const stl = defHands(d);
    const resist = ballSecurity(man);
    // クロスオーバー中はボールが露出。守備のクイックネスが上回った時だけ突ける。
    const exposed = man.jukeT > 0
      ? 1 + Math.max(0, rate(d.attr.agility) * 0.6 + rate(d.attr.reaction) * 0.4 - resist) * 2.2 : 1;
    const pPoke = Math.max(0.005, (0.03 + stl * 0.1 - resist * 0.06 + press * 0.05) * exposed);
    // キャリー位置: 守備のボールへの距離 vs 男への距離で突けるか決まる。
    const dBall = dist2DTo(d.pos, game.ball.pos.x, game.ball.pos.z);
    const carryMod = clamp(1 + (gap - dBall) * 1.2, 0.55, 1.6)
      * (man.baitT > 0 ? 1.6 : 1);
    // 発生: ポークの好機を掴んだら踏み込み開始（即スティールでなく溜め）。クールダウン中は不可。
    if (!d.actBusy("steal") && chance(pPoke * close * carryMod * dt)) {
      if (man.baitT > 0 && chance(0.35 + rate(man.attr.dribbleAcc) * 0.45)) {
        // 誘い成立: 見せたボールを引き、ハンドラーが抜く
        man.baitT = 0;
        const bx = game.ball.pos.x - d.pos.x, bz = game.ball.pos.z - d.pos.z;
        const bl = Math.hypot(bx, bz) || 1;
        d.leanAxisX = bx / bl;
        d.leanAxisZ = bz / bl;
        d.lean = 0.9;
        d.reactT = Math.max(d.reactT, 0.35);
        man.beatenT = Math.max(man.beatenT, 0.2 + rate(man.attr.agility) * 0.15);
      } else {
        d.beginAction("steal", 0.12, 0.03, 0.6);   // 踏み込み(0.12s)→突き→回復(0.6s)
        d.stealReachT = 0.30;                      // 溜めの間から手をボールへ出す（見える突き）
      }
    }
    if (chance(reachInFoulRate(press, close) * dt)) { defensiveFoul(game, man, d); return true; }
  }
  return false;
}
