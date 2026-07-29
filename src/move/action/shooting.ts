// シュート機構（方式B: GameState 集約）。ジャンプショットのため/放ち/飛翔/着弾判定、
// リムフィニッシュ、コンテスト/ブロック、シューティングファウル、アシスト評価までを
// 関数として集約。状態は Game に集約し各関数は第一引数 game を受け取る。
// contestLeap は defense からも使うため Game 残置（game.contestLeap 経由）。
import { Player } from "../../objects/player/player";
import { RIM, THREE_DIST, PALM_HITBOX, SHOT_SET_Y, SHOT_GATHER_Y, BUZZER_WINDOW } from "../../config";
import { rate, clamp, dist2D, moveToward2D, chance, rand } from "../../util";
import { shotWindupFor, defHands, leapHeight } from "../../eval";
import { jumpShotMakeProbability, rimFinishOutcome } from "../reaction/shot-outcome";
import { bestBlocker, evadeBlockProbability } from "../reaction/contest-block";
import { shootingFoulChance } from "../reaction/foul";
import { endQuarter } from "../../core/gameflow";
import { swishNet, flashScore, flashBall } from "../../core/visuals";
import { benchCheer } from "../../core/bench";
import { withSubs } from "../../systems/subs";
import type { Game } from "../../game";

// ---- シュート種別（距離ベース） -------------------------------------------
// 距離でリム下(ダンク/レイアップ)・ミドル・3Pを使い分ける。ダンク/レイアップの
// 枝分かれは rimFinishOutcome が抽選、ミドル/3P は THREE_DIST 境界で分ける。
// ブザービーターは横断的な修飾(buzzer フラグ)、フリースローは別フェーズ。
export type ShotType = "dunk" | "layup" | "midrange" | "three";

// ジャンパーの距離種別。リム下フィニッシュは finishAtRim が別途 dunk/layup を決める。
function jumperType(dHoop: number): ShotType {
  return dHoop > THREE_DIST ? "three" : "midrange";
}

// 種別ごとの実行パラメータ。apex(弾道頂点m)/dur(飛翔s)は far(=THREE_DIST からの
// 超過m、ミドル/リムは0)で可変。
const SHOT_PARAMS: Record<ShotType, {
  points: number;                                   // 得点
  liveLabel: string | null;                         // 発動時の即時バナー（ジャンパーは null＝着弾時に判定）
  apex: (h: Player, far: number) => number;         // 弾道頂点(m)
  dur: (far: number, evaded: boolean) => number;    // 飛翔時間(s)。evaded＝ダブルクラッチ
}> = {
  dunk:     { points: 2, liveLabel: "DUNK!",  apex: () => 0.25, dur: (_f, ev) => 0.45 + (ev ? 0.14 : 0) },
  layup:    { points: 2, liveLabel: "LAYUP",  apex: () => 0.7,  dur: (_f, ev) => 0.55 + (ev ? 0.14 : 0) },
  midrange: { points: 2, liveLabel: null,     apex: (h) => 1.6 + rate(h.attr.bank) * 1.2,                   dur: () => 0.85 },
  three:    { points: 3, liveLabel: null,     apex: (h, far) => 1.6 + rate(h.attr.bank) * 1.2 + far * 0.45, dur: (far) => 0.85 + far * 0.11 },
};

// 溜め中のボールに守備者の手が届く間合い。ここまで詰められると stripGather の対象。
const STRIP_RANGE = 1.3;

export function shoot(game: Game, h: Player, dHoop: number, dDef: number): void {
    const windup = shotWindupFor(h, dHoop);
    // ブザービーター: ギャザーの時間が無い — ホーンと同時に投げ上げる。準備は全く
    // 出来ていない(prepDone=0)ので、必要準備が長いほど(深いほど)精度は急落する。
    if (game.gameClock > 0 && game.gameClock < BUZZER_WINDOW) {
      game.shotWindup = windup;
      releaseShot(game, h, dHoop, dDef, 0);
      return;
    }
    game.shotWindup = windup;
    game.chargeHeld = 0;
    game.chargeShooter = h;
    game.chargeDHoop = dHoop;
    game.chargeDDef = dDef;
    game.chargeT = windup;
    game.shooter = h;              // ギャザー中のポーズの所有者
    game.handler = null;
    game.ballMode = "charge";
    // ボールは胸前・低めのポケットで構える（溜め中は前・低いまま、リリースで頭上へ）
    setChargeBall(game, h);
  }

  // 溜め中のボール位置＋負荷。頭上に上げず、胸前・低めで前に構える。進捗とともに
  // 少し沈み、前傾／沈み込みの深さ(shootLoadTarget)も進捗で設定する（sync が姿勢に反映）。
  // リリースで一気に頭上やや前へ上がる（releaseShot / shot アーク側）。
