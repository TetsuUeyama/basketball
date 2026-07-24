// 選手の向き/ツイスト（胸・頭・体の向き）アニメーション（プロトタイプ拡張で Player に紐づけ）。本体は entities.ts から逐語移動
// （this は Player インスタンスのまま）。呼び出し側は不変。game.ts が副作用 import する。
import { clamp } from "../../util";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    twistToward(x: number, z: number, dt: number, maxTwist?: number, rate?: number): void;
    lookToward(x: number, z: number, dt: number, rate?: number): void;
    faceChestToward(x: number, z: number): void;
    relativeChestAngle(x: number, z: number): number;
    resetTwist(): void;
    faceToward(x: number, z: number, yawOffset?: number): void;
    faceSmooth(x: number, z: number, maxStep: number): void;
    resetFacing(): void;
  }
}

/** 上半身をツイストして、root（脚、足）が自身の向きを保ったまま胸がワールド点を
 *  向くようにする — 走りながら受ける、並走しながらドライブへ追随する。TWIST_MAXに
 *  クランプし平滑化する。rootの向き付近を狙う（またはスクエアに立つ）と
 *  ゼロへ巻き戻る。 */
Player.prototype.twistToward = function(x: number, z: number, dt: number, maxTwist = Player.TWIST_MAX, rate = 10): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      let d = Math.atan2(-s * fx, -s * fz) - this.root.rotation.y;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      want = clamp(d, -maxTwist, maxTwist);
    }
    const step = rate * 0.5 * dt;   // 上半身は半分のレートで回る——胸を新しい向きへ
                                     // ツイストするのに2倍の時間がかかる
    this.torsoTwist += clamp(want - this.torsoTwist, -step, step);
    this.torsoNode.rotation.y = this.torsoTwist;
};

/** 胸のツイストの上に重ねて、頭を回してワールド点を見る — 片方向へ動く/向いた
 *  選手でもボール（やマーク）を見続けられる。胸を越えてHEAD_MAXにクランプし
 *  平滑化する。胸が既に向いている方を見るとゼロへ巻き戻る。 */
Player.prototype.lookToward = function(x: number, z: number, dt: number, rate = 11): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      let d = Math.atan2(-s * fx, -s * fz) - this.root.rotation.y - this.torsoTwist;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      want = clamp(d, -Player.HEAD_MAX, Player.HEAD_MAX);
    }
    this.headYaw += clamp(want - this.headYaw, -rate * dt, rate * dt);
    this.headNode.rotation.y = this.headYaw;
};

/** 胸を今すぐ(x,z)へ向ける（イージングなし） — 両手パスは胸を的へ正対させて
 *  投げる。胴はそこへツイストする。足は胴が賄えない分だけ回る（|twist|は
 *  TWIST_MAXで上限）ので、上半身が受け手に定まる間、足は遅れうる
 *  （「足はズレていても」）。 */
Player.prototype.faceChestToward = function(x: number, z: number): void {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;
    const want = Math.atan2(-s * fx, -s * fz);       // 目標とする胸のワールドヨー
    let twist = want - this.root.rotation.y;
    while (twist > Math.PI) twist -= 2 * Math.PI;
    while (twist < -Math.PI) twist += 2 * Math.PI;
    if (Math.abs(twist) > Player.TWIST_MAX) {          // 胴の可動域を超える → 超過分は足を回す
      this.root.rotation.y += twist - Math.sign(twist) * Player.TWIST_MAX;
      twist = Math.sign(twist) * Player.TWIST_MAX;
    }
    this.torsoTwist = twist;
    this.torsoNode.rotation.y = twist;
};

/** 胸が現在向いている方向とワールド点への方向の間の符号付き角度(rad)。
 *  0=的が胸の真正面。±π/2=真横。±π/2を越える=上半身の後ろ（そこへのパスは
 *  彼が向き直す必要がある）。 */
Player.prototype.relativeChestAngle = function(x: number, z: number): number {
    const s = this.numberSide;
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 1e-4) return 0;
    const want = Math.atan2(-s * fx, -s * fz);         // 目標を向くためのワールドヨー
    const chest = this.root.rotation.y + this.torsoTwist;
    let d = want - chest;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
};

/** 胸を即座に腰の上へスクエアに戻す（ベンチ着席、リセット）。 */
Player.prototype.resetTwist = function(): void {
    this.torsoTwist = 0;
    this.torsoNode.rotation.y = 0;
    this.headYaw = 0;                                   // 頭も真っ直ぐにする
    if (this.headNode) this.headNode.rotation.y = 0;
    this.torsoNode.rotation.x = 0;   // 落胆で前かがみになった分をクリア
    this.torsoNode.position.set(0, 0, 0);   // 落胆の腰ヒンジオフセットも
    if (!this.seated) this.acornWaistPivot.rotation.x = 0;   // 腰を垂直に戻す
};

/** 姿全体をヨーさせて、胸（番号の反対側）がワールド点を向くようにする —
 *  ベンチの選手が目でボールを追う。コート上のボディはヨーしない（すべての
 *  ゲーム計算がそれを前提とする）ので、これはベンチ専用。 */
Player.prototype.faceToward = function(x: number, z: number, yawOffset = 0): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.01) return;
    const s = this.numberSide;
    // RotationY(θ) はローカル +Z を (sinθ, 0, cosθ) へ写す。胸はローカル -s·Z
    this.root.rotation.y = Math.atan2(-s * fx, -s * fz) + yawOffset;
};

/** コート上のボディをワールド点へ向ける。このフレームで最大 `maxStep` ラジアン
 *  までイージングするので、選手はプレー（ボール、または攻めるバスケット）を
 *  カクつかずに追う。faceTowardと同じ胸の向き規約を使う。腕のリグ(aimArm)は
 *  結果として生じるヨーを織り込む。 */
Player.prototype.faceSmooth = function(x: number, z: number, maxStep: number): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;   // 目標が自分の真上——向きを保持
    const s = this.numberSide;
    const target = Math.atan2(-s * fx, -s * fz);
    let d = target - this.root.rotation.y;
    while (d > Math.PI) d -= 2 * Math.PI;             // 最短の角度経路
    while (d < -Math.PI) d += 2 * Math.PI;
    this.root.rotation.y += clamp(d, -maxStep, maxStep);
};

/** ヨーをクリアする（試合開始/ベンチの視線）。ボディは次の向き更新で再び
 *  スクエアになる。 */
Player.prototype.resetFacing = function(): void {
    this.root.rotation.y = 0;
    this.root.rotation.x = this.root.rotation.z = 0;   // 直立もさせる
    this.tiltX = this.tiltZ = 0;
    this.lean = 0;
    this.flinchPitch = 0;
    this.resetTwist();
};

