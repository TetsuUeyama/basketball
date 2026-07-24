// シュート機構（方式B: GameState 集約）。ジャンプショットのため/放ち/飛翔/着弾判定、
// リムフィニッシュ、コンテスト/ブロック、シューティングファウル、アシスト評価までを
// 関数として集約。状態は Game に集約し各関数は第一引数 game を受け取る。
// contestLeap は defense からも使うため Game 残置（game.contestLeap 経由）。
import { Player } from "../player";
import { RIM, THREE_DIST, PALM_HITBOX, SHOT_SET_Y, SHOT_GATHER_Y } from "../config";
import { clamp, dist2D, moveToward2D, chance, rand } from "../util";
import { shotWindupFor } from "../eval";
import { rate } from "../attributes";
import { jumpShotMakeProbability, rimFinishOutcome } from "../reaction/shot-outcome";
import { bestBlocker, evadeBlockProbability } from "../reaction/contest-block";
import { shootingFoulChance } from "../reaction/foul";
import { endQuarter } from "../core/gameflow";
import { swishNet } from "../core/visuals";
import { benchCheer } from "../core/bench";
import { withSubs } from "../systems/subs";
import type { Game } from "../game";

// ---- シュート種別（距離ベース） -------------------------------------------
// 距離でリム下(ダンク/レイアップ)・ミドル・3Pを使い分ける。ダンク/レイアップの
// 枝分かれは能力・レーンで rimFinishOutcome が抽選、ミドル/3P は THREE_DIST 境界で
// 分ける。ブザービーターは距離種別ではなく横断的な修飾(buzzer フラグ)、フリースローは
// 別フェーズ(systems/freethrow)として本種別には含めない。
// A(現状): 従来の値/式を種別ごとに明示化＝挙動等価。B: 各種別を独立に調整する土台。
export type ShotType = "dunk" | "layup" | "midrange" | "three";

// ジャンパーの距離種別。リム下フィニッシュは finishAtRim が別途 dunk/layup を決める。
function jumperType(dHoop: number): ShotType {
  return dHoop > THREE_DIST ? "three" : "midrange";
}

// 種別ごとの実行パラメータ。apex(弾道頂点m)/dur(飛翔s)は far(=THREE_DIST からの
// 超過m、ミドル/リムは0)で可変。mid と three を別エントリにしておくことで、B で
// それぞれ独立にカーブ調整できる（A では従来式を保持＝挙動等価）。
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

export function shoot(game: Game, h: Player, dHoop: number, dDef: number): void {
    // ブザービーター: ギャザーの時間が無い — ホーンと同時にただ投げ上げる。
    // 純粋な確率のトレードオフ(releaseShot が既に make% を下限化)なので、
    // チャージ相もワインドアップも無い(ボールは今すぐ飛ぶ)。
    if (game.gameClock > 0 && game.gameClock < 0.9) {
      game.shotWindup = 0;
      releaseShot(game, h, dHoop, dDef);
      return;
    }
    const windup = shotWindupFor(h, dHoop);
    game.shotWindup = windup;
    game.chargeShooter = h;
    game.chargeDHoop = dHoop;
    game.chargeDDef = dDef;
    game.chargeT = windup;
    game.shooter = h;              // ギャザー中のポーズの所有者
    game.handler = null;
    game.ballMode = "charge";
    // ボールはギャザーのポケット(胸)で開始し、ワインドアップの間に頭上へ
    // 持ち上げられる(chargeBallY 参照) — 彼がリリースするジャンプショットのポケット
    game.ball.pos.set(h.pos.x, chargeBallY(game), h.pos.z);
  }

  // ボールはワインドアップの間にポケットから頭上へ上がり、溜めが静止ポーズでなく
  // 動きに見えるようにする: ギャザーの約80%で頭上へ、その後リリースの窓の間そこで
  // 保持。急がない持ち上げのためイージング(smoothstep)。
