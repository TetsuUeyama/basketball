// 選手の脚・ジャンプ・着席の移動/姿勢アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { HUD_OPTS } from "./config";
import { clamp } from "./util";
import { rate } from "./attributes";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    jump(height: number, dur: number, leapX?: number, leapZ?: number): void;
    updateJump(dt: number): void;
    updateLegs(dt: number): void;
    updateAcornFeet(dt: number): void;
    syncAcornLegs(): void;
    foldSeatedLegs(): void;
    sit(): void;
    stand(): void;
    foldAcornSeat(): void;
    unfoldAcornSeat(): void;
  }
}

Player.prototype.jump = function(height: number, dur: number, leapX = 0, leapZ = 0): void {
    // 前回の着地からまだバランスを立て直している最中——まだ跳べない
    if (this.landT > 0) return;
    // 空中で、大きいジャンプを小さいジャンプで再始動しない
    if (this.jumpRemaining > 0 && height <= this.jumpHeight) return;
    this.jumpHeight = height;
    this.jumpDur = dur;
    this.jumpRemaining = dur;
    this.leapX = leapX;
    this.leapZ = leapZ;
};

Player.prototype.updateJump = function(dt: number): void {
    if (this.jumpRemaining > 0) {
      // 斜めのジャンプは飛行中を一定レートで水平に運ぶ
      // （弾道: 水平速度一定）ので、総移動量 = (leapX,leapZ)
      if (this.jumpDur > 0 && (this.leapX !== 0 || this.leapZ !== 0)) {
        const f = Math.min(dt, this.jumpRemaining) / this.jumpDur;
        this.pos.x += this.leapX * f;
        this.pos.z += this.leapZ * f;
      }
      this.jumpRemaining = Math.max(0, this.jumpRemaining - dt);
      if (this.jumpRemaining === 0) {
        // 着地 硬直: 再ジャンプや爆発の前に重心が落ち着く必要がある。
        // クイックネス(敏捷性) と ジャンプ力 の両方で駆動——両方エリートなら速く
        // リセット(~0.3 s)、どちらかが下がると急峻に伸びる（両方低いとフルジャンプで
        // ≈ 2.5 s）。ゆえに ジャンプ力 の高い選手は高く跳び(jump() の高さ)、次の
        // ために素早く立て直す。大きいジャンプはリセットがやや遅く、小さいホップは
        // 速い。再ジャンプを阻み、最初の数歩を鈍らせる(accelSpeed)。
        const ability = (rate(this.attr.agility) + rate(this.attr.jump)) / 2;   // 1 = 両方エリート
        const base = 0.3 + Math.pow(1 - ability, 0.85) * 2.2;                    // 0.3 .. 2.5 (フルジャンプ)
        const heightScale = clamp(0.5 + this.jumpHeight * 0.9, 0.45, 1.3);
        this.landDur = this.landT = clamp(base * heightScale, 0.3, 2.6);
        this.leapX = this.leapZ = 0;
      }
    }
};

  // 歩行/走行サイクルの1フレーム: 速度とともに伸びるストライドで腰を
  // 前後に振り（脚ごとに逆位相）、前方への振りで膝を曲げる。歩行ペース
  // 未満では脚は真っ直ぐへイーズで戻る。着席中は静止させる
  // (ポーズは sit() が管理)。