export function setChargeBall(game: Game, h: Player): void {
    const w = game.shotWindup || 0.001;
    const p = clamp(1 - game.chargeT / w, 0, 1);   // ギャザー開始0 → リリース1
    h.shootLoadTarget = p;
    const rim = game.attackFloor(h.team);
    const fx = rim.x - h.pos.x, fz = rim.z - h.pos.z, fl = Math.hypot(fx, fz) || 1;
    // おなかの少し前で両手に抱える。リリースで releaseShot が頭上へ持ち上げる。
    const front = 0.24;                            // おなかの少し前
    const y = SHOT_GATHER_Y - 0.12 + p * 0.05;     // おなか〜みぞおちの高さ(≈1.08→1.13)
    game.ball.pos.set(h.pos.x + (fx / fl) * front, y, h.pos.z + (fz / fl) * front);
  }

  // ギャザーの1フレーム: ボールを溜めたまま保持し、守備者にシュートを読ませて
  // クローズアウト/コンテストさせる。重心を崩された守備者は間に合わない。
export function updateCharge(game: Game, dt: number): void {
    const h = game.chargeShooter;
    if (!h) { game.ballMode = "held"; return; }
    game.chargeT -= dt;
    setChargeBall(game, h);   // 胸前・低めで構え、進捗で前傾＋沈み込みを深める
    // トランジション戻りを溜め(シュートモーション)開始から効かせて判定を早める:
    // リムを競らない味方が攻撃性に応じて自陣へ戻り始める(速攻を守る)。
    for (const p of game.teamPlayers(h.team)) { if (p !== h) game.retreatOnShot(p, dt); }
    // コンテスト候補: シューターの担当守備者と、最寄りの守備者。溜め中は updateCharge しか
    // 動かない(他守備者は停止)ため、担当がサグ/振り切られて離れていても、近くの助けが
    // クローズアウト＆コンテストに飛べるよう最寄りも動かす。
    const man = game.teamPlayers(1 - h.team)[h.slot];   // シューターの担当守備者
    const nd = game.nearestDefender(h);
    const ndGap = nd ? dist2D(nd.pos, h.pos) : 99;
    const beaten = h.beatenT > 0 || h.powerT > 0;       // 抜き去った担当 → クローズアウトが遅れる
    // 目の前まで詰められたら溜めを打ち切って即リリース。はたかれる(stripGather)より、
    // 準備不足ぶんの精度低下を受け入れる。見切る間合いは反応で決まり、鈍い選手は
    // はたかれる間合い(STRIP_RANGE)まで詰められてから放つので隙が残る。
    if (game.chargeT > 0 && ndGap < 1.05 + rate(h.attr.reaction) * 0.55) {
      releaseShot(game, h, game.chargeDHoop, game.chargeDDef, game.shotWindup - game.chargeT);
      return;
    }
    const contesters: Player[] = [];
    if (man && !beaten) contesters.push(man);           // 担当: 抜かれていなければ閉じる
    if (nd && nd !== man) contesters.push(nd);          // 最寄りの助け: 担当が離れていても飛べる
    for (const c of contesters) {
      if (c.airborne || c.landT > 0) continue;
      const gap = dist2D(c.pos, h.pos);
      // シューターへ強くクローズアウト
      if (gap > 0.75) {
        moveToward2D(c.pos, h.pos.x, h.pos.z, c.accelToward(dt, h.pos.x, h.pos.z, 1.15) * dt);
        game.clampCourt(c.pos);
      }
      // リリースが近づいたら、間に合わなくても(だめもと)踏み切って挑む。近ければ真上でコンテスト、
      // 遠ければ横っ飛び(contestLeap が最大1.5mランジ)。フリーで撃たせないため間合い(~3.6m)と
      // 窓(~0.22s)を広げ、遠いシューターにも跳ぶ。
      if (game.chargeT < 0.22 && gap < 3.6) {
        const read = rate(c.attr.reaction) * 0.5 + rate(c.attr.defense) * 0.5;
        const near = clamp(1 - (gap - 1.0) / 2.6, 0.35, 1);   // 近いほど確実、遠いだめもとでも最低35%係数
        if (chance((0.25 + read * 1.5) * near * dt * 9)) game.contestLeap(c, h.pos, leapHeight(c), 0.6);
      }
      // ギャザー中のストリップ: 頭上に溜められたボールを守備者がはたく。長いギャザーほど
      // 弾かれやすく、高いボールに届く必要がある(空中だと有利)。背の高いシューターは遠ざける。
      if (gap < STRIP_RANGE) {
        // 打つ前に手がボールに当たれば弾いて打たせない(はたき出し=ルーズへ)。
        const poke = defHands(c);
        const secure = rate(h.attr.handling) * 0.5 + clamp((h.height - c.height) * 0.6, -0.15, 0.35);
        const reach = c.airborne ? 1.4 : 0.7;   // 跳べば頭上のボールにも届く。立ちでも手が当たれば弾く
        if (chance(Math.max(0, poke - secure) * reach * dt * 5)) { stripGather(game, h, c); return; }
      }
    }
    // リリース判断: 溜め完了(chargeT≤0)で通常リリース。状況で早め(急ぎ撃ち)/遅め(ホールド)。
    const gap = ndGap;
    const panic = game.shotClock < 0.5 || (game.gameClock > 0 && game.gameClock < BUZZER_WINDOW);
    const blockImminent = !!nd && nd.airborne && gap < 1.6;   // 守備者が跳んでブロックに来た
    if (game.chargeT > 0) {
      // 溜め未完。クロック逼迫かブロック差し込みなら早めリリース(不足分だけ精度低下)。
      if (panic || blockImminent) {
        releaseShot(game, h, game.chargeDHoop, game.chargeDDef, game.shotWindup - game.chargeT);
      }
      return;   // それ以外は溜め継続(次フレームで chargeT が減る)
    }
    // 溜め完了。どフリー(2.5m以上)かつ余裕があればさらにホールドして精度微増(上限0.4秒)。
    if (gap > 2.5 && !panic && !blockImminent && game.chargeHeld < 0.4) {
      game.chargeHeld += dt;
      return;
    }
    releaseShot(game, h, game.chargeDHoop, game.chargeDDef, game.shotWindup + game.chargeHeld);
  }

  // 溜めた(頭上の)ボールがリリース前にシューターの手から叩き出される —
  // ライブのルーズボールが、はじいた守備者の方へ飛び散る。
