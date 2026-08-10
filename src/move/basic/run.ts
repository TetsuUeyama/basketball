// 走行/歩行の物理: 加速・速度・毎フレームの移動tickと硬直/回復タイマーの減算。
import { rate, clamp } from "../../util";
import { HUD_OPTS } from "../../config";
import { reactionLag } from "../../eval";
import { Player } from "../../objects/player/player";

// 硬直(landT/plantT)のうち、頭側の完全硬直（動けない）に充てる割合。
const FREEZE_FRAC = 0.4;

declare module "../../objects/player/player" {
  interface Player {
    recoveryMult(): number;
    applyReactLag(): void;
    setPlant(t: number): void;
    beginAction(kind: string, windup: number, active: number, cooldown: number): void;
    tickAction(dt: number): void;
    actBusy(kind: string): boolean;
    tickCooldown(dt: number): void;
    accelSpeed(dt: number, mult?: number): number;
    accelToward(dt: number, tx: number, tz: number, mult?: number): number;
    tickMotion(dt: number, resting: boolean): void;
  }
}

/** 敏捷性: パス、シュート、着地の後に体が次の動作へどれだけ早く立て直すか
 *  — 素早い選手はおよそ半分の時間で回復する。 */
Player.prototype.recoveryMult = function(): number {
  return 1.3 - rate(this.attr.agility) * 0.65;   // ~0.66（素早い）.. ~1.24（遅い）
};

/** 反応ラグを reactT へ反映する（既存の reactT より短くはしない）。 */
Player.prototype.applyReactLag = function(): void {
  this.reactT = Math.max(this.reactT, reactionLag(this));
};

/** 外部のコミット（例: スティールの踏み込み）からプラント&再プッシュの硬直
 *  （動き直し）を設定する。最も長いものとその全長を加速のイージング用に保持する。 */
Player.prototype.setPlant = function(t: number): void {
  if (t > this.plantT) { this.plantT = t; this.plantDur = t; }
  this.rootT = Math.max(this.rootT, t * FREEZE_FRAC);   // 頭側は完全硬直
};

/** アクションを発生(windup)から開始する。windup→active→cooldown と自動遷移。 */
Player.prototype.beginAction = function(kind: string, windup: number, active: number, cooldown: number): void {
  this.actKind = kind;
  this.actPhase = "windup";
  this.actT = windup;
  this.actActiveDur = active;
  this.actCoolDur = cooldown;
  this.actFired = false;
};

/** アクションの3段階を進める（tickCooldownが毎フレーム呼ぶ）。windup→active の遷移で
 *  actFired を立て（呼び出し側が効果を実行し消費）、active→cooldown→idle と進む。 */
Player.prototype.tickAction = function(dt: number): void {
  if (!this.actPhase) return;
  this.actT -= dt;
  if (this.actT > 0) return;
  if (this.actPhase === "windup") {
    this.actPhase = "active"; this.actT = this.actActiveDur;
    this.actFired = true;                 // 実行フレーム
  } else if (this.actPhase === "active") {
    this.actPhase = "cooldown"; this.actT = this.actCoolDur;
  } else {
    this.actPhase = ""; this.actKind = ""; this.actFired = false;   // cooldown 終了 → idle
  }
};

/** そのアクション種別が発生/実行/クールダウン中で、新たに発動できない。 */
Player.prototype.actBusy = function(kind: string): boolean {
  return this.actKind === kind && this.actPhase !== "";
};