export function chargeBallY(game: Game, ): number {
    const w = game.shotWindup || 0.001;
    const p = clamp(1 - game.chargeT / w, 0, 1);   // ギャザー開始で0 → リリースで1
    const rise = clamp(p / 0.8, 0, 1);
    const e = rise * rise * (3 - 2 * rise);
    return SHOT_GATHER_Y + (SHOT_SET_Y - SHOT_GATHER_Y) * e;
  }

  // ギャザーの1フレーム: ボールを溜めたまま保持し、オンボール守備者にシュートを
  // 読ませてクローズアウト/踏み切ってコンテストさせる。ドライブで重心を崩された
  // (抜かれた/復帰中の)守備者は間に合わない — ドリブルを深追いすると綺麗な
  // シュートを許すのはこのため。
export function updateCharge(game: Game, dt: number): void {
    const h = game.chargeShooter;
    if (!h) { game.ballMode = "held"; return; }
    game.chargeT -= dt;
    game.ball.pos.set(h.pos.x, chargeBallY(game), h.pos.z);   // ポケットから頭上へ持ち上げる
    const d = game.teamPlayers(1 - h.team)[h.slot];   // シューターの担当守備者
    const beaten = h.beatenT > 0 || h.powerT > 0;     // 抜き去った → クローズアウトが遅れる
    if (d && !beaten) {
      const gap = dist2D(d.pos, h.pos);
      if (!d.airborne && d.landT <= 0) {
        // シューターへ強くクローズアウト
        if (gap > 0.75) {
          const clo = d.accelToward(dt, h.pos.x, h.pos.z, 1.15) * dt;
          moveToward2D(d.pos, h.pos.x, h.pos.z, clo);
          game.clampCourt(d.pos);
        }
        // リリースが近づくと、近くにいて読んだ守備者が踏み切って挑む —
        // 反応/守判断 がタイミングを計り、ジャンプ が届く高さを与える
        if (game.chargeT < 0.13 && gap < 1.7) {
          const read = rate(d.attr.reaction) * 0.5 + rate(d.attr.defense) * 0.5;
          if (chance((0.25 + read * 1.5) * dt * 9)) game.contestLeap(d, h.pos, 0.5 + rate(d.attr.jump) * 0.35, 0.6);
        }
      }
      // ギャザー中のストリップ: ボールが頭上に溜められている間、その空間にいる
      // 守備者がはたく — フレーム毎なので、長いギャザー(深い/遅い溜め)ほどリリース前に
      // 弾かれやすい。高いボールに届く必要がある(空中だと大きく有利)。背の高い
      // シューターは遠ざけて保持する。
      if (gap < 1.2) {
        const poke = rate(d.attr.reaction) * 0.4 + rate(d.attr.agility) * 0.35
          + rate(d.attr.defense) * 0.25 + (d.has("interceptor") ? 0.12 : 0);
        const secure = rate(h.attr.handling) * 0.5 + clamp((h.height - d.height) * 0.6, -0.15, 0.35);
        const reach = d.airborne ? 1.3 : 0.5;   // ボールは頭上 — 跳んで届く必要がある
        if (chance(Math.max(0, poke - secure) * reach * dt * 5)) { stripGather(game, h, d); return; }
      }
    }
    if (game.chargeT <= 0) releaseShot(game, h, game.chargeDHoop, game.chargeDDef);
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

export function releaseShot(game: Game, h: Player, dHoop: number, dDef: number): void {
    game.chargeShooter = null;
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
      buzzer: game.gameClock > 0 && game.gameClock < 1.0,
      palmHitbox: PALM_HITBOX,
    });
    game.shotMade = chance(p);

    game.shooter = h;   // 今シュートを所有する — ブロックが彼のフォロースルーを固める
    game.lastTouch = h;   // シューターが最後に触れた(エアボールで外へ → 相手ボール)
    // ミドル/ゴール下のジャンプシュートも、レイアップ/ダンク同様に S技術 で
    // ブロックをかわして打てる（3Pは対象外）。
    const blocker = tryBlock(game, h, false, !isThree);
    if (blocker) { swatShot(game, h, blocker); return; }
    if (tryShootingFoul(game, h, dDef, false)) return;

    game.shotFrom.set(h.pos.x, 2.05, h.pos.z);
    aimShotTarget(game, dHoop);   // 決まればリム、ロングミスはリムから大きく外れた点へ
    game.shotT = 0;
    // アークの外ではボールは弾くのでなく放り投げる: 遠いほど高く遅い放物線
    // (ブザーの一発は追えるほど長く空中に留まる)。アークの内側では何も変わらない
    // (far = 0 → 従来の 0.85/2.2)。
    const far = Math.min(12, Math.max(0, dHoop - THREE_DIST));
    // 弾道時間・高さは種別テーブル(SHOT_PARAMS)から。ミドルは far=0 で従来の 0.85 /
    // (1.6+bank*1.2)、3Pは far で山なりに上がる。ジャンパーは evaded を持たない(false)。
    // 高いアークは山なりに見えブロックしにくい(tryBlock は同じ能力値を読む)。
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
    // フォロースルー: シューターはシュートの飛翔と着地の一拍の間その場に留まるので、
    // すぐにはボードへ突っ込んだり戻ったりできない
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
    // かわしたブロックはダブルクラッチに見える — スワットが空振りで通り過ぎるまで
    // 一拍長く滞空してから決める（種別テーブルの dur が evaded で +0.14）
    game.shotDur = SHOT_PARAMS[shotType].dur(0, game.evadedFinish);
    game.shotApex = SHOT_PARAMS[shotType].apex(h, 0);
    // リムの手前(進入側)で踏み切り、体をリム真下に置くのでなくボールをゴールへ
    // 伸ばす。ダンカーはレイアップより近づく。すでにリム真下にいるなら、
    // ミッドコート側からギャザーする。
    {
      const rimFloor = game.attackFloor(h.team);
      let dx = h.pos.x - rimFloor.x, dz = h.pos.z - rimFloor.z;
      let len = Math.hypot(dx, dz);
      if (len < 0.4) { dx = 0; dz = -game.attackSign(h.team); len = 1; }   // ミッドコート側から進入
      const standoff = dunk ? 0.6 : 0.9;
      game.finishSpot.set(rimFloor.x + (dx / len) * standoff, 0, rimFloor.z + (dz / len) * standoff);
    }
    // ドライブの勢いを跳躍へ持ち込む: 走っていた速度で踏み切り(止まってから跳ぶの
    // でなく、フィニッシュへ一歩踏み込む)、その水平速度は空中で減衰する(crashBoards)。
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
    // 踏み切り時にリムへ正対: 空中では体が固定されるので、傾いて離陸するとダンク/
    // レイアップが「バックダンク」に見える。今のうちに胸(と胸が覆いきれない足)を
    // ゴールへ向け、正対してフィニッシュさせる。
    { const rf = game.attackFloor(h.team); h.faceChestToward(rf.x, rf.z); }
    // 跳躍の高さは ジャンプ に比例
    h.jump(dunk ? 0.85 + rate(h.attr.jump) * 0.3 : 0.55 + rate(h.attr.jump) * 0.2,
      dunk ? 0.7 : 0.6);
    contestJump(game, h);
    // フィニッシャーはシュート中に切り込み(crashBoards で処理)、その後
    // 再び動けるまで短い復帰時間
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

  // 守備者はシュートをはたけるか？ 届く守備者は全員(最寄りの1人だけでなく)
  // 一撃のチャンスを得る — だからウィークサイドのリムプロテクターが担当を抜かれた
  // ガードをブロックする。ブロックが実際に生まれるのはここから。
  // リムフィニッシュは ヘッド(ダンク/リム保護) + ジャンプ + 守判断 で挑まれ、
  // ジャンパーは ジャンプ + 反応 + 守判断 で挑まれる。どちらも本物の高さ差と
  // タイトなコンテストを報いる。跳ぶのは最も止められるショットブロッカー。
  // evadeOK: シューターが S技術 で来かけたブロックをかわせるか(ダブルクラッチ)。
  // フィニッシュは常に可能。アーク内のジャンプショット(ミドル/ゴール下)も今は
  // 可能なので、高 S技術 のスコアラーは常にはたかれるのでなくコンテストの上/横から
  // 打つ。3Pは不可(そこでは evadeOK=false)。
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
        // スワットは空振り — ブロッカーは跳んだまま、シューターは滞空して
        // シュートを組み直す。調整したリリースは少し決めにくいが、S技術 が
        // 空中でもメカニクスを綺麗に保つ。
        if (!best.airborne) best.jump(0.9, 0.6);
        // ダブルクラッチの迂回はフィニッシュの動き(ボールをスワットの下へ引き、
        // ブロッカーを回り込む)。ジャンプショットは手の上から放つだけなので、
        // ボールが曲がる見た目(evadedFinish)はフィニッシュ限定。
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

  // シュートがはたかれる: ブロッカーが跳び、ボールはリムでルーズになる。