export function stripGather(game: Game, h: Player, d: Player): void {
    game.chargeShooter = null;
    d.stats.stl++;
    const ax = d.pos.x - h.pos.x, az = d.pos.z - h.pos.z;
    const len = Math.hypot(ax, az) || 1;
    const grip = clamp(0.2 + rate(d.attr.reaction) * 0.6 - rate(h.attr.handling) * 0.3, 0.05, 0.9);
    const power = rand(2.8, 4.8);   // 大きく弾き飛ばしルーズボールを本物の争奪にする
    game.ball.pos.set(h.pos.x, SHOT_SET_Y, h.pos.z);
    game.ball.vel.set((ax / len) * power * grip + rand(-1, 1) * (1 - grip), rand(-0.4, 0.9),
                      (az / len) * power * grip + rand(-1, 1) * (1 - grip));
    game.setEvent("STRIP!", d.team);
    game.lastTouch = d;   // はたいた者が最後に触れた
    h.touchCool = 0.4;
    game.goLoose(h.team, 1.6, { stealBy: d, victim: h, grabAfter: 0.35 });
  }

export function releaseShot(game: Game, h: Player, dHoop: number, dDef: number, prepDone?: number): void {
    game.chargeShooter = null;
    // 準備の充足度: 溜め切れば req=done で不足0。急ぎ撃ちは不足、どフリー延長は余剰。
    const req = game.shotWindup || 0;
    const done = prepDone ?? req;
    const prepShort = Math.max(0, req - done);
    const prepExtra = Math.max(0, done - req);
    game.pendingAssist = assistCreditFor(game, h);
    const shotType = jumperType(dHoop);   // "midrange" | "three"（距離で使い分け）
    const isThree = shotType === "three";
    game.shotPoints = SHOT_PARAMS[shotType].points;
    game.shotWasDunk = false;   // ダンクでなくジャンプショット

    // make% は効果層(resolution/shot-outcome)へ分離。ここでは文脈(最寄り守備者・
    // ヘルプ人数・クラッチ・ブザー・手のひら判定)を渡して確率だけ受け取り、抽選する。
    const p = jumpShotMakeProbability(h, dHoop, dDef, {
      nearestDef: game.nearestDefender(h),
      helpCount: game.defendersWithin(h, 2.4),
      clutch: game.clutchFactor(h),
      prepShort, prepExtra,
      palmHitbox: PALM_HITBOX,
    });
    game.shotMade = chance(p);

    game.shooter = h;   // 今シュートを所有する — ブロックが彼のフォロースルーを固める
    game.lastTouch = h;   // シューターが最後に触れた(エアボールで外へ → 相手ボール)
    // ミドル/ゴール下のジャンプシュートも、レイアップ/ダンク同様に S技術 で
    // ブロックをかわして打てる（3Pは対象外）。
    const blocker = tryBlock(game, h, false, !isThree);
    if (blocker) { swatShot(game, h, blocker); return; }
    grazeShot(game, h);   // かすり: 手が触れれば軌道が乱れて外れる(スワットには至らない部分接触)
    if (tryShootingFoul(game, h, dDef, false)) return;

    // リリースは頭上やや前（利き手を前へ伸ばして放つ）
    const frim = game.attackFloor(h.team);
    const rfx = frim.x - h.pos.x, rfz = frim.z - h.pos.z, rfl = Math.hypot(rfx, rfz) || 1;
    game.shotFrom.set(h.pos.x + (rfx / rfl) * 0.18, 2.05, h.pos.z + (rfz / rfl) * 0.18);
    aimShotTarget(game, dHoop);   // 決まればリム、ロングミスはリムから大きく外れた点へ
    game.shotT = 0;
    // アークの外ではボールは弾くのでなく放り投げる: 遠いほど高く遅い放物線。
    // アークの内側は変わらない(far = 0)。
    const far = Math.min(12, Math.max(0, dHoop - THREE_DIST));
    // 弾道時間・高さは種別テーブル(SHOT_PARAMS)から。3Pは far で山なりに上がる。
    // ジャンパーは evaded を持たない(false)。
    game.shotDur = SHOT_PARAMS[shotType].dur(far, false);
    game.shotApex = SHOT_PARAMS[shotType].apex(h, far);
    game.longShot = far > 0.5;   // ボールカメラが追うべきほど深い
    game.longShotHoldT = 0;      // 新しい飛翔がカメラの制御を持つ

    game.ballMode = "shot";
    game.shooter = h;
    game.shooterFinishing = false;
    game.handler = null;
    h.jump(0.4, 0.8);          // シューターはジャンプショットで跳ぶ
    contestJump(game, h);       // 最寄りの守備者がコンテスト
    // フォロースルー: シューターは飛翔と着地の間その場に留まる
    h.coolT = game.shotDur + rand(0.4, 0.7) * h.recoveryMult();
    // ボールが空中にある間、味方も守備者もボードへ突っ込める
  }

  // レイアップまたはダンク: 平坦で速いアークによるリムでの高確率フィニッシュ。
