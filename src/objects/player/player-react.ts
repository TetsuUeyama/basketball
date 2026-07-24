// 選手のリアクション（ファウル/守備成功/落胆/ベンチ待機）アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { Vector3 } from "@babylonjs/core";
import { clamp, rand, chance } from "../../util";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    benchIdle(dt: number, ballX: number, ballZ: number): void;
    dejectedPose(): void;
    foulReaction(kind: "hurt" | "and1", pushX?: number, pushZ?: number, strength?: number): void;
    poseFoulReaction(): void;
    defWin(kind: "block" | "steal" | "stop"): void;
    poseDefWin(): void;
  }
}

/**
 * ベンチに座ってボールを眺める1フレーム: 視線は数秒ごとに漂う個人的な
 * オフセットとともにボールを追い、数秒ごとに小さなランダムなそわそわが発火する
 * — 小さなホップ、片手を半分上げる、腕を広げる。自身のジャンプ減算とメッシュ
 * 同期を処理する（ベンチの選手はコート上の毎フレーム更新を受けない）。
 */
Player.prototype.benchIdle = function(dt: number, ballX: number, ballZ: number): void {
    this.benchGazeT -= dt;
    if (this.benchGazeT <= 0) {
      this.benchGazeT = rand(0.8, 2.5);
      this.benchGazeOff = rand(-0.22, 0.22);
    }
    this.faceToward(ballX, ballZ, this.benchGazeOff);

    this.updateJump(dt);
    if (this.benchArmT > 0) {
      this.benchArmT -= dt;
      if (this.benchArmT <= 0) this.handsRest();  // ジェスチャー終了——落ち着く
    }
    this.benchActT -= dt;
    if (this.benchActT <= 0) {
      this.benchActT = rand(2.0, 7.0);
      const roll = Math.random();
      if (roll < 0.35) {
        this.jump(rand(0.06, 0.16), rand(0.25, 0.4));      // 小さなホップ
      } else if (roll < 0.6) {
        this.reach(new Vector3(this.pos.x + rand(-0.4, 0.4), rand(2.1, 2.9),
          this.pos.z + rand(-0.4, 0.4)));                   // 片手が上がる
        this.benchArmT = rand(0.4, 1.0);
      } else if (roll < 0.8) {
        this.armsWide();                                    // 腕を大きく広げる
        this.benchArmT = rand(0.4, 0.9);
      } else {
        this.reach(new Vector3(this.pos.x, rand(2.6, 3.2), this.pos.z), true);
        this.benchArmT = rand(0.35, 0.8);                   // 両手を、短く
      }
    }
    this.sync();
};

/** うなだれ: 腰と脚は直立のまま — 上半身だけが前へかがみ（胴のピッチ）、腕は
 *  だらりと垂れる。とぼとぼとベンチへ戻る間もこの姿勢を保つ（脚は下で歩き続ける）。
 *  毎フレーム呼んで保持する。resetTwist()/sit()/resetFacing()が体をまっすぐに戻す。 */
Player.prototype.dejectedPose = function(): void {
    const Pt = -this.numberSide * 0.42;                    // 胸が前へ傾く
    const cut = Player.ACORN_CUT;
    this.torsoNode.rotation.x = Pt;
    this.torsoNode.rotation.y = 0;                         // うなだれている間はプレーツイストなし
    this.torsoTwist = 0;
    // 前傾を（足ではなく）腰の切れ目でヒンジさせる: 胴をオフセットして腰の点は
    // 動かず上半身だけがその上で前傾するようにする——胴全体が傾くのではなく
    // 腰とヒップは真っ直ぐのまま。
    this.torsoNode.position.set(0, cut * (1 - Math.cos(Pt)), -cut * Math.sin(Pt));
    this.flinchPitch = 0;                                  // root（腰/脚）は直立のまま
    // 前傾した胸の下でどんぐりの腰自体を垂直に保つ
    this.acornWaistPivot.rotation.x = -Pt;
    // 胴の前傾にかかわらず腕をワールドで真下に垂らす（ピッチを補正）
    this.setArmDir(this.armPivotL, -0.14, -Math.cos(Pt), Math.sin(Pt));
    this.setArmDir(this.armPivotR, 0.14, -Math.cos(Pt), Math.sin(Pt));
    this.bendElbow(this.elbowL, 0.05);
    this.bendElbow(this.elbowR, 0.05);
};

