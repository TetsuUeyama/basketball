// 選手の移動・物理・疲労tick（プロトタイプ拡張で Player に紐づけ）。本体は player.ts
// から逐語移動（this は Player インスタンスのまま）。呼び出し側は不変。game.ts が
// 副作用 import する。
import { rate } from "../../attributes";
import { clamp } from "../../util";
import { HUD_OPTS } from "../../config";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    recoveryMult(): number;
    setPlant(t: number): void;
    tickCooldown(dt: number): void;
    accelSpeed(dt: number, mult?: number): number;
    turnFactor(tx: number, tz: number): number;
    leanFactor(tx: number, tz: number): number;
    accelToward(dt: number, tx: number, tz: number, mult?: number): number;
    leanRecoverRate(): number;
    decayLean(dt: number): void;
    tickMotion(dt: number, resting: boolean): void;
    benchRecover(dt: number): void;
    breakRecover(amount: number): void;
    reachTopY(): number;
  }
}

/** 敏捷性: パス、シュート、着地の後に体が次の動作へどれだけ早く立て直すか
 *  — 素早い選手はおよそ半分の時間で回復する。 */
Player.prototype.recoveryMult = function(): number {
  return 1.3 - rate(this.attr.agility) * 0.65;   // ~0.66（素早い）.. ~1.24（遅い）
};

/** 外部のコミット（例: スティールの踏み込み）からプラント&再プッシュの硬直
 *  （動き直し）を設定する。最も長いものとその全長を加速のイージング用に保持する。 */
Player.prototype.setPlant = function(t: number): void {
  if (t > this.plantT) { this.plantT = t; this.plantDur = t; }
};

/** パス/シュート後の回復クールダウンを減算する。 */
Player.prototype.tickCooldown = function(dt: number): void {
  if (this.coolT > 0) this.coolT = Math.max(0, this.coolT - dt);
  if (this.justPassedT > 0) this.justPassedT = Math.max(0, this.justPassedT - dt);
  if (this.trappedT > 0) this.trappedT = Math.max(0, this.trappedT - dt);
  if (this.keepShieldT > 0) this.keepShieldT = Math.max(0, this.keepShieldT - dt);
  if (this.wallT > 0) this.wallT = Math.max(0, this.wallT - dt);
  if (this.gatherT > 0) this.gatherT = Math.max(0, this.gatherT - dt);
  if (this.pickupT > 0) this.pickupT = Math.max(0, this.pickupT - dt);
  if (this.plantT > 0) this.plantT = Math.max(0, this.plantT - dt);
  if (this.landT > 0) this.landT = Math.max(0, this.landT - dt);
  if (this.quickT > 0) this.quickT = Math.max(0, this.quickT - dt);
  if (this.baitT > 0) this.baitT = Math.max(0, this.baitT - dt);
  if (this.openRollT > 0) this.openRollT = Math.max(0, this.openRollT - dt);
  if (this.setupT > 0) this.setupT = Math.max(0, this.setupT - dt);
  if (this.defWinT > 0) this.defWinT = Math.max(0, this.defWinT - dt);
  if (this.foulReactT > 0) {
    this.foulReactT = Math.max(0, this.foulReactT - dt);
    // よろけ: 押された方向へのバランスを崩したよろめきステップ。リアクションの
    // 最初の部分で費やす（その後で持ち直す）
    if (this.foulStumble && this.foulReactDur > 0) {
      const remain = this.foulReactT / this.foulReactDur;      // 1 → 0
      const w = clamp((remain - 0.3) / 0.7, 0, 1);             // 最初の~70%で費やす（数歩）
      const r = w * 2.2 * dt;
      this.pos.x += this.foulStaggerX * r;
      this.pos.z += this.foulStaggerZ * r;
    }
  }
};

/**
 * このフレームで使える速度(m/s): 計測した現在速度からトップスピードへ向けて
 * 加速する。加速力がランプを、速度が上限を決め、疲労が上限を下げる。純粋関数
 * — 選手が動く箇所でフレームのdtとともに呼ぶ。
 */
Player.prototype.accelSpeed = function(dt: number, mult = 1): number {
  // バランスの回復（パス/シュート後）や着地からまだ落ち着いていない状態では
  // 足はほとんど動けない — 着地後の最初の一歩は鈍い。動き直しのプラント（激しい
  // カット後）も再プッシュをスロットルするが、少し弱め。
  // 着地: 最初の一歩は鈍い(0.35×)が、硬直が抜けるにつれて全速へ徐々に戻る
  // — なので長く低アスリートな回復でも平坦な静止ではない（動き出せる。ただし
  // landTが終わるまで再ジャンプはできない）。coolT/plantTは平坦なスロットルを保つ。
  let rec = 1;
  if (this.coolT > 0) rec = 0.35;
  else if (this.landT > 0) rec = this.landDur > 0
    ? clamp(0.35 + 0.65 * (1 - this.landT / this.landDur), 0.35, 1) : 0.35;
  else if (this.plantT > 0) rec = this.plantDur > 0
    ? clamp(0.45 + 0.55 * (1 - this.plantT / this.plantDur), 0.45, 1) : 0.45;
  const target = this.runSpeed * mult * (1 - this.fatigue * 0.2) * rec;
  // 加速力: m/s²。凸カーブ(rate^2.2)なので、本当に爆発的な加速力だけがすぐに
  // トップスピードへ達する — 低/中の能力値ははるかにゆっくり立ち上がるので、
  // ずっと長い助走が必要（距離 = v²/2a）。エリート(100)は17.5のまま変わらない。
  const acc = 2.5 + Math.pow(rate(this.attr.accel), 2.2) * 15;
  return Math.min(target, this.curSpd + acc * dt);
};