export function finishAtRim(game: Game, h: Player, dDef: number): void {
    game.pendingAssist = assistCreditFor(game, h);
    game.shotPoints = 2;
    // make% とダンク判定は効果層(resolution/shot-outcome)へ分離。文脈(最寄り守備者・
    // 人だかり・クラッチ)を渡し、dunk フラグと確率を受け取って抽選する。
    const { dunk, p } = rimFinishOutcome(h, dDef, {
      nearestDef: game.nearestDefender(h),
      crowd: game.defendersWithin(h, 2.4),
      clutch: game.clutchFactor(h),
    });
    const shotType: ShotType = dunk ? "dunk" : "layup";   // リム下は能力・レーンで枝分かれ
    game.shotWasDunk = dunk;   // ダンクはベンチの盛り上がりが大きい
    game.shotMade = chance(p);

    game.shooter = h;   // 今シュートを所有する — ブロックが彼のフォロースルーを固める
    game.lastTouch = h;   // シューターが最後に触れた(エアボールで外へ → 相手ボール)
    game.evadedFinish = false;
    const blocker = tryBlock(game, h, true);
    if (blocker) { swatShot(game, h, blocker); return; }
    if (tryShootingFoul(game, h, dDef, true)) return;

    game.shotFrom.set(h.pos.x, dunk ? 2.6 : 1.7, h.pos.z);
    game.shotT = 0;
    // かわしたブロックはダブルクラッチに見える — 一拍長く滞空してから決める
    game.shotDur = SHOT_PARAMS[shotType].dur(0, game.evadedFinish);
    game.shotApex = SHOT_PARAMS[shotType].apex(h, 0);
    // リムの手前(進入側)で踏み切り、ボールをゴールへ伸ばす。ダンカーはより近づく。
    // すでにリム真下ならミッドコート側からギャザーする。
    {
      const rimFloor = game.attackFloor(h.team);
      let dx = h.pos.x - rimFloor.x, dz = h.pos.z - rimFloor.z;
      let len = Math.hypot(dx, dz);
      if (len < 0.4) { dx = 0; dz = -game.attackSign(h.team); len = 1; }   // ミッドコート側から進入
      const standoff = dunk ? 0.6 : 0.9;
      game.finishSpot.set(rimFloor.x + (dx / len) * standoff, 0, rimFloor.z + (dz / len) * standoff);
    }
    // ドライブの勢いを跳躍へ持ち込む: 走っていた速度で踏み切る。
    // 速攻でリムを行き過ぎないよう上限を設ける。
    {
      const cap = h.runSpeed * 1.05;
      const sp = Math.hypot(h.velX, h.velZ);
      const k = sp > cap ? cap / sp : 1;
      game.finishVX = h.velX * k;
      game.finishVZ = h.velZ * k;
    }
    game.shotTarget.copyFrom(game.attackRim(game.possession));   // 至近: ミスはリムに嫌われるだけ
    game.ballMode = "shot";
    game.longShot = false;   // リムフィニッシュはボールカメラの対象にならない
    game.longShotHoldT = 0;  // そして残っているロングショットの保持を打ち消す
    game.shooter = h;
    game.shooterFinishing = true;
    game.handler = null;
    // 踏み切り時にリムへ正対: 空中では体が固定されるので、傾いて離陸すると
    // 「バックダンク」に見える。今のうちに胸をゴールへ向ける。
    { const rf = game.attackFloor(h.team); h.faceChestToward(rf.x, rf.z); }
    // 跳躍の高さは ジャンプ に比例
    h.jump(dunk ? 0.85 + rate(h.attr.jump) * 0.3 : 0.55 + rate(h.attr.jump) * 0.2,
      dunk ? 0.7 : 0.6);
    contestJump(game, h);
    // フィニッシャーはシュート中に切り込み、その後短い復帰時間
    h.coolT = game.shotDur + rand(0.25, 0.45) * h.recoveryMult();
    game.setEvent(SHOT_PARAMS[shotType].liveLabel!, h.team);   // "DUNK!" / "LAYUP"
  }

  // 最寄りの守備者がシュート/フィニッシュにコンテストで跳ぶ。
