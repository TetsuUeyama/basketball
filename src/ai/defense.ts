// man ディフェンス本体。ゾーン/プレスは defense-schemes、ピック&ロールのカバレッジは move/reaction/screen。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../objects/player/player";
import { RIM, PALM_HITBOX } from "../config";
import { rate, clamp, chance, rand, dist2D, dist2DTo, moveToward2D, dirTo2D, towardPoint } from "../util";
import { twWeight, palmRadius, effShootRange, stripEdge, shotThreat, defHands, ballSecurity, leapHeight } from "../eval";
import { reachInFoulRate } from "../move/reaction/foul";
import { tickScreenCoverage, defendScreen } from "../move/reaction/screen";
import { pickDefScheme, runZoneDefense, runPress } from "./defense-schemes";
import { defensiveFoul } from "../core/deadball";
import type { Game } from "../game";

// この守備者が今どれだけ守備で動くか(0..1)。
export function defEffort(game: Game, d: Player, protect: Vector3): number {
  if (game.quarter >= 4 && Math.abs(game.score[0] - game.score[1]) <= 6) return 1;   // 終盤接戦
  if (d.lockDef) return 1;                                  // 常時全力ロール
  const nearGoal = clamp(1 - dist2D(d.pos, protect) / 9, 0, 1); // リムで1
  // 守備ロールのギア(優先)
  if (d.defEffortGear !== undefined) {
    return clamp(d.defEffortGear + (1 - d.defEffortGear) * nearGoal, 0, 1);
  }
  // フォールバック(defRole未設定): スターは少し流す
  if (d.evalRole === "ロックダウン" || d.evalRole === "スイッチディフェンダー"
    || d.evalRole === "エナジーガイ" || d.evalRole === "3&D") return 1;
  const star = clamp((d.offPriority - 0.45) / 0.4, 0, 1);  // 0=ロール .. 1=スター
  if (star <= 0) return 1;
  const e = 0.68 + (0.9 - 0.68) * nearGoal;   // 流し 0.68 .. ゴール前 0.9
  return 1 - star * (1 - e);
}

// 今どれだけシュートを DENY しているか: ショットクロック終盤ほど deny 戦術値へ近づく。
export function denyIntensity(game: Game, defTeam: number): number {
  const t = Math.max(game.tactics[defTeam].defense.deny, 0.12);
  if (!game.frontT) return 0;
  const late = game.shotClock < 4.5 ? (4.5 - game.shotClock) / 4.5 : 0;
  return t * late;
}

// 強い deny でハンドラーが覆われ、綺麗に撃てない状態か。
export function denySmother(game: Game, h: Player, dDef: number): boolean {
  return denyIntensity(game, 1 - h.team) > 0.18 && dDef < 1.0;
}