/** 既存の勢いを(tx,tz)へ向け直すときに保持されるトップスピードの割合。敏捷性が
 *  高いと素早い選手は速度を失わずにカット/切り返しできる。遅い選手は方向を
 *  変えるのに減速せねばならない。まっすぐ動く/静止からは~1。 */
Player.prototype.turnFactor = function(tx: number, tz: number): number {
  if (this.curSpd < 1.2) return 1;                   // 逆らうべき勢いがほとんどない
  const vl = Math.hypot(this.velX, this.velZ);
  const dx = tx - this.pos.x, dz = tz - this.pos.z;
  const dl = Math.hypot(dx, dz);
  if (vl < 0.15 || dl < 0.1) return 1;
  const dot = (dx * this.velX + dz * this.velZ) / (dl * vl); // -1（逆走）.. 1（まっすぐ）
  const turn = (1 - dot) / 2;                         // 0 .. 1
  const keep = 0.32 + rate(this.attr.agility) * 0.68; // 0.32（遅い）.. 1.0（素早い）
  return clamp(1 - turn * (1 - keep), 0.35, 1);
};

/** 体が傾いている間に(tx,tz)へ動くとき保持される速度の割合: 傾きと同じ向き
 *  （またはスクエア）へ動くのは滑らかだが、傾きに逆らって切り返すにはまず重心を
 *  足の上へ引き戻す必要がある — その最初の一歩が遅い。これはドリブラーが守備者を
 *  左右に揺さぶり、彼が戻れないサイドへ抜けることで突く要素（傾き自体は別の場所で
 *  敏捷性に応じて減衰する）。 */
Player.prototype.leanFactor = function(tx: number, tz: number): number {
  const m = Math.abs(this.lean);
  if (m < 0.12) return 1;                            // ほぼスクエア
  const dx = tx - this.pos.x, dz = tz - this.pos.z;
  const dl = Math.hypot(dx, dz);
  if (dl < 0.05) return 1;
  // 符号付きのワールド空間の傾き方向
  const lx = this.leanAxisX * this.lean, lz = this.leanAxisZ * this.lean;
  const ll = Math.hypot(lx, lz);
  if (ll < 1e-4) return 1;
  const align = (dx * lx + dz * lz) / (dl * ll);     // -1 逆らう .. +1 同じ向き
  return clamp(1 - m * Math.max(0, -align) * 0.55, 0.4, 1);
};

/** (tx,tz)へ方向を変えるコストと、傾いた体に逆らうコストでスケールした
 *  accelSpeed。 */
Player.prototype.accelToward = function(dt: number, tx: number, tz: number, mult = 1): number {
  return this.accelSpeed(dt, mult) * this.turnFactor(tx, tz) * this.leanFactor(tx, tz);
};

/** この選手が重心を足の上へ引き戻す速さ(単位/s)。クイックネス(敏捷性)が支配する
 *  — WE2010由来のスケールは圧縮されている（大半のAGIは~65..85）ので、傾きは
 *  意図的に急にして実際の四分位の差が出るようにしている: 足の重い65で~0.7/s
 *  （フルの傾きのリセットに~1.4 s）に対し、素早い85で~2.0/s（~0.5 s）。 */
Player.prototype.leanRecoverRate = function(): number {
  // 基準~70: 計測した再攻撃のカデンツは~1.2 s なので、基準より下では
  // フルの傾きが次のシェイクまで残る（積み重なる）、上では重心がドリブラーが
  // 動き出す前に再びスクエアになる
  return clamp(0.35 + (rate(this.attr.agility) - 0.70) * 9.0, 0.3, 2.6);
};

/** この選手と誰も積極的に競り合っていないとき、傾いた横方向の重心をスクエアへ
 *  徐々に戻す。（オンボールの競り合いはdefendOnBall内で、シェードへ向かう独自の
 *  回復を持つ。） */
Player.prototype.decayLean = function(dt: number): void {
  if (this.lean === 0) return;
  const r = this.leanRecoverRate() * dt;
  this.lean += clamp(-this.lean, -r, r);
};

/**
 * このフレームで実際に達した速度を計測し、疲労を更新する。
 * スタミナが消耗を遅らせる。デッドボール（フリースロー、一時停止）で回復する。
 * すべての移動/衝突が解決した後、フレームごとに1回呼ぶ。
 */