export function contestJump(game: Game, shooter: Player): void {
    let near: Player | null = null;
    let best = 2.6; // この距離以内からのみコンテスト
    for (const d of game.teamPlayers(1 - shooter.team)) {
      const dd = dist2D(d.pos, shooter.pos);
      if (dd < best) { best = dd; near = d; }
    }
    if (near) game.contestLeap(near, shooter.pos, 0.5, 0.65);
  }

  // 守備者はシュートをはたけるか？ 届く守備者は全員一撃のチャンスを得る。
  // リムフィニッシュは ヘッド + ジャンプ + 守判断、ジャンパーは ジャンプ + 反応 +
  // 守判断 で挑まれる。跳ぶのは最も止められるショットブロッカー。
  // evadeOK: シューターが S技術 でブロックをかわせるか(ダブルクラッチ)。
  // フィニッシュとアーク内のジャンプショットは可能、3Pは不可。
export function tryBlock(game: Game, shooter: Player, isFinish: boolean, evadeOK = isFinish): Player | null {
    // ブロック確率の算出は効果層(resolution/contest-block)へ分離。ここでは最も
    // 止められる守備者と確率を受け取り、抽選と状態変更(evade/jump/shotMade)を行う。
    const cand = bestBlocker(game.teamPlayers(1 - shooter.team), shooter, isFinish,
      game.shotWindup, PALM_HITBOX);
    if (!cand || !chance(cand.p)) return null;
    const best = cand.def;
    // イベイド（ダブルクラッチ）: フィニッシュ限定 — 伸びてきたブロックの手を
    // 空中でかわしてシュートまで行く。
    if (evadeOK) {
      const pEvade = evadeBlockProbability(shooter, best);
      if (chance(pEvade)) {
        // スワットは空振り — ブロッカーは跳んだまま、シューターは滞空して組み直す。
        if (!best.airborne) best.jump(0.9, 0.6);
        // ダブルクラッチの迂回はフィニッシュの動き。ボールが曲がる見た目(evadedFinish)は
        // フィニッシュ限定。
        if (isFinish) {
          game.evadedFinish = true;
          const ex = shooter.pos.x - best.pos.x, ez = shooter.pos.z - best.pos.z;
          const el = Math.hypot(ex, ez) || 1;
          game.evadeDirX = ex / el;
          game.evadeDirZ = ez / el;
        }
        if (game.shotMade && chance(0.18 * (1 - rate(shooter.attr.shotTech)))) game.shotMade = false;
        return null;
      }
    }
    return best;
  }

  // かすり: フルブロック(スワット)には至らないが、伸ばした手がシュートに触れる部分接触。触れると
  // 軌道が乱れて外れる(当たり具合=ずれ幅はランダム)。ブロックより起こりやすく、跳んで手を出して
  // いれば更に触れやすい。3P/ミドル共通。releaseShot が tryBlock の後に呼ぶ。
