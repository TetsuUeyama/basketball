// man ディフェンス本体。Option B: 状態は Game(=GameState)が持ち、ここは game を受け取る
// 関数群。ゾーン/プレスは defense-schemes、ピック&ロールのカバレッジは ScreenSystem。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../player";
import { RIM, PALM_HITBOX } from "../config";
import { rate } from "../attributes";
import { clamp, chance, rand, dist2D, dist2DTo, moveToward2D } from "../util";
import { twWeight, palmRadius, reactionLag, effShootRange, stripEdge } from "../eval";
import { reachInFoulRate } from "../reaction/foul";
import { pickDefScheme, runZoneDefense, runPress } from "./defense-schemes";
import { defensiveFoul } from "../core/deadball";
import type { Game } from "../game";

// この守備者が今どれだけ守備で動くか。オフェンスのスター(高オフェンス優先度)は脚を
// 温存して省エネ、ロールプレイヤー/3&Dは常時全力。自軍ゴール近く・4Q接戦は全員全力。
export function defEffort(game: Game, d: Player, protect: Vector3): number {
  if (game.quarter >= 4 && Math.abs(game.score[0] - game.score[1]) <= 6) return 1;   // 終盤接戦
  if (d.lockDef) return 1;                                  // 常時全力ロール
  const nearGoal = clamp(1 - dist2D(d.pos, protect) / 9, 0, 1); // リムで1
  // 守備ロールのギア(優先): 省エネは脚を温存、ツーウェイ/バランスは多く出す
  if (d.defEffortGear !== undefined) {
    return clamp(d.defEffortGear + (1 - d.defEffortGear) * nearGoal, 0, 1);
  }
  // 旧フォールバック(defRole未設定): オフェンスのスターは少し流す
  if (d.evalRole === "ロックダウン" || d.evalRole === "スイッチディフェンダー"
    || d.evalRole === "エナジーガイ" || d.evalRole === "3&D") return 1;
  const star = clamp((d.offPriority - 0.45) / 0.4, 0, 1);  // 0=ロール .. 1=スター
  if (star <= 0) return 1;
  const e = 0.68 + (0.9 - 0.68) * nearGoal;   // 流し 0.68 .. ゴール前 0.9
  return 1 - star * (1 - e);
}

// 今どれだけシュートを DENY しているか: deny 戦術を、ショットクロック終盤(撃たせず
// 時間切れを狙う価値がある時)にのみ上げる。序盤0、期限が近づくほど deny 値へ。
export function denyIntensity(game: Game, defTeam: number): number {
  const t = Math.max(game.tactics[defTeam].defense.deny, 0.12);
  if (!game.frontT) return 0;
  const late = game.shotClock < 4.5 ? (4.5 - game.shotClock) / 4.5 : 0;
  return t * late;
}

// 強い deny でハンドラーが完全に覆われ、綺麗な形で撃てない状態か。抜くか動かすか
// しかなく、どちらもできなければ時間切れ(ショットクロック違反=deny の報酬)。
export function denySmother(game: Game, h: Player, dDef: number): boolean {
  return denyIntensity(game, 1 - h.team) > 0.18 && dDef < 1.0;
}