// オンボール守備: ハンドラーが攻める側へシェード(反応ラグ付き)、ゴールサイドを保って
// ドライブを切り、抜かれたら追って復帰。
export function defendOnBall(game: Game, dt: number, d: Player, man: Player, protect: Vector3): void {
  const effort = defEffort(game, d, protect);
  // スターはバックコートでボールに圧をかけない。自陣内側で下がって待つ。
  const s0 = game.attackSign(game.possession);
  if (effort < 0.9 && man.pos.z * s0 < 0.3) {
    const wx = man.pos.x * 0.6, wz = s0 * 1.5;
    moveToward2D(d.pos, wx, wz, d.accelToward(dt, wx, wz, 0.9 * effort) * dt);
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
  if (!d.airborne && d.landT <= 0
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

// トランジション — まず戻る: 上に残っていた守備者が担当より先に自陣へ全力で戻る。ビッグはリム最優先。
// このフレームの移動を処理したら true。
export function getBackOnDefense(game: Game, dt: number, d: Player, man: Player): boolean {
  const s = game.attackSign(game.possession);  // 守備の自陣: z*s > 0
  const upCourt = d.pos.z * s < 0.5;           // まだハーフを越えていない
  const manBack = man.pos.z * s < 0.5;         // …担当も
  // 取り残された: (a) ボールが自分より自陣リム寄り＝抜かれてボールの後ろに取り残された、または
  // (b) 担当マンから大きく離れマークしていない(プレス/トラップで離れた)。どちらも全力で自陣へ戻る。
  const h = game.handler;
  const behindBall = !!h && s * h.pos.z > s * d.pos.z + 2.5;
  const offMan = dist2D(d.pos, man.pos) > 5;
  const stranded = upCourt && (behindBall || offMan);   // バックコート側に取り残された時だけ(ハーフコートの通常守備では発火しない)
  if (game.isBig(d) && (upCourt || manBack || stranded)) {
    const depth = d.role === "C" ? 1.6 : 3.0;
    const tz = s * (RIM.z - depth);
    const gb = game.steerAround(d, 0, tz);   // 体を避けて全力で戻る
    moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.15) * dt);
    game.clampCourt(d.pos);
    return true;
  }
  if ((upCourt && manBack) || stranded) {
    const gb = game.steerAround(d, man.pos.x * 0.4, s * (RIM.z - 7));
    moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.12) * dt);
    game.clampCourt(d.pos);
    return true;
  }
  return false;
}

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
      // 抜かれてボールの後ろに取り残されたら、クッションで追うのでなく全力で自陣へ戻る(ゲットバック)。
      if (getBackOnDefense(game, dt, d, man)) continue;
      // プレス非採用のボール運び中(!frontT)は前に出ず、自陣センター手前で受ける準備をする。
      // プレス相当の位置リスクだけ負って何もしない状態を避ける — 相手が越えてきたらマンマーク。
      if (!game.pressOn && !game.frontT) {
        const s = game.attackSign(game.possession);
        const wx = man.pos.x * 0.6, wz = s * 1.5;
        moveToward2D(d.pos, wx, wz, d.accelToward(dt, wx, wz, Math.max(defEffort(game, d, protect), 0.9)) * dt);
        game.clampCourt(d.pos);
        continue;
      }
      defendOnBall(game, dt, d, man, protect);
      // クッションからリーチイン(密着時にスティール/ファウル判定)。
      const press = game.tactics[defTeam].defense.pressure * twWeight(d);
      const gap = dist2D(d.pos, man.pos);
      const reach = PALM_HITBOX ? palmRadius(d, man) : 1.5;
      // スティール実行フレーム（発生=踏み込みの後）: まだ密着していれば突く、離れていれば空振り(隙)
      if (d.actKind === "steal" && d.actFired) {
        d.actFired = false;
        if (gap < reach && !man.airborne) { game.steal(d); return; }
        d.reactT = Math.max(d.reactT, 0.3);   // 空振り: 踏み込んだ分の隙
      }
      if (gap < reach) {
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
          }
        }
        if (chance(reachInFoulRate(press, close) * dt)) { defensiveFoul(game, man, d); return; }
      }
      continue;
    }

    // カバーリング: ボール守備が抜かれたら、カバー守備者が担当を捨ててドライブレーンへ
    if (game.handler && game.handler.beatenT > 0 && d.has("covering")) {
      const hx = game.handler.pos.x, hz = game.handler.pos.z;
      const t = 0.55;   // レーンの途中で迎える
      const ctx = hx + (protect.x - hx) * t, ctz = hz + (protect.z - hz) * t;
      moveToward2D(d.pos, ctx, ctz,
        d.accelToward(dt, ctx, ctz, 1.12 * Math.max(defEffort(game, d, protect), 0.9)) * dt);
      game.clampCourt(d.pos);
      continue;
    }

    // リムアンカー: 常時ペイントに残る壁役。ハンドラーがリムへ迫れば飛んでコンテスト、
    // 遠ければゴール下(リムと担当の間・リム寄り)に常駐してゴール下を空けない。
    if (d === anchor && game.handler) {
      const hx = game.handler.pos.x, hz = game.handler.pos.z;
      const dRim = dist2DTo(game.handler.pos, protect.x, protect.z);
      // リムプロテクターは飛ぶタイミングを計る
      if (!d.airborne && d.landT <= 0 && dRim < 4.5
          && dist2D(d.pos, game.handler.pos) < 2.6) {
        const timing = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.3;
        if (chance((0.35 + timing * 0.9) * dt * 3)) {
          game.contestLeap(d, game.handler.pos, leapHeight(d), 0.6);
        }
      }
      if (dRim < 8) {
        const rt = towardPoint(protect.x, protect.z, hx, hz, 2.0);
        const rtx = rt.x, rtz = rt.z;
        moveToward2D(d.pos, rtx, rtz,
          d.accelToward(dt, rtx, rtz, 1.1 * Math.max(defEffort(game, d, protect), 0.9)) * dt);
        game.clampCourt(d.pos);
        continue;
      }
      // ハンドラーが遠い(ハーフコート)時も、ローマンはペイント内に常駐して壁を作る:
      // リムと自分のマークの間の、リム寄りの点(≈2.6m)。ゴール下がスカスカにならない。
      {
        const hp = towardPoint(protect.x, protect.z, man.pos.x, man.pos.z, 2.6);
        moveToward2D(d.pos, hp.x, hp.z,
          d.accelToward(dt, hp.x, hp.z, 0.95 * Math.max(defEffort(game, d, protect), 0.8)) * dt);
        game.clampCourt(d.pos);
        continue;
      }
    }

    // プレス非採用のボール運び中(!frontT): 前に出ず自陣ハーフに沈んで守る。担当がまだセンター/
    // 相手側にいる間はマークに上がらず、自陣側へ越えてきたら通常のマン/ヘルプに移る。
    if (!game.pressOn && !game.frontT && game.handler) {
      const s = game.attackSign(game.possession);
      const manDepth = man.pos.z * s;            // 担当の自陣深さ(<0=相手バックコート)
      if (manDepth < 2.5) {
        const tz = s * clamp(4.0 - manDepth * 0.4, 2.0, 5.5);   // 自陣側に深く沈む(センターを越えない)
        const tx = man.pos.x * 0.5;
        moveToward2D(d.pos, tx, tz, d.accelToward(dt, tx, tz, Math.max(defEffort(game, d, protect), 0.9)) * dt);
        game.clampCourt(d.pos);
        d.decayLean(dt);
        continue;
      }
    }

    // 通路ブロック: 相手が横に回り込んだら、新しいレーンの入口へスライドして応じる
    if (d.wallT > 0) {
      moveToward2D(d.pos, d.wallX, d.wallZ,
        d.accelToward(dt, d.wallX, d.wallZ, 1.05 * Math.max(defEffort(game, d, protect), 0.85)) * dt);
      game.clampCourt(d.pos);
      continue;
    }

    // トランジション: ポゼッション交代で上に残っていたら、まず戻る
    if (getBackOnDefense(game, dt, d, man)) continue;

    // オフボール: ストロングサイド(ボール側)の1パスアウェイのみパスコースを DENY し、
    // ウィークサイド/遠い担当はゴール方向へ深くサグしてヘルプ(ボールを追って外に出ない)。
    // ハンドラーがライブドライブ中(抜き去り/パワー)は deny を止め、全員ヘルプサグでリムへ潰れる。
    const help = game.tactics[defTeam].defense.help * twWeight(d);
    const driveLive = !!game.handler && (game.handler.beatenT > 0 || game.handler.powerT > 0);
    const ballGap = game.handler ? dist2D(man.pos, game.handler.pos) : 99;
    // ボール側判定: 担当がボールと同じ左右(リム基準)か、ボールが中央付近ならストロングサイド扱い。
    let ballSide = true;
    if (game.handler) {
      const bx = game.handler.pos.x - protect.x, mx = man.pos.x - protect.x;
      ballSide = Math.abs(bx) < 1.5 || mx * bx >= 0;
    }
    let stx: number, stz: number;
    let denying = false;
    if (game.handler && !driveLive && ballSide && ballGap < 6.5 && ballGap > 0.8 && !man.airborne) {
      denying = true;
      // DENY: マークとボールの間のパスコースへ割って入り消す。ボール→マーク線上の、マークから
      // ボール側へ laneStep 出た点（レーンに体を入れる）。密着度＝守備+敏捷（振り切られない能力）。
      const lock = rate(d.attr.defense) * 0.55 + rate(d.attr.agility) * 0.45;
      // レーンへ割り込む距離: 良い守備ほど深くボール寄りでレーンを潰す（振り切られ中は浅くなる）。
      // マークが速く動く間はマーク近くでレーンに留まり(横ずれを抑える)、静止時は深く割り込む。
      const mv = Math.hypot(man.velX, man.velZ);
      // タイト寄り(マーク近く)にしてボール回転への追従遅れを抑える＝レーン上に留まる。
      const laneStep = clamp((0.7 + lock * 0.6 - man.shakeOpenT * 1.2) * (mv > 3 ? 0.7 : 1), 0.5, 1.3);
      const dn = towardPoint(man.pos.x, man.pos.z, game.handler.pos.x, game.handler.pos.z, laneStep);
      stx = dn.x; stz = dn.z;
    } else {
      // ヘルプサグ: ウィークサイド/遠いほど深くリムへ寄る。クロック終盤の DENY 強化も反映。
      const weak = !ballSide || ballGap > 6.5;
      const sag = (1.2 + help * 1.4 + (weak ? 1.2 : 0)) * (game.teamHas(defTeam, "dfLine") ? 1.15 : 1)
        * (1 - denyIntensity(game, defTeam) * 0.8);
      const st = towardPoint(man.pos.x, man.pos.z, protect.x, protect.z, sag);
      stx = st.x; stz = st.z;
    }
    // 進路 denial: 動いている男の行き先を影で追う(先読みは上限付き)。振り切り優位で読みが鈍る。
    // deny 中は先読みを弱めてボール→マークのレーン上に体を残す（レーンを塞ぐのが見えるように）。
    const mSpd = Math.hypot(man.velX, man.velZ);
    if (mSpd > 2.5) {
      const read = (0.15 + rate(d.attr.reaction) * 0.22 + rate(d.attr.defense) * 0.10)
        * (1 - man.shakeOpenT * 0.6) * (denying ? 0.4 : 1);
      const cap = Math.min(1, 2.0 / (mSpd * read || 1));   // 先読みは最大~2m
      stx += man.velX * read * cap;
      stz += man.velZ * read * cap;
    }
    // deny 中はレーンへ素早く寄せる（追従の横ずれを抑え、パスコースを塞ぐのが見えるように）。
    const eff = denying ? Math.max(defEffort(game, d, protect), 1.25) : defEffort(game, d, protect);
    moveToward2D(d.pos, stx, stz, d.accelToward(dt, stx, stz, eff) * dt);
    game.clampCourt(d.pos);
  }
}

