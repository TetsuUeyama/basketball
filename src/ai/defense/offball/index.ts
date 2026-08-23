// オフボール守備: ボールを持たない相手に付く1人ぶんの1フレーム。カバーリング(ドライブの
// ヘルプ)、リムアンカー(常時ペイント)、通路ブロック、ゲットバック、そして DENY / ヘルプサグ。
import { Vector3 } from "@babylonjs/core";
import { Player } from "../../../objects/player/player";
import { rate, clamp, chance, dist2D, dist2DTo, moveToward2D, towardPoint } from "../../../util";
import { twWeight, leapHeight } from "../../../eval";
import { defEffort, denyIntensity, getBackOnDefense } from "../shared";
import type { Game } from "../../../game";

// anchor は今このポゼッションでリムに残す1人（runDefense が毎tick選ぶ）。
export function defendOffBall(
  game: Game, dt: number, d: Player, man: Player, protect: Vector3,
  defTeam: number, anchor: Player | null,
): void {
  // カバーリング: ボール守備が抜かれたら、カバー守備者が担当を捨ててドライブレーンへ
  if (game.handler && game.handler.beatenT > 0 && d.has("covering")) {
    const hx = game.handler.pos.x, hz = game.handler.pos.z;
    const t = 0.55;   // レーンの途中で迎える
    const ctx = hx + (protect.x - hx) * t, ctz = hz + (protect.z - hz) * t;
    moveToward2D(d.pos, ctx, ctz,
      d.accelToward(dt, ctx, ctz, 1.12 * Math.max(defEffort(game, d, protect), 0.9)) * dt);
    game.clampCourt(d.pos);
    return;
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
      return;
    }
    // ハンドラーが遠い(ハーフコート)時も、ローマンはペイント内に常駐して壁を作る:
    // リムと自分のマークの間の、リム寄りの点(≈2.6m)。ゴール下がスカスカにならない。
    {
      const hp = towardPoint(protect.x, protect.z, man.pos.x, man.pos.z, 2.6);
      moveToward2D(d.pos, hp.x, hp.z,
        d.accelToward(dt, hp.x, hp.z, 0.95 * Math.max(defEffort(game, d, protect), 0.8)) * dt);
      game.clampCourt(d.pos);
      return;
    }
  }

  // 通路ブロック: 相手が横に回り込んだら、新しいレーンの入口へスライドして応じる
  if (d.wallT > 0) {
    moveToward2D(d.pos, d.wallX, d.wallZ,
      d.accelToward(dt, d.wallX, d.wallZ, 1.05 * Math.max(defEffort(game, d, protect), 0.85)) * dt);
    game.clampCourt(d.pos);
    return;
  }

  // トランジション: ポゼッション交代で上に残っていたら、まず戻る
  if (getBackOnDefense(game, dt, d, man)) return;

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
  // パック・ザ・ペイント: ペイント/得点圏(リムから4.5m内)の脅威か本物の3Pシューターの時だけ付く。
  // 周辺(アーク付近含む)の非シューターは脅威でないので付かず deny もせず、3Pラインの内側へ深く
  // サグしてゾーン/リムを守る(釣り出されない)。
  const mRim = dist2D(man.pos, protect);
  const shooter3 = rate(man.attr.threeAcc) >= 0.82;   // 上位1割の3Pシューターのみ外まで付く
  const pickup = mRim < 4.5 || shooter3;
  let stx: number, stz: number;
  let denying = false;
  if (game.handler && !driveLive && ballSide && ballGap < 6.5 && ballGap > 0.8 && !man.airborne && pickup) {
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
    // 非脅威(アーク外の非シューター)は3Pラインの内側までしか付かない=ゾーン/リムを守る。
    if (!pickup) {
      const maxR = 5.0;   // アークより十分内側(ヘルプ/ゾーン)まで詰める
      const dR = dist2DTo(protect, stx, stz);
      if (dR > maxR) { const k = maxR / (dR || 1); stx = protect.x + (stx - protect.x) * k; stz = protect.z + (stz - protect.z) * k; }
    }
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