/** ファウルリアクションを開始する。`pushX/pushZ` は接触が彼を弾いたワールド方向
 *  （0,0=不明 → 単純に後ろへのけぞる）。`strength` (0..1) がのけぞりの強さ、
 *  継続時間、よろけになる確率をスケールする。 */
Player.prototype.foulReaction = function(kind: "hurt" | "and1", pushX = 0, pushZ = 0, strength = 0.5): void {
    this.foulReactKind = kind;
    const s = clamp(strength, 0, 1);
    this.foulStrength = s;
    const pl = Math.hypot(pushX, pushZ);
    if (pl > 0.01) { this.foulPushX = pushX / pl; this.foulPushZ = pushZ / pl; }
    else { this.foulPushX = this.foulPushZ = 0; }        // 方向なし → 後ろへ揺れる
    // 強く中心を外れたヒットは後方へ吹き飛ばしうる——足が浮く小さなホップと
    // 大きなよろめき。軽いものはつまずく一歩だけ。ほとんどはどちらでもない。
    const hard = kind === "hurt" && pl > 0.01;
    const knock = hard && s > 0.45 && chance(0.25 + (s - 0.45) * 1.1);   // 吹き飛ばされる
    // 強い接触の多くは後退させる——数歩のよろめき（よろめきは実際の速度を
    // 駆動するので、updateLegs が実際に足を運ぶ）
    this.foulStumble = hard && (knock || chance(0.4 + s * 0.5));
    // 強いヒットほど長く見せる。よろめき/ノックバックには足を運んで着地する時間が要る
    this.foulReactDur = this.foulReactT =
      kind === "and1" ? 1.1 : knock ? (1.2 + s * 0.5) : (0.85 + s * 0.6);
    if (kind === "and1") this.jump(0.22, 0.4);           // フレックスのホップ
    else if (knock) this.jump(0.16 + s * 0.18, 0.5 + s * 0.2);   // 床から弾け飛ぶ
    if (this.foulStumble) {
      const step = knock ? (1.1 + s * 1.3) : (0.55 + s * 0.8);   // 数歩後ろへ
      this.foulStaggerX = this.foulPushX * step;
      this.foulStaggerZ = this.foulPushZ * step;
    } else { this.foulStaggerX = this.foulStaggerZ = 0; }
};

/** ファウルリアクションのポーズの1フレーム。runArmsの後に呼ぶ（動いている間は
 *  腕を占有する）。減算はtickCooldownで行う。 */
Player.prototype.poseFoulReaction = function(): void {
    if (this.foulReactT <= 0) {
      this.flinchPitch = this.flinchRoll = 0;   // 反応終了（または中断）——立ち直る
      return;
    }
    const k = this.foulReactDur > 0 ? 1 - this.foulReactT / this.foulReactDur : 1;
    const env = Math.sin(Math.min(1, k * 1.15) * Math.PI);   // 立ち上がり、緩やかに収まる
    if (this.foulReactKind === "and1") {
      // フレックス: 両拳を頭の横に上げ、肘を強く畳む
      this.setArmDir(this.armPivotL, -0.7, 0.9, 0);
      this.setArmDir(this.armPivotR, 0.7, 0.9, 0);
      this.bendElbow(this.elbowL, 1.35);
      this.bendElbow(this.elbowR, 1.35);
      this.flinchPitch = this.flinchRoll = 0;
    } else {
      // 接触を演出: 腕が低く外へ飛び出しバランスを取る
      this.setArmDir(this.armPivotL, -1, -0.5, 0.25);
      this.setArmDir(this.armPivotR, 1, -0.5, 0.25);
      this.elbowL.rotation.set(0, 0, 0); this.elbowR.rotation.set(0, 0, 0);
      if (this.foulPushX !== 0 || this.foulPushZ !== 0) {
        // 方向性のある揺れ: ヒットが送った方向へ体を傾け、強い接触ほど大きく。
        // ワールドの押し → ヨーローカルのピッチ/ロール（前傾の傾きと同じ規約）で
        // 全身がヒットで傾く。
        const th = this.root.rotation.y;
        const c = Math.cos(th), s = Math.sin(th);
        const m = (0.16 + this.foulStrength * 0.34) * env;   // 傾き量
        const wx = this.foulPushX * m, wz = this.foulPushZ * m;
        this.flinchPitch = wx * s + wz * c;                  // ローカル +Z へ傾く
        this.flinchRoll = -(wx * c - wz * s);                // そしてローカル +X へ
      } else {
        // 方向情報なし → 従来の真っ直ぐ後ろへの揺れ
        this.flinchPitch = this.numberSide * 0.22 * env;
        this.flinchRoll = 0;
      }
    }
};