/** パス/シュート後の回復クールダウンを減算する。 */
Player.prototype.tickCooldown = function(dt: number): void {
  this.tickAction(dt);   // アクション3段階を進める
  if (this.coolT > 0) this.coolT = Math.max(0, this.coolT - dt);
  if (this.justPassedT > 0) this.justPassedT = Math.max(0, this.justPassedT - dt);
  if (this.trappedT > 0) this.trappedT = Math.max(0, this.trappedT - dt);
  if (this.keepShieldT > 0) this.keepShieldT = Math.max(0, this.keepShieldT - dt);
  if (this.wallT > 0) this.wallT = Math.max(0, this.wallT - dt);
  if (this.gatherT > 0) this.gatherT = Math.max(0, this.gatherT - dt);
  if (this.pickupT > 0) this.pickupT = Math.max(0, this.pickupT - dt);
  if (this.postT > 0) this.postT = Math.max(0, this.postT - dt);
  if (this.shovedT > 0) this.shovedT = Math.max(0, this.shovedT - dt);
  if (this.plantT > 0) this.plantT = Math.max(0, this.plantT - dt);
  if (this.landT > 0) this.landT = Math.max(0, this.landT - dt);
  if (this.rootT > 0) this.rootT = Math.max(0, this.rootT - dt);
  if (this.shakeOpenT > 0) this.shakeOpenT = Math.max(0, this.shakeOpenT - dt);
  if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dt);
  if (this.quickT > 0) this.quickT = Math.max(0, this.quickT - dt);
  if (this.baitT > 0) this.baitT = Math.max(0, this.baitT - dt);
  if (this.openRollT > 0) this.openRollT = Math.max(0, this.openRollT - dt);
  if (this.setupT > 0) this.setupT = Math.max(0, this.setupT - dt);
  if (this.defWinT > 0) this.defWinT = Math.max(0, this.defWinT - dt);
  if (this.foulReactT > 0) {
    this.foulReactT = Math.max(0, this.foulReactT - dt);
    // よろけ: 押された方向へのバランスを崩したよろめきステップ。リアクションの
    // 最初の部分で費やす（その後で持ち直す）
    // ⚠️ よろけ(foulStumble)のときだけでなく、リアクション中は常に足を運ぶ。
    //    変位が 0 だと実速度も 0 になり、脚のサイクルが回らず棒立ちになる。
    if (this.foulReactT > 0 && this.foulReactDur > 0) {
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
  if (this.rootT > 0) return 0;   // 完全硬直中（着地/切り返し/急停止の直後）は動けない
  if (this.shovedT > 0) return 0; // 押し込まれ中は土台が無い（押される方向へ流されるだけ）
  // バランスの回復（パス/シュート後）や着地からまだ落ち着いていない状態では足は
  // ほとんど動けない。動き直しのプラント（激しいカット後）も再プッシュをスロットルする。
  // 着地: 最初の一歩は鈍い(0.35×)が、硬直が抜けるにつれて全速へ徐々に戻る。
  // coolT/plantTは平坦なスロットルを保つ。
  let rec = 1;
  if (this.coolT > 0) rec = 0.35;
  else if (this.landT > 0) rec = this.landDur > 0
    ? clamp(0.35 + 0.65 * (1 - this.landT / this.landDur), 0.35, 1) : 0.35;
  else if (this.plantT > 0) rec = this.plantDur > 0
    ? clamp(0.45 + 0.55 * (1 - this.plantT / this.plantDur), 0.45, 1) : 0.45;
  const target = this.runSpeed * mult * (1 - this.fatigue * 0.2) * rec;
  // 加速力: m/s²。凸カーブ(rate^2.2)なので爆発的な加速力だけがすぐにトップスピードへ
  // 達する（距離 = v²/2a）。エリート(100)で17.5。
  const acc = 2.5 + Math.pow(rate(this.attr.accel), 2.2) * 15;
  return Math.min(target, this.curSpd + acc * dt);
};

/** (tx,tz)へ方向を変えるコストと、傾いた体に逆らうコストでスケールした
 *  accelSpeed。 */
Player.prototype.accelToward = function(dt: number, tx: number, tz: number, mult = 1): number {
  return this.accelSpeed(dt, mult) * this.turnFactor(tx, tz) * this.leanFactor(tx, tz);
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
          this.rootT = Math.max(this.rootT, plant * FREEZE_FRAC);   // 切り返しの頭側は完全硬直
        }
      } else if (psp > 3.0 && sp < 2.0) {
        // 急停止: ダッシュからのブレーキもプラントを要する。ブレーキが強い（一度に落とす
        // 速度がトップスピードに対して大きい）ほど次の踏み出しまで長くかかる。素早い(敏捷性)
        // 選手はカットのプラントと同じスケールですぐ立て直す。
        const shed = clamp((psp - sp) / (this.runSpeed || 1), 0, 1);
        if (shed > 0.4) {                                  // 徐々に止まるのは無料
          const quick = rate(this.attr.agility);
          // ダッシュからのブレーキ: 完全停止で~0.3 s（エリート）.. ~2.0 s（遅い）、
          // 一度にどれだけ速度を落としたかでスケールする。
          const plant = shed * (0.3 + (1 - quick) * 1.7);  // ~0.3s（エリート）.. ~2.0s（遅い）
          // 急停止は再加速(次の踏み出し)だけをスロットルする。完全硬直(rootT)は付けない —
          // ダッシュで詰めてブレーキした守備者(プレス/クローズアウト)がその場で棒立ちに
          // なるのを防ぐ。スライド/構えは即できる。切り返し(カットプラント)の rootT は残す。
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