Player.prototype.updateLegs = function(dt: number): void {
    if (this.seated) return;
    if (HUD_OPTS.model !== "human") { this.updateAcornFeet(dt); return; }
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    if (frac < 0.04) {
      this.stridePhase = 0;
      const ease = Math.min(1, dt * 12);
      this.hipL.rotation.x += -this.hipL.rotation.x * ease;
      this.hipR.rotation.x += -this.hipR.rotation.x * ease;
      this.kneeL.rotation.x += -this.kneeL.rotation.x * ease;
      this.kneeR.rotation.x += -this.kneeR.rotation.x * ease;
      return;
    }
    this.stridePhase += this.curSpd * dt * 3.4;   // 距離ベース → 速度がケイデンスを決める
    const amp = 0.32 + frac * 0.5;                // スプリントではストライドが長い
    // 前方はローカル -numberSide·Z（腕/つま先と同じ）なので、振りと膝の曲げは
    // numberSide に紐づく——両チームともどちらの端を攻めても前に歩き、膝を後ろへ
    // 曲げる。
    const ns = this.numberSide;
    const sL = Math.sin(this.stridePhase), sR = Math.sin(this.stridePhase + Math.PI);
    this.hipL.rotation.x = sL * amp * ns;          // + 位相で足を前へ振る
    this.hipR.rotation.x = sR * amp * ns;
    const bend = 0.5 + frac * 0.6;
    this.kneeL.rotation.x = -Math.max(0, sL) * bend * ns;   // 前方への振りで脛が後ろへ流れる
    this.kneeR.rotation.x = -Math.max(0, sR) * bend * ns;
};

  // どんぐりの靴のペンギン歩き: 移動中は足が素早いつま先上げのパタパタを交互に
  // 行う（靴底でピボットするので踵は接地したまま——ケイデンスと持ち上げが速度と
  // ともに増すパタパタ歩き）。空中では両つま先がぶら下がるように下を向く。静止時は
  // フラットへイーズで戻る。stridePhase を共有するので、走行中のモード切り替えでも
  // 歩調が揃う。
Player.prototype.updateAcornFeet = function(dt: number): void {
    const frac = this.runSpeed > 0 ? Math.min(1, this.curSpd / this.runSpeed) : 0;
    let tL = 0, tR = 0, tw = 0;
    if (this.airborne) {
      tL = tR = -0.55;                              // つま先が床から離れ下を向く
    } else if (frac >= 0.04) {
      // スプリントでケイデンス ~3 歩/s——これより速いと下のイージングで2つの足が
      // 交互ではなく一緒にパタつくようにぼやける
      this.stridePhase += this.curSpd * dt * 3.0;
      const amp = 0.35 + frac * 0.4;
      tL = Math.max(0, Math.sin(this.stridePhase)) * amp;
      tR = Math.max(0, Math.sin(this.stridePhase + Math.PI)) * amp;
      // 体は接地した足へ傾く——持ち上げたつま先から離れる方へ——これがペンギン
      // 歩きそのもの。揺れはペースとともに少し広がる。
      // クイックネス(敏捷性) がこれを安定させる: 機敏な選手はほとんど揺れない
      // (99 ≈ 肩が水平)、足の重い選手は最大限に揺れる。
      // 純粋に見た目だけ——速度やバランスへの影響はない。
      const wobble = 1 - rate(this.attr.agility);
      tw = -Math.sin(this.stridePhase) * (0.07 + frac * 0.06) * wobble;
    } else {
      this.stridePhase = 0;
    }
    const ease = Math.min(1, dt * 22);
    this.acornFootL.rotation.x += (tL - this.acornFootL.rotation.x) * ease;
    this.acornFootR.rotation.x += (tR - this.acornFootR.rotation.x) * ease;
    this.acornWaddle += (tw - this.acornWaddle) * ease;
    // ノード原点ではなく踵を軸にパタつかせる: つま先上げのピッチだけだと踵の後端
    // （ローカル z = heelBotZ 0.18）が床を突き抜けて下がるので、ノードをその沈んだ
    // 深さだけ持ち上げる——つま先が叩き、踵は接地したまま。つま先下げ（空中）は
    // 持ち上げ不要: root が空中にある。
    this.acornFootL.position.y = Math.max(0, Math.sin(this.acornFootL.rotation.x)) * 0.18;
    this.acornFootR.position.y = Math.max(0, Math.sin(this.acornFootR.rotation.x)) * 0.18;
    this.syncAcornLegs();
};

  // 素肌の脚シリンダーを腰と靴の間に固定し続ける: 脚は垂直を保ち
  // （足のつま先パタつきの傾きを継承しない）、足の持ち上げ/スタンスに
  // y と z で乗るだけなので、足がパタつく間も上端は腰に収まり、下端は
  // 靴の中に留まる。