// オンボール守備: ハンドラーが攻める側へシェード(反応ラグ付き)、ゴールサイドを保って
// ドライブを切り、抜かれたら追って復帰。
export function defendOnBall(game: Game, dt: number, d: Player, man: Player, protect: Vector3): void {
  const effort = defEffort(game, d, protect);
  // スターはバックコートでボールに圧をかけない(持ち運びを嫌がらせるのはロール/3&Dの仕事)。
  // 自陣内側で下がって待ち、キャッチで拾う。
  const s0 = game.attackSign(game.possession);
  if (effort < 0.9 && man.pos.z * s0 < 0.3) {
    const wx = man.pos.x * 0.6, wz = s0 * 1.5;
    moveToward2D(d.pos, wx, wz, d.accelToward(dt, wx, wz, 0.9 * effort) * dt);
    game.clampCourt(d.pos);
    return;
  }
  // 反応ラグが切れたらハンドラーのドライブ側へシェードを合わせる(DFライン general が速める)
  if (d.reactT > 0) d.reactT -= dt * (game.teamHas(d.team, "dfLine") ? 1.3 : 1);
  else d.shadeSide = man.driveSide;

  // バランス: 体重を少しのシェードへ戻す。クイックネス(敏捷性)が重心の戻る速さを決める。
  const targetLean = clamp(d.shadeSide * 0.3, -0.3, 0.3);
  const recover = (d.leanRecoverRate() + rate(d.attr.reaction) * 0.15) * dt;
  d.lean += clamp(targetLean - d.lean, -recover, recover);

  const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;        // ハンドラー -> ゴール
  // lean はこのデュエルの横軸に乗る。world 軸を最新に保ち movement(leanFactor)へ反映。
  d.leanAxisX = -uz; d.leanAxisZ = ux;

  // 適切なクッションを保つ(密着しすぎない)。ただしポスト/リム際で押してくるビッグには
  // タイトにボディアップ。攻撃的な戦術・マンマークはギャップを詰める。
  const postUp = (game.isBig(man) || man.has("post")) && dist2D(man.pos, protect) < 5.5;
  // 密着限界: どこまで詰めるかは守備能力 vs 相手のオフェンス能力。深い(ゴール近い)ほど
  // 全員がタイトに(レイアップは絶対に許さない)、高い位置ではミスマッチが大きなサグに。
  const diff = clamp(rate(d.attr.defense) - rate(man.attr.offense), -0.5, 0.5);
  const depth = clamp((dist2D(man.pos, protect) - 3) / 6, 0, 1);  // リムで0 .. 約9m超で1
  let gap = postUp
    ? 0.45 - game.tactics[d.team].defense.pressure * 0.1   // ポストでは約0.35(タイト)
    : (1.25 - game.tactics[d.team].defense.pressure * 0.35 - diff * 0.7)
      * (0.45 + 0.55 * depth);
  if (d.has("manMark")) gap *= 0.85;
  if (d.evalRole === "ロックダウン") gap *= 0.85;   // ストッパーは密着
  gap = clamp(gap, 0.3, 2.1);
  // DENY(ショットクロック終盤): 詰めて撃たせず時間切れを狙う。リスク: 詰めすぎは抜かれる。
  const dny = denyIntensity(game, d.team);
  if (dny > 0) {
    gap = Math.max(0.32, gap - dny * 0.7);
    if (man.beatenT <= 0 && man.powerT <= 0 && man.jukeT <= 0) {
      const edge = rate(man.attr.handling) * 0.5 + rate(man.attr.agility) * 0.4
        - rate(d.attr.agility) * 0.35 - rate(d.attr.defense) * 0.25;
      if (chance(clamp(dny * (0.55 + edge), 0, 0.7) * dt * 3)) {
        man.driveSide = game.pickSide(man);
        man.beatenT = rand(0.5, 0.85);
        d.reactT = Math.max(d.reactT, reactionLag(d));
        game.setDriveSide(man);
      }
    }
  }

  // 早仕掛けのギャンブル: 射程で構えるシューターに攻撃的守備が先に跳ぶ。今撃てば巨大な
  // コンテスト。だが床に置かれたらフローターを見送られる(decide が空中守備を突く)。
  if (!d.airborne && d.landT <= 0
      && man.beatenT <= 0 && man.powerT <= 0 && man.jukeT <= 0
      && dist2D(d.pos, man.pos) < 1.7
      && dist2D(man.pos, protect) <= effShootRange(man) + 0.3) {
    const threat = Math.max(rate(man.attr.threeAcc), rate(man.attr.midAcc));
    const gamble = (0.015 + rate(d.attr.aggression) * 0.045
      + game.tactics[d.team].defense.pressure * 0.02) * threat;
    if (chance(gamble * dt * 6)) {
      game.contestLeap(d, man.pos, 0.55 + rate(d.attr.jump) * 0.3, 0.62);
    }
  }

  let tx: number, tz: number;
  if (man.beatenT > 0) {
    // 抜かれた: 切り返して先回り(体に真っ直ぐでなく、ハンドラーとゴールの間の点へ)
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

// トランジション — まず戻る: ポゼッションが変わった時、上に残っていた守備者(グラス
// クラッシュ/ポストアップ直後)が担当より先に自陣へ全力で戻る。ビッグはリム最優先。
// このフレームの移動を処理したら true。
export function getBackOnDefense(game: Game, dt: number, d: Player, man: Player): boolean {
  const s = game.attackSign(game.possession);  // 守備の自陣: z*s > 0
  const upCourt = d.pos.z * s < 0.5;           // まだハーフを越えていない
  const manBack = man.pos.z * s < 0.5;         // …担当も
  if (game.isBig(d) && (upCourt || manBack)) {
    const depth = d.role === "C" ? 1.6 : 3.0;
    const tz = s * (RIM.z - depth);
    const gb = game.steerAround(d, 0, tz);   // 体を避けて全力で戻る
    moveToward2D(d.pos, gb.x, gb.z, d.accelToward(dt, gb.x, gb.z, 1.15) * dt);
    game.clampCourt(d.pos);
    return true;
  }
  if (upCourt && manBack) {
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
  game.screen.tickCoverage(dt);

  // 一度に一人のリムプロテクター: ハンドラーが抜いてドライブしたら、ボールとリムの間に
  // 最も良い位置の LOW MAN がローテして壁になる。ビッグ優先(−1.2m)、ガードしかいなければ
  // ガードが上がる。
  let rimHelper: Player | null = null;
  if (game.handler && (game.handler.beatenT > 0 || game.handler.powerT > 0)) {
    let best = Infinity;
    for (const d of defenders) {
      if (offense[d.slot] === game.handler) continue;   // 抜かれたオンボール以外
      const score = dist2D(d.pos, protect) - (game.isBig(d) ? 1.2 : 0);
      if (score < best) { best = score; rimHelper = d; }
    }
  }

  for (const d of defenders) {
    const man = offense[d.slot]; // index一致の man-to-man
    const isOnBall = man === game.handler;
    if (!isOnBall) d.decayLean(dt);

    // ピック&ロール: スクリーンの2守備者はカバレッジスキームで動く
    if (game.screen.cov && (d === game.screen.screenerDef || d === game.screen.handlerDef)) {
      game.screen.defend(dt, d, protect);
      continue;
    }

    if (isOnBall) {
      defendOnBall(game, dt, d, man, protect);
      // クッションからリーチイン: 鋭い反応/読みが多く奪う。D精度が守り、攻撃的戦術は
      // ギャンブル(そしてファウル)する。
      const press = game.tactics[defTeam].defense.pressure * twWeight(d);
      const gap = dist2D(d.pos, man.pos);
      const reach = PALM_HITBOX ? palmRadius(d, man) : 1.5;
      if (gap < reach) {
        const close = 1 - gap / reach;               // 密着1、端0
        const stl = rate(d.attr.reaction) * 0.45 + rate(d.attr.agility) * 0.35
          + rate(d.attr.defense) * 0.2;
        const resist = rate(man.attr.dribbleAcc) * 0.6 + rate(man.attr.handling) * 0.4
          + (man.has("keepDribble") ? 0.25 : 0);
        const slide = d.has("interceptor") ? 1.3 : 1;
        // クロスオーバー中はボールが露出。速い手が突くが、巧く速いハンドラーは紐で保つ
        // ので、守備のクイックネスが上回った時だけ突ける。
        const secure = rate(man.attr.dribbleAcc) * 0.5 + rate(man.attr.handling) * 0.3
          + rate(man.attr.agility) * 0.2;
        const exposed = man.jukeT > 0
          ? 1 + Math.max(0, rate(d.attr.agility) * 0.6 + rate(d.attr.reaction) * 0.4 - secure) * 2.2 : 1;
        const pPoke = Math.max(0.005, (0.03 + stl * 0.1 - resist * 0.06 + press * 0.05) * slide * exposed);
        // キャリー位置: 前に見せたボールは突かれ、遠い腰に隠したものは届かない(守備の
        // ボールへの距離 vs 男への距離で比較)。
        const dBall = dist2DTo(d.pos, game.ball.pos.x, game.ball.pos.z);
        const carryMod = clamp(1 + (gap - dBall) * 1.2, 0.55, 1.6)
          * (man.baitT > 0 ? 1.6 : 1);
        if (chance(pPoke * close * carryMod * dt)) {
          if (man.baitT > 0 && chance(0.35 + rate(man.attr.dribbleAcc) * 0.45)) {
            // 誘い成立: 見せたボールを引き、突っ込んだ守備の体重が乗る — ハンドラーが抜く
            man.baitT = 0;
            const bx = game.ball.pos.x - d.pos.x, bz = game.ball.pos.z - d.pos.z;
            const bl = Math.hypot(bx, bz) || 1;
            d.leanAxisX = bx / bl;
            d.leanAxisZ = bz / bl;
            d.lean = 0.9;
            d.reactT = Math.max(d.reactT, 0.35);
            man.beatenT = Math.max(man.beatenT, 0.2 + rate(man.attr.agility) * 0.15);
          } else {
            game.steal(d);
            return;
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

    // リム保護: ハンドラーが担当を抜いてリムへ迫ったら、オフボールのビッグが担当を捨てて
    // ボールとリムの間へ下がり壁になる。
    if (game.handler && d === rimHelper) {
      const hx = game.handler.pos.x, hz = game.handler.pos.z;
      const dRim = dist2DTo(game.handler.pos, protect.x, protect.z);
      // リムプロテクターは飛ぶタイミングを計る(早跳びは頂点で手、遅れると着地中)
      if (!d.airborne && d.landT <= 0 && dRim < 4.5
          && dist2D(d.pos, game.handler.pos) < 2.6) {
        const timing = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.3;
        if (chance((0.35 + timing * 0.9) * dt * 3)) {
          game.contestLeap(d, game.handler.pos, 0.55 + rate(d.attr.jump) * 0.3, 0.6);
        }
      }
      if (dRim < 8) {
        const dx = hx - protect.x, dz = hz - protect.z;
        const len = Math.hypot(dx, dz) || 1;
        const rtx = protect.x + (dx / len) * 2.0, rtz = protect.z + (dz / len) * 2.0;
        moveToward2D(d.pos, rtx, rtz,
          d.accelToward(dt, rtx, rtz, 1.1 * Math.max(defEffort(game, d, protect), 0.9)) * dt);
        game.clampCourt(d.pos);
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

    // オフボール: ゴール方向へサグしてヘルプ。ハイヘルプ戦術ほど大きく、連携の高い者ほど
    // 忠実に、DFライン general が一段深く整える。
    const help = game.tactics[defTeam].defense.help * twWeight(d);
    // クロック終盤の DENY: ヘルプサグを外して担当に密着しボールを拒否
    const sag = (1.2 + help * 1.4) * (game.teamHas(defTeam, "dfLine") ? 1.15 : 1)
      * (1 - denyIntensity(game, defTeam) * 0.8);
    const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    let stx = man.pos.x + (dx / len) * sag, stz = man.pos.z + (dz / len) * sag;
    // 進路 denial: 動いている男(カッター/走者)は行き先を影で追う。反応/守判断で先読み量が
    // 決まり、スプリンターの前へワープしないよう上限。
    const mSpd = Math.hypot(man.velX, man.velZ);
    if (mSpd > 2.5) {
      const read = 0.15 + rate(d.attr.reaction) * 0.22 + rate(d.attr.defense) * 0.10;
      const cap = Math.min(1, 2.0 / (mSpd * read || 1));   // 先読みは最大~2m
      stx += man.velX * read * cap;
      stz += man.velZ * read * cap;
    }
    moveToward2D(d.pos, stx, stz, d.accelToward(dt, stx, stz, defEffort(game, d, protect)) * dt);
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
    const dx = protect.x - man.pos.x, dz = protect.z - man.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    moveToward2D(d.pos, man.pos.x + (dx / len) * 1.5, man.pos.z + (dz / len) * 1.5,
      d.accelSpeed(dt) * dt);
    game.clampCourt(d.pos);
  }
}

// ---------------------------------------------------------------------------
// スティール／ストリップ挙動: キャッチ際のコンテスト(catchStrips/deflectCatch/
// stealLunge)と、密集からのはたき(swarmStrips)。実際の奪取確定は Game.steal。
// ---------------------------------------------------------------------------

  // ハンドラーに寄せてきたオフボール守備者もボールを掘る。2〜3人に群がられると
  // 下手なハンドラーには本当に危険で、上手い選手にはほとんど苦にならない
  // (オンボール守備者自身のはたきは runDefense 内)。
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

  // 収まる前のスティール: レシーバーがまだ弾いたキャッチ(gatherT)を捕まえきれて
  // いない間、ボールは手の中で不安定 — 密着した守備者なら誰でも掘り出してはじく
  // (綺麗なピックではなくライブのルーズボール)。もたつき(硬直の深さ)が大きく、技術が
  // 守備者の手に対して弱いほど起こりやすい。綺麗なキャッチ(gatherT≈0)ではこの露出は無い。
export function catchStrips(game: Game, dt: number): void {
    const h = game.handler;
    if (!h || game.ballMode !== "held" || h.gatherT <= 0) return;
    const bobble = clamp(h.gatherT * 2.4, 0.2, 1.3);       // ボールがまだどれだけ不安定か
    const b = game.ball.pos;
    // 担当守備者がもたつきに跳びかかる: 踏み込んでルーズボールを掘る(リーチのポーズは
    // poseHands 内、同じ gatherT でゲート)。近くのヘルプ守備者も突けるが、飛び込むのは
    // 主担当のみ。
    const onBall = game.onBallDefender(h);
    // レシーバーがボールを隠すためにどれだけ体を回したか(0 = 取った直後で前に露出、
    // 1 = 遠い腰に収めた)。速いハンドラー/短いギャザーはほぼ即座に隠す。弾いた
    // キャッチは長く露出したまま。
    const shielded = h.gatherDur > 0 ? clamp(1 - h.gatherT / h.gatherDur, 0, 1) : 1;
    const exposed = clamp(1 - shielded, 0, 1);
    for (const d of game.teamPlayers(1 - h.team)) {
      if (d.airborne) continue;
      const gap = dist2D(d.pos, h.pos);
      if (gap > 1.8) continue;
      // ルーズボールを攻めに飛び込む(背中に這い上がらない)
      if (d === onBall && gap > 0.75) moveToward2D(d.pos, b.x, b.z, d.accelSpeed(dt, 1.2) * dt * 0.8);
      // CONTACT はじき: まだ露出している(隠されていない)うちに手がボールに届く
      // → はじく(彼に収まるのではなく飛び散るライブのルーズボール)。競争は
      // 反応/リーチ vs レシーバーの隠す回転: 密着して反応の速い者は収められる前に届く。
      // 一度隠されれば(露出→0)安全で、確かなハンドラー(技術)はいずれにせよ守る。
      const toBall = dist2D(d.pos, b);
      if (toBall < 0.5) {
        const reach = 0.35 + rate(d.attr.reaction) * 0.65 - rate(h.attr.handling) * 0.4;
        if (chance(clamp(reach, 0.05, 0.9) * exposed * dt * 18)) { deflectCatch(game, h, d); return; }
      } else if (toBall < 1.15 && d.landT <= 0 && d.plantT <= 0) {
        // 届くか届かないか → 平行ジャンプステップ: ボールへ横っ飛びをギャンブル
        // (反応/攻撃性が行くか決める)。手が届けばはじく。いずれにせよ飛び込みは
        // 確定(stealLunge のクロスオーバープラント硬直)。
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

  // キャッチ際にボールに触れた手がはじく — ほぼランダムな方向へ飛び散るライブの
  // ルーズボール(はじき)であって、ドリブルのはたきのように守備者へ綺麗に収まるの
  // ではない。着地すれば全員が競り合う。スティール/ターンオーバーは誰かが確保した
  // 時(secureLoose)にのみ記録される。
export function deflectCatch(game: Game, h: Player, d: Player): void {
    // はじき方は手がボールのどこを捉えたかで決まる。下から入った手は上へ弾き、
    // 側面をかすめた手はほぼ床と平行に飛ばし、上から叩いた手は下へ叩き落として
    // 転がす。方向は水平にランダム。威力は軽く触れる程度から強打まで様々。
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

  // 平行ジャンプステップ: 届くか届かないかの距離からのスティール — 守備者が踏み切って
  // ボールへ横っ飛び(低く、正対を保った斜めのジャンプステップ)し、手を乗せる。
  // 確定したギャンブルなので、復帰はクロスオーバーのプラント処理(動き直し)を使う —
  // 鋭いカットと同じ 0.3秒(速い) .. 2.5秒(遅い) の硬直。
export function stealLunge(game: Game, d: Player, tx: number, tz: number): void {
    const dx = tx - d.pos.x, dz = tz - d.pos.z;
    const gap = Math.hypot(dx, dz) || 1;
    const leap = clamp(gap - 0.25, 0, 0.95);       // 手がボールに乗る跳躍
    d.jump(0.16, 0.3, (dx / gap) * leap, (dz / gap) * leap);   // 低い平行ジャンプステップ
    d.setPlant(0.3 + (1 - rate(d.attr.agility)) * 2.2);        // クロスオーバープラント硬直
  }