/** 守備成功の演出を開始する（純粋に見た目のみ）。ファウルリアクションが既に
 *  動いている場合は無視する（ブロックからのファウルは接触の演出を保つ）。 */
Player.prototype.defWin = function(kind: "block" | "steal" | "stop"): void {
    if (this.foulReactT > 0) return;
    this.defWinKind = kind;
    this.defWinDur = this.defWinT = kind === "block" ? 1.25 : kind === "steal" ? 1.0 : 0.8;
    // 接地しているときだけ小さく力強いホップ——スワットでまだ上にいるブロッカーは
    // 既存のジャンプを保つ（この処理がそのより大きいジャンプを踏み潰してはならない）
    if (kind === "block" && !this.airborne) this.jump(0.14, 0.4);
};

/** 守備成功のポーズの1フレーム。runArms/poseFoulReactionの後に呼ぶ（動いている間は
 *  腕+ひるみの傾きを占有する）。減算はtickCooldownで行う。呼び出し側は、選手が
 *  アクティブなボールの仕事（ハンドリング、シュート、まだ空中、ルーズボールへの
 *  スクランブル）を持つ間はこれを抑止する。 */
Player.prototype.poseDefWin = function(): void {
    if (this.defWinT <= 0) return;
    const k = this.defWinDur > 0 ? 1 - this.defWinT / this.defWinDur : 1;
    const env = Math.sin(Math.min(1, k * 1.25) * Math.PI);     // 立ち上がり、緩やかに収まる
    const pump = Math.max(0, Math.sin(k * Math.PI * 3));       // 素早いダブルパンプ
    if (this.defWinKind === "block") {
      // 勝ち誇る: 両拳を頭の横に上げる（拒否のフレックス）
      this.setArmDir(this.armPivotL, -0.55, 0.95, 0.05);
      this.setArmDir(this.armPivotR, 0.55, 0.95, 0.05);
      this.bendElbow(this.elbowL, 1.1 + pump * 0.3);
      this.bendElbow(this.elbowR, 1.1 + pump * 0.3);
      this.flinchPitch = this.numberSide * 0.10 * env;          // 胸を上げて後ろへ軽く揺れる
      this.flinchRoll = 0;
    } else if (this.defWinKind === "steal") {
      // 低いダブル拳パンプ——拳を肋骨のあたりで握り、素早く数回パンプ
      this.setArmDir(this.armPivotL, -0.35, -0.15 + pump * 0.25, 0.2);
      this.setArmDir(this.armPivotR, 0.35, -0.15 + pump * 0.25, 0.2);
      this.bendElbow(this.elbowL, 1.25);
      this.bendElbow(this.elbowR, 1.25);
      this.flinchPitch = -this.numberSide * 0.12 * env;         // 前へ乗り込む（前方）
      this.flinchRoll = 0;
    } else {
      // STOP / 壁: 踏ん張った——腕を低く前へ、胸を構え、身構える
      this.setArmDir(this.armPivotL, -0.9, -0.35, 0.4);
      this.setArmDir(this.armPivotR, 0.9, -0.35, 0.4);
      this.bendElbow(this.elbowL, 0.15);
      this.bendElbow(this.elbowR, 0.15);
      this.flinchPitch = -this.numberSide * 0.14 * env;         // ドライブに向かって前へ身構える
      this.flinchRoll = 0;
    }
};