// デッドボール気味(アウトレット/スローイン等)の守備: デュエルは無いが、ビッグは自陣へ
// 戻り、各自は担当のゴールサイドに付く。
export function runDefenseDuringDeadish(game: Game, dt: number): void {
  const defTeam = 1 - game.possession;
  const protect = game.attackFloor(game.possession);
  const defenders = game.teamPlayers(defTeam);
  const offense = game.teamPlayers(game.possession);
  for (const d of defenders) {
    // パスジャンパーはインターセプト地点へ走っている — 任せる
    if (game.ballMode === "pass" && game.passSteal?.def === d) continue;
    d.decayLean(dt);   // ボールが飛んでいる間は誰もデュエルしない
    const man = offense[d.slot];
    // アウトレット/スローインはビッグが自陣へ全力で戻る場面
    if (getBackOnDefense(game, dt, d, man)) continue;
    const gs = towardPoint(man.pos.x, man.pos.z, protect.x, protect.z, 1.5);
    moveToward2D(d.pos, gs.x, gs.z, d.accelSpeed(dt) * dt);
    game.clampCourt(d.pos);
  }
}

// ---------------------------------------------------------------------------
// スティール／ストリップ挙動: キャッチ際のコンテスト(catchStrips/deflectCatch/
// stealLunge)と、密集からのはたき(swarmStrips)。実際の奪取確定は Game.steal。
// ---------------------------------------------------------------------------

  // ハンドラーに寄せたオフボール守備者もボールを掘る(オンボール守備者のはたきは runDefense 内)。
  // ドリブルの合間、ボールが床近くにある時ほどはたきやすい。