Player.prototype.tickMotion = function(dt: number, resting: boolean): void {
  this.lastDt = dt;   // レート制限された腕のスルーがフレーム長を知れるように記憶する
  if (dt > 0) {
    const moved = Math.hypot(this.pos.x - this.prevX, this.pos.z - this.prevZ);
    this.curSpd = Math.min(moved / dt, 12);
    this.velX = (this.pos.x - this.prevX) / dt;
    this.velZ = (this.pos.z - this.prevZ) / dt;
    // 動き直し: 動きながらの急な方向転換はプラント&再プッシュの一拍を要する
    // — 速度に乗ったまま無料で切り返すことはできない。カットが鋭く速く動いていた
    // （ダッシュ）ほどプラントが長い。素早い(敏捷性)選手はすぐ立て直す。これが
    // 次のステップ(accelSpeed)をスロットルするので切り返しは即時ではない。
    // 緩やかなすり足/小さな調整では発動しない。
    if (!resting) {
      const sp = Math.hypot(this.velX, this.velZ);
      const psp = Math.hypot(this.prevVelX, this.prevVelZ);
      if (sp > 2.0 && psp > 2.0) {
        const dot = (this.velX * this.prevVelX + this.velZ * this.prevVelZ) / (sp * psp);
        if (dot < 0.5) {                                   // ~60°より大きく向きを変えた
          const sharp = (0.5 - dot) / 1.5;                 // 0 .. 1（完全な切り返し）
          const speedFrac = clamp(psp / (this.runSpeed || 1), 0, 1);   // ダッシュはより高くつく
          const quick = rate(this.attr.agility);
          // クイックネスがプラント&再プッシュを支配する: 全速の切り返しはエリート(100)
          // でも~0.3 s、鈍足(0)では最大~2.5 s かかる。部分的なカット/遅い速度は
          // それを縮小する（sharp × speedFrac）。
          const plant = sharp * speedFrac * (0.3 + (1 - quick) * 2.2); // ~0.3s（エリート）.. ~2.5s（遅い）
          if (plant > this.plantT) { this.plantT = plant; this.plantDur = plant; }
        }
      } else if (psp > 3.0 && sp < 2.0) {
        // 急停止: ダッシュからのブレーキもプラントを要する。これがないと急停止が
        // 上のカット検出をすり抜け（spがそのゲートを下回る）、ダッシュ → 停止 → 発進が
        // 無料で出てしまう — カットより速くなり、それは逆。ブレーキが強い
        // （一度に落とす速度が、トップスピードに対して大きい）ほど次の踏み出しまで
        // 長くかかる。素早い(敏捷性)選手はカットのプラントと同じスケールですぐ立て直す。
        const shed = clamp((psp - sp) / (this.runSpeed || 1), 0, 1);
        if (shed > 0.4) {                                  // 徐々に止まるのは無料
          const quick = rate(this.attr.agility);
          // ダッシュからのブレーキ: 完全停止で~0.3 s（エリート）.. ~2.0 s（遅い）、
          // 一度にどれだけ速度を落としたかでスケールする。
          const plant = shed * (0.3 + (1 - quick) * 1.7);  // ~0.3s（エリート）.. ~2.0s（遅い）
          if (plant > this.plantT) { this.plantT = plant; this.plantDur = plant; }
        }
      }
    }
    this.prevVelX = this.velX;
    this.prevVelZ = this.velZ;
  }
  if (resting) {
    // デッドボールはひと息つくだけ — ほとんど回復しない
    this.fatigue = Math.max(0, this.fatigue - 0.003 * dt);
  } else {
    const effort = this.runSpeed > 0 ? clamp(this.curSpd / this.runSpeed, 0, 1.2) : 0;
    const drain = (0.003 + effort * 0.02) * (1.3 - rate(this.attr.stamina));
    const rest = effort < 0.1 ? 0.002 : 0;           // 立ったまま息を整える
    this.fatigue = clamp(this.fatigue + (drain - rest) * dt, 0, 1);
  }
  // ネームタグのスタミナゲージを最新に保つ（見える変化があるときだけ再描画）
  if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
};

/** ベンチに座る: ゆっくりとした着実な回復（即座の全回復ではない） —
 *  高いスタミナ能力値は出場間の回復も速いことを意味する。 */
Player.prototype.benchRecover = function(dt: number): void {
  const rec = 0.002 + rate(this.attr.stamina) * 0.004;   // ~0.0024 .. ~0.006 /秒
  this.fatigue = Math.max(0, this.fatigue - rec * dt);
  if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
};

/** ピリオドの区切り（クォーター休憩/ハーフタイム）での一度きりの回復分。 */
Player.prototype.breakRecover = function(amount: number): void {
  this.fatigue = Math.max(0, this.fatigue - amount);
  if (Math.abs(this.fatigue - this.gaugeDrawn) > 0.02 || this.gaugeRev !== HUD_OPTS.rev) this.drawNameTag();
};

/** 手が現在届く最高点（立ちリーチ+ジャンプ）。 */
Player.prototype.reachTopY = function(): number {
  return this.jumpY() + this.height * 1.35;
};