export function swatShot(game: Game, shooter: Player, blocker: Player): void {
    blocker.stats.blk++;
    shooter.stats.fga++;             // ブロックされたシュートは失敗した試投
    if (game.shotPoints === 3) shooter.stats.tpa++;
    game.pendingAssist = null;
    // ブロッカーは跳び上がり、リリースの瞬間に手をボールへ合わせる —
    // ただし既に跳んでいる場合もある(ギャザー中に跳んだ)ので再ジャンプしない
    // (跳躍がリセットされ接触の判定が崩れる)
    if (!blocker.airborne) game.contestLeap(blocker, shooter.pos, 0.95, 0.6);
    game.setEvent("BLOCK!", blocker.team);
    game.handler = null;

    // 手がボールを飛翔からはたく: ブロック点(シューターのリリース)から叩き出され、
    // 横への飛散を伴ってリムから外へ弾き返され、重力でライブのルーズボールとして
    // 落ちる。強いブロッカー(ジャンプ/守判断)ほど遠くへ飛ばす。
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
    // 接触点 = シューターの空間でなくブロッカーの手: ボールをブロッカーのすぐ前
    // (シューター側)、リーチの最上点に置き、届く範囲内で手が目に見えて乗るように
    // する — ボールはシューターからワープするのでなく、彼の手からはたき出される。
    let hx = shooter.pos.x - blocker.pos.x, hz = shooter.pos.z - blocker.pos.z;
    const hl = Math.hypot(hx, hz) || 1;
    game.ball.pos.set(blocker.pos.x + (hx / hl) * 0.45, 2.6, blocker.pos.z + (hz / hl) * 0.45);
    // ボールは一拍(blockHoldT)手の上で完全に静止 — 接触が見える — その後
    // ほぼ外と下へはたかれる。ピンが解ける(updateLoose)まではじきの速度を保持し、
    // それまでボールを手に固定しておく。
    game.blockHoldVel.set((ox + px * kick) * power, rand(-0.6, 1.0), (oz + pz * kick) * power);
    game.blockHoldT = 0.13;
    game.ball.vel.setAll(0);
    blocker.reach(game.ball.pos, true);        // 接触時に手をボールへ
    game.lastTouch = blocker;                  // 彼が最後に触れた → アウトオブバウンズはオフェンスのまま
    // シューターはシュートの動き/着地中はボールを回収できない
    // (ブロックされた自分のシュートを即座に掴み直せない)。grabAfter は誰かが確保する前の
    // 綺麗で自由に転がるルーズボール状態を保つ。
    shooter.touchCool = 1.0;
    // フォロースルーを固める: releaseShot は coolT を設定できていない(ブロックが
    // 先に return した)ので、ここで設定する — さもないとルーズボールのポーズで、空中の
    // 腕がはたかれたボールへ、まるでそこに投げたかのように向いてしまう。coolT が立てば
    // poseHands は彼を争奪から除外し、リリースの形を保つ。
    shooter.coolT = 0.6 + rand(0.3, 0.6) * shooter.recoveryMult();
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
      // AND-1: ルール上バスケットが実際に決まる必要がある — なのでここで
      // 打ち切らない。シュートを他の成功と同様に飛ばして沈める。resolveShot が
      // 保留中のファウルを見てカウントし、その後1本のシュートを与える。
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

  // ボールが実際に飛ぶ先。成功はリム中心へ向かい、ミスはリム周辺/バックボード際の点へ
  // 向かう — 決して真ん中(成功に見える)や大きく場外へは行かない。遠いシュートほど
  // 少し散るが、常にゴール付近に留まるのでリバウンドできる。
export function aimShotTarget(game: Game, dHoop: number): void {
    const rim = game.attackRim(game.possession);
    game.shotTarget.copyFrom(rim);
    if (game.shotMade) return;
    const scatter = 0.4 + Math.min(1, Math.max(0, dHoop - THREE_DIST) / 8) * 0.55;   // 0.4 .. 約0.95
    const zSign = Math.sign(rim.z) || 1;
    game.shotTarget.x = rim.x + rand(-1, 1) * scatter;
    game.shotTarget.z = rim.z + zSign * rand(0.05, 0.3 + scatter * 0.5);   // 奥へ(バックボード寄りに)偏らせる
    game.shotTarget.y = RIM.height + rand(-0.2, 0.5);
  }

export function updateShot(game: Game, dt: number): void {
    game.crashBoards(dt); // シュートが上がっている間、全員がボードへ集まる

    game.shotT += dt;
    const k = Math.min(1, game.shotT / game.shotDur);
    const b = game.shotTarget;   // 成功ならリム、ミスなら的外れの点
    // フィニッシュ(ダンク/レイアップ): ボールはフィニッシャーの手から1つの滑らかな
    // アークでリムへ上がる — 空中で折れない。水平方向は手の現在位置(滑り込み中)から
    // リムへイージング。垂直方向は頂点(スラムはリムの上に来る)まで上がってから
    // 沈む。腕は最後までボールを追う(poseHands)ので、手とボールは繋がったまま。
    if (game.shooterFinishing && game.shooter) {
      const fin = game.shooter;
      const e = k * k * (3 - 2 * k);                 // smoothstep — 連続した速度
      const top = game.shotFrom.y;                   // 踏み切り時の手の高さ(ダンク2.6 / レイアップ1.7)
      const peak = Math.max(top, b.y) + game.shotApex;
      let x = fin.pos.x + (b.x - fin.pos.x) * e;
      let y = top + (b.y - top) * e + Math.sin(k * Math.PI) * (peak - Math.max(top, b.y));
      let z = fin.pos.z + (b.z - fin.pos.z) * e;
      // ダブルクラッチ: イベイドしたフィニッシュはボールを一度スワットの下へ
      // 引き込み、ブロッカーと反対側へ体側で回してからリムへ運び直す。腕は
      // poseHands でボールに追従するので、この軌道の曲がりがそのまま「手を
      // かわす」動きとして見える（窓は飛行の18..68%、両端でゼロ=軌道は滑らか）。
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
    // 深い一発は着地/バウンドまでボールカメラを維持するので、フレームが元へ
    // 戻る前に、視聴者は入ったかどうかを見られる
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
      // 視聴者が見られるよう決まったバスケットで間を置き、その後交代、その後
      // インバウンド — ただしブザーが既に鳴っていれば(ブザービーター)ここで
      // ピリオド終了。AND-1 は代わりにラインで続く: バスケット有効 + フリースロー1本。
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

  // このシューターをパスで演出した味方(いれば) — シュートが決まればアシストを
  // 記録。シューターがそのパスを受けた選手であることが条件。
export function assistCreditFor(game: Game, shooter: Player): Player | null {
    return (game.assistTo === shooter && game.assistFrom && game.assistFrom !== shooter)
      ? game.assistFrom : null;
  }