export function swarmStrips(game: Game, dt: number): void {
    const h = game.handler;
    if (!h || game.ballMode !== "held") return;
    const onBall = game.onBallDefender(h);
    const exposed = game.ballInHand(h) ? 0.55 : 1.5;
    for (const d of game.teamPlayers(1 - h.team)) {
      if (d === onBall || d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.5) continue;
      const close = 1 - gap / 1.5;
      const p = Math.max(0, 0.02 + stripEdge(d, h) * 0.55);
      if (chance(p * close * exposed * dt)) { game.steal(d); return; }
    }
  }

  // 収まる前のスティール: ギャザー(gatherT)中でボールが不安定な間、密着守備者がはじく。
export function catchStrips(game: Game, dt: number): void {
    const h = game.handler;
    if (!h || game.ballMode !== "held" || h.gatherT <= 0) return;
    const bobble = clamp(h.gatherT * 2.4, 0.2, 1.3);       // ボールがまだどれだけ不安定か
    const b = game.ball.pos;
    // 担当守備者が踏み込んでルーズボールを掘る(飛び込むのは主担当のみ)。
    const onBall = game.onBallDefender(h);
    // レシーバーがボールを隠すため体を回した量(0 = 前に露出 .. 1 = 遠い腰に収めた)。
    const shielded = h.gatherDur > 0 ? clamp(1 - h.gatherT / h.gatherDur, 0, 1) : 1;
    const exposed = clamp(1 - shielded, 0, 1);
    for (const d of game.teamPlayers(1 - h.team)) {
      if (d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.8) continue;
      // ルーズボールを攻めに飛び込む(背中に這い上がらない)
      if (d === onBall && gap > 0.75) moveToward2D(d.pos, b.x, b.z, d.accelSpeed(dt, 1.2) * dt * 0.8);
      // はじき: 露出しているうちに手がボールに届けばはじく(反応/リーチ vs 隠す回転)。
      const toBall = dist2D(d.pos, b);
      if (toBall < 0.5) {
        const reach = 0.35 + rate(d.attr.reaction) * 0.65 - rate(h.attr.handling) * 0.4;
        if (chance(clamp(reach, 0.05, 0.9) * exposed * dt * 18)) { deflectCatch(game, h, d); return; }
      } else if (toBall < 1.15 && d.landT <= 0 && d.plantT <= 0) {
        // 届くか届かないか → 平行ジャンプステップでボールへ横っ飛び。手が届けばはじく。
        const gamble = rate(d.attr.reaction) * 0.5 + rate(d.attr.aggression) * 0.35;
        if (chance(clamp(gamble, 0.05, 0.9) * exposed * dt * 6)) {
          stealLunge(game, d, b.x, b.z);
          if (chance(clamp(0.7 - rate(h.attr.handling) * 0.5, 0.15, 0.8) * exposed)) { deflectCatch(game, h, d); return; }
          continue;   // 飛び込みは仕掛けたが、綺麗に手を掛けられなかった
        }
      }
      const close = 1 - clamp(gap / 1.8, 0, 1);
      const edge = 0.18 + stripEdge(d, h) * 0.65;     // 守備者の手 vs ハンドラーの安全性
      if (chance(Math.max(0, edge) * close * bobble * exposed * dt)) { deflectCatch(game, h, d); return; }
    }
  }

  // キャッチ際に触れた手がボールをはじく — ランダム方向へ飛び散るライブのルーズボール。
  // スティール/ターンオーバーは誰かが確保した時(secureLoose)にのみ記録。