Player.prototype.syncAcornLegs = function(): void {
    this.acornLegL.position.y = this.acornFootL.position.y;
    this.acornLegL.position.z = this.acornFootL.position.z;
    this.acornLegR.position.y = this.acornFootR.position.y;
    this.acornLegR.position.z = this.acornFootR.position.z;
};

  // 太ももを前（コート側、ベンチの選手はボールを向くため）へ畳み、脛を床へ
  // 落とす——numberSide に紐づくので、両ベンチとも片方がベンチを突き抜けて後ろへ
  // 畳むのではなく前へ（座面の上へ）畳む。
Player.prototype.foldSeatedLegs = function(): void {
    const ns = this.numberSide;
    this.hipL.rotation.x = this.hipR.rotation.x = Player.SIT_HIP * ns;
    this.kneeL.rotation.x = this.kneeR.rotation.x = Player.SIT_KNEE * ns;
};

  // ベンチへの着席 / 起立。着席はリグ全体を下げて腰を座面に
  // 合わせ、脚を畳む（太ももを前、脛を下）。起立は歩行サイクルへ
  // 戻す。
Player.prototype.sit = function(): void {
    this.seated = true;
    this.handsRest();
    this.resetTwist();   // ベンチに正対して座る
    this.foulReactT = 0;
    this.defWinT = 0;
    this.flinchPitch = 0;
    this.foldSeatedLegs();   // どんぐりモードでは隠れるが、ポーズの一貫性を保つ
    if (HUD_OPTS.model === "acorn") this.foldAcornSeat();
};

Player.prototype.stand = function(): void {
    if (!this.seated) return;
    this.seated = false;
    this.root.rotation.x = 0;
    this.hipL.rotation.x = this.hipR.rotation.x = 0;   // 脚が真っ直ぐになる
    this.kneeL.rotation.x = this.kneeR.rotation.x = 0;
    this.unfoldAcornSeat();  // 腰を下ろし直し、靴を立ち姿勢へ戻す
};

Player.prototype.foldAcornSeat = function(): void {
    const ns = this.numberSide;
    const fold = Player.SIT_FOLD;                 // きつい 90° より緩やか
    this.acornWaistPivot.rotation.x = fold * ns;
    const s = this.height / 1.95;
    // 床に接地したより平らな足は、急なつま先下げより座っているように見える。
    // `lift` は座面の下げとつま先ピッチに対して床接地を自己補正する。z は水平なので、
    // どちらにせよ足は接地したまま。
    const TILT = 0.30;                     // つま先下げのピッチ（ローカルの踵上げは両側とも -x）
    const toeDrop = 0.28 * Math.sin(TILT); // ピッチしたつま先（z -0.28）がノードよりこれだけ下がる
    const RAISE = 0.24;                    // 足を床から持ち上げる（ぶら下がった見た目）
    const lift = Player.acornSeatDrop() - Player.SEAT_SURF / s + toeDrop + RAISE;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = -TILT;
    this.acornFootL.position.y = this.acornFootR.position.y = lift;
    // 足は腰の底の真下から生え（緩い畳みでは前方への張り出しが縮む）、真っ直ぐ
    // 床へ落ちる
    const footZ = -ns * Player.ACORN_WAIST_LEN * Math.sin(fold) * 0.7;
    this.acornFootL.position.z = this.acornFootR.position.z = footZ;
    this.syncAcornLegs();
};

  // 立ち姿勢の配置へ戻す（ヒューマンモードで呼んでも安全）。
Player.prototype.unfoldAcornSeat = function(): void {
    this.acornWaistPivot.rotation.x = 0;
    this.acornFootL.rotation.x = this.acornFootR.rotation.x = 0;
    this.acornFootL.position.y = this.acornFootR.position.y = 0;
    this.acornFootL.position.z = this.acornFootR.position.z =
      -this.numberSide * Player.ACORN_FOOT_Z;
    this.syncAcornLegs();
};