export function grazeShot(game: Game, h: Player): void {
    const cand = bestBlocker(game.teamPlayers(1 - h.team), h, false, game.shotWindup, PALM_HITBOX);
    if (!cand) return;
    // ブロック(スワット)より起きやすいが、ブロック判定に続けて掛かるので過剰にならない程度に。
    const pGraze = clamp(cand.p * 1.0 + (cand.def.airborne ? 0.06 : 0.02), 0, 0.5);
    if (chance(pGraze)) {
      game.shotMade = false;                 // かすったら外れる
      game.shotGraze = 0.5 + rand(0, 1.0);   // 当たり具合(軌道のずれ幅)。aimShotTarget が消費
    }
  }

  // シュートがはたかれる: ブロッカーが跳び、ボールはリムでルーズになる。
export function swatShot(game: Game, shooter: Player, blocker: Player): void {
    blocker.stats.blk++;
    shooter.stats.fga++;             // ブロックされたシュートは失敗した試投
    if (game.shotPoints === 3) shooter.stats.tpa++;
    game.pendingAssist = null;
    // ブロッカーは跳び上がり手をボールへ合わせる — 既に跳んでいれば再ジャンプしない
    if (!blocker.airborne) game.contestLeap(blocker, shooter.pos, 0.95, 0.6);
    game.setEvent("BLOCK!", blocker.team);
    flashBall(game, "block");        // ブロックはスティールと同じ赤
    game.handler = null;

    // 手がボールを飛翔からはたく: ブロック点から横へ飛散して弾き返される。
    // 強いブロッカーほど遠くへ飛ばす。
    const rim = game.attackFloor(shooter.team);
    let ox = shooter.pos.x - rim.x, oz = shooter.pos.z - rim.z;
    let ol = Math.hypot(ox, oz);
    if (ol < 0.9) {                            // リムフィニッシュ: 床の方へはたき出す
      ox = rand(-1, 1); oz = -Math.sign(rim.z || 1) * rand(0.6, 1.3);
      ol = Math.hypot(ox, oz) || 1;
    }
    ox /= ol; oz /= ol;
    const px = -oz, pz = ox, kick = rand(-0.8, 0.8);   // 手からの横方向の飛散
    const power = 4.4 + (rate(blocker.attr.jump) * 0.5 + rate(blocker.attr.defense) * 0.5) * 4.0;   // 大きくはたき飛ばす
    // 接触点 = ブロッカーの手: ボールをブロッカーのすぐ前(シューター側)、
    // リーチの最上点に置き、手が目に見えて乗るようにする。
    let hx = shooter.pos.x - blocker.pos.x, hz = shooter.pos.z - blocker.pos.z;
    const hl = Math.hypot(hx, hz) || 1;
    game.ball.pos.set(blocker.pos.x + (hx / hl) * 0.45, 2.6, blocker.pos.z + (hz / hl) * 0.45);
    // ボールは一拍(blockHoldT)手の上で静止 — 接触が見える — その後外と下へはたかれる。
    // ピンが解ける(updateLoose)まではじきの速度を保持する。
    game.blockHoldVel.set((ox + px * kick) * power, rand(-0.6, 1.0), (oz + pz * kick) * power);
    game.blockHoldT = 0.13;
    game.ball.vel.setAll(0);
    blocker.reachBall(game.ball.pos, false);   // 片手で弾きに行く（スワット）
    game.lastTouch = blocker;                  // 彼が最後に触れた → アウトオブバウンズはオフェンスのまま
    // シューターはシュートの動き/着地中はボールを回収できない。
    // grabAfter は誰かが確保する前のルーズボール状態を保つ。
    shooter.touchCool = 1.0;
    // フォロースルーを固める: releaseShot は coolT を設定できていない(ブロックが
    // 先に return した)ので、ここで設定する。coolT が立てば poseHands はリリースの形を保つ。
    shooter.coolT = 0.6 + rand(0.3, 0.6) * shooter.recoveryMult();
    // シューターは弾かれて軽くのけぞる（衝撃のみ、歩かない）
    shooter.foulReaction("hurt", shooter.pos.x - blocker.pos.x, shooter.pos.z - blocker.pos.z, rand(0.3, 0.45));
    shooter.foulStumble = false; shooter.foulStaggerX = shooter.foulStaggerZ = 0;
    blocker.defWin("block");                   // 着地したら誇らしげに拳を上げる
    game.goLoose(shooter.team, 2.6, { rebound: true, grabAfter: 0.6 });
  }

  // シュートはファウルされたか？ コンテストされたレイアップほど接触が起きやすい。
  // その場合、シューターをラインへ送る(シュートが決まっていれば AND-1)。