export function deflectCatch(game: Game, h: Player, d: Player): void {
    // はじき方は手がボールのどこを捉えたかで決まる。方向は水平にランダム。
    const ang = rand(0, Math.PI * 2);
    const ballY = clamp(game.ball.pos.y, 0.35, 1.4);   // ボールが実際に在った位置から始める
    const contact = rand(0, 1);
    let vy: number, horiz: number;
    if (contact < 0.34) {                 // 下から捉えた → 上外へ跳ねる
      vy = rand(2.4, 4.6); horiz = rand(1.0, 3.2);
    } else if (contact < 0.67) {          // 側面をかすめた → ほぼ平行に飛ぶ
      vy = rand(-0.4, 0.9); horiz = rand(4.2, 7.5);
    } else {                              // 上から叩いた → 床へ叩き落とす
      vy = rand(-2.6, -0.6); horiz = rand(2.0, 5.0);
    }
    game.ball.pos.set(h.pos.x, ballY, h.pos.z);
    game.ball.vel.set(Math.cos(ang) * horiz, vy, Math.sin(ang) * horiz);
    game.lastTouch = d;
    h.touchCool = 0.5;                             // キャッチをはじかれた — すぐには再確保できない
    d.digReach(new Vector3(game.ball.pos.x, 0.9, game.ball.pos.z));
    game.goLoose(h.team, 1.8, { stealBy: d, victim: h, grabAfter: 0.6 });
  }

  // 平行ジャンプステップ: 届くか届かないかの距離から、守備者がボールへ横っ飛びし手を乗せる。
  // 復帰はクロスオーバーのプラント硬直(0.3秒速い .. 2.5秒遅い)を使う。
export function stealLunge(game: Game, d: Player, tx: number, tz: number): void {
    const dx = tx - d.pos.x, dz = tz - d.pos.z;
    const gap = Math.hypot(dx, dz) || 1;
    const leap = clamp(gap - 0.25, 0, 0.95);       // 手がボールに乗る跳躍
    d.jump(0.16, 0.3, (dx / gap) * leap, (dz / gap) * leap);   // 低い平行ジャンプステップ
    d.setPlant(0.3 + (1 - rate(d.attr.agility)) * 2.2);        // クロスオーバープラント硬直
  }