export function tryShootingFoul(game: Game, h: Player, dDef: number, layup: boolean): boolean {
    // ファウル確率は効果層(resolution/foul)へ分離。od は下の突き飛ばし演出でも使う。
    const od = game.onBallDefender(h);
    if (!chance(shootingFoulChance(h, dDef, layup, od))) return false;

    if (game.shotMade) {
      // AND-1: バスケットが決まる必要があるので打ち切らない。シュートを飛ばして沈め、
      // resolveShot が保留中のファウルを見てカウントし1本を与える。
      game.pendingAndOne = h;
      return false;
    }

    // ミス時のファウル: バスケット無し — そのまま2本(3本)のためラインへ
    contestJump(game, h);
    game.handler = null;
    game.pendingAssist = null;
    // コンテストした守備者から弾き飛ばされる。守備者が強い/攻撃的なほど強く
    const fpx = od ? h.pos.x - od.pos.x : 0;
    const fpz = od ? h.pos.z - od.pos.z : 0;
    const fs = od ? clamp(0.3 + rate(od.attr.balance) * 0.4 + rate(od.attr.aggression) * 0.2
      - rate(h.attr.balance) * 0.35, 0.1, 1) : 0.5;
    h.foulReaction("hurt", fpx, fpz, fs);   // デッドボールの間に接触を演出
    game.setEvent("SHOOTING FOUL", h.team, 1.8);
    const count = game.shotPoints;
    // ファウルが伝わるよう間を置いてから、ラインへ
    game.pauseThen(1.3, () => game.ft.start(h, count));
    return true;
  }

  // ボールが実際に飛ぶ先。成功はリム中心、ミスはリム周辺/バックボード際の点へ向かう。
  // 遠いシュートほど少し散るが、常にゴール付近に留まる。
export function aimShotTarget(game: Game, dHoop: number): void {
    const rim = game.attackRim(game.possession);
    game.shotTarget.copyFrom(rim);
    if (game.shotMade) { game.shotGraze = 0; return; }
    // かすったミスは当たり具合(shotGraze)ぶん大きく逸れる — 手に当たって軌道が乱れた分。
    const scatter = 0.4 + Math.min(1, Math.max(0, dHoop - THREE_DIST) / 8) * 0.55   // 0.4 .. 約0.95
      + game.shotGraze;
    const zSign = Math.sign(rim.z) || 1;
    game.shotTarget.x = rim.x + rand(-1, 1) * scatter;
    game.shotTarget.z = rim.z + zSign * rand(0.05, 0.3 + scatter * 0.5);   // 奥へ(バックボード寄りに)偏らせる
    // バックボードより奥を狙わない: ボールの表面が板の面に触れるまで(中心はその半径ぶん手前)に留め、
    // スクリプトの飛翔で板をめり込み突き抜けないようにする。板に当たった球は以後ルーズ物理で反射する。
    const maxZ = RIM.backboardZ - 0.025 - 0.12;                             // 板の面 − ボール半径
    if (Math.abs(game.shotTarget.z) > maxZ) game.shotTarget.z = zSign * maxZ;
    game.shotTarget.y = RIM.height + rand(-0.2, 0.5) + (game.shotGraze > 0 ? rand(-0.25, 0.5) : 0);
    game.shotGraze = 0;   // 当たり具合を消費
  }

export function updateShot(game: Game, dt: number): void {
    game.crashBoards(dt); // シュートが上がっている間、全員がボードへ集まる

    game.shotT += dt;
    const k = Math.min(1, game.shotT / game.shotDur);
    const b = game.shotTarget;   // 成功ならリム、ミスなら的外れの点
    // フィニッシュ(ダンク/レイアップ): ボールは手から1つの滑らかなアークでリムへ上がる。
    // 水平は手の現在位置からリムへイージング、垂直は頂点まで上がってから沈む。
    if (game.shooterFinishing && game.shooter) {
      const fin = game.shooter;
      const e = k * k * (3 - 2 * k);                 // smoothstep — 連続した速度
      const top = game.shotFrom.y;                   // 踏み切り時の手の高さ(ダンク2.6 / レイアップ1.7)
      const peak = Math.max(top, b.y) + game.shotApex;
      let x = fin.pos.x + (b.x - fin.pos.x) * e;
      let y = top + (b.y - top) * e + Math.sin(k * Math.PI) * (peak - Math.max(top, b.y));
      let z = fin.pos.z + (b.z - fin.pos.z) * e;
      // ダブルクラッチ: イベイドしたフィニッシュはボールをスワットの下へ引き、
      // ブロッカーの反対側へ回してからリムへ運び直す(窓は飛行の18..68%)。
      if (game.evadedFinish) {
        const c = Math.sin(clamp((k - 0.18) / 0.5, 0, 1) * Math.PI);
        y -= c * 0.38;                               // スワットの下へ引き下げる
        x += game.evadeDirX * c * 0.25;              // ブロッカーの横を回り込む
        z += game.evadeDirZ * c * 0.25;
      }
      game.ball.pos.set(x, y, z);
      if (k >= 1) resolveShot(game);
      return;
    }
    const a = game.shotFrom;
    const baseY = a.y + (b.y - a.y) * k;
    const apex = Math.sin(k * Math.PI) * game.shotApex;
    game.ball.pos.set(a.x + (b.x - a.x) * k, baseY + apex, a.z + (b.z - a.z) * k);

    if (k >= 1) resolveShot(game);
  }

export function resolveShot(game: Game, ): void {
    // 深い一発は着地/バウンドまでボールカメラを維持する
    if (game.longShot) { game.longShotHoldT = 1.6; game.longShot = false; }
    const shooter = game.possession;
    const sh = game.shooter;
    if (sh) { sh.stats.fga++; if (game.shotPoints === 3) sh.stats.tpa++; }
    const andOne = game.shotMade && sh !== null && game.pendingAndOne === sh;
    if (game.shotMade) {
      game.score[shooter] += game.shotPoints;
      if (sh) {
        sh.stats.pts += game.shotPoints; sh.stats.fgm++;
        if (game.shotPoints === 3) sh.stats.tpm++;
      }
      if (game.pendingAssist) game.pendingAssist.stats.ast++;
      game.setEvent(andOne ? "AND-1" : game.shotPoints === 3 ? "3 POINTS!" : "2 POINTS",
        shooter, 1.8, { scorer: sh?.name, assist: game.pendingAssist?.name });
      // ダンクや3Pはベンチ全体を跳ね上がらせる。平凡な2点は小さな盛り上がり
      const big = game.shotPoints === 3 || game.shotWasDunk;
      benchCheer(game, shooter, big ? 2.6 : 1.7, big ? 1.0 : 0.4);
      // ボールはネットを抜けて落ち、間の内に床でバウンドする
      const rim = game.attackRim(shooter);
      game.ball.pos.set(rim.x, RIM.height - 0.15, rim.z);
      game.ball.vel.set(rand(-0.5, 0.5), -2.4, -Math.sign(rim.z || 1) * rand(0.2, 0.8));
      game.ballFalling = true;
      swishNet(game, shooter);   // 成功時にネットが弾け、リムが光る
      flashScore(game, game.shotPoints);   // ボールはネットを抜けるまで青く光る
      // 決まったバスケットで間を置き、交代、インバウンド。ブザーが鳴っていればピリオド終了。
      // AND-1 はラインで続く(バスケット有効 + フリースロー1本)。
      game.handler = null;
      // AND-1: スコアラーは決めたバスケットの上でポーズを取り、その後ラインへ向かう
      if (andOne) { sh!.foulReaction("and1"); game.pauseThen(1.4, () => game.ft.start(sh!, 1)); }
      else if (game.gameClock <= 0) game.pauseThen(1.4, () => endQuarter(game));
      else game.pauseThen(1.4, () => withSubs(game, () => game.inbound.start(1 - shooter)));
    } else {
      game.setEvent("MISS", shooter);
      if (game.gameClock <= 0) { game.handler = null; endQuarter(game); }
      else game.startRebound();
    }
    game.pendingAssist = null;
    game.pendingAndOne = null;
  }

  // このシューターをパスで演出した味方 — シューターがそのパスの受け手であること。
export function assistCreditFor(game: Game, shooter: Player): Player | null {
    return (game.assistTo === shooter && game.assistFrom && game.assistFrom !== shooter)
      ? game.assistFrom : null;
  }
