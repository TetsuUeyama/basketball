// 胸・頭の部位定義と基本ムーバ（向き/ツイスト）。可動域・速度は
// JOINT.chestTwist / JOINT.headTurn に従う。各アクションのアニメはこれを通す。
import { clamp, normAngle } from "../../util";
import { Player } from "../../objects/player/player";
import { JOINT } from "./joints";

declare module "../../objects/player/player" {
  interface Player {
    worldYawTo(x: number, z: number): number;
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

/** 胸（ローカル -numberSide·Z）がワールド点 (x,z) を向くためのワールドヨー。 */
Player.prototype.worldYawTo = function(x: number, z: number): number {
    const s = this.numberSide;
    return Math.atan2(-s * (x - this.pos.x), -s * (z - this.pos.z));
};

/** 上半身をツイストして、root（脚、足）が自身の向きを保ったまま胸がワールド点を
 *  向くようにする — 走りながら受ける、並走しながらドライブへ追随する。TWIST_MAXに
 *  クランプし平滑化する。rootの向き付近を狙う（またはスクエアに立つ）と
 *  ゼロへ巻き戻る。 */
Player.prototype.twistToward = function(x: number, z: number, dt: number, maxTwist = JOINT.chestTwist.max, rate = JOINT.chestTwist.speed): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      const d = normAngle(this.worldYawTo(x, z) - this.root.rotation.y);
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
Player.prototype.lookToward = function(x: number, z: number, dt: number, rate = JOINT.headTurn.speed): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    let want = 0;
    if (Math.abs(fx) + Math.abs(fz) >= 0.05) {
      const d = normAngle(this.worldYawTo(x, z) - this.root.rotation.y - this.torsoTwist);
      want = clamp(d, JOINT.headTurn.min, JOINT.headTurn.max);
    }
    this.headYaw += clamp(want - this.headYaw, -rate * dt, rate * dt);
    this.headNode.rotation.y = this.headYaw;
};

/** 胸を今すぐ(x,z)へ向ける（イージングなし） — 両手パスは胸を的へ正対させて
 *  投げる。胴はそこへツイストする。足は胴が賄えない分だけ回る（|twist|は
 *  TWIST_MAXで上限）ので、上半身が受け手に定まる間、足は遅れうる
 *  （「足はズレていても」）。 */
Player.prototype.faceChestToward = function(x: number, z: number): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;
    const want = this.worldYawTo(x, z);              // 目標とする胸のワールドヨー
    let twist = normAngle(want - this.root.rotation.y);
    if (Math.abs(twist) > JOINT.chestTwist.max) {      // 胴の可動域を超える → 超過分は足を回す
      this.root.rotation.y += twist - Math.sign(twist) * JOINT.chestTwist.max;
      twist = Math.sign(twist) * JOINT.chestTwist.max;
    }
    this.torsoTwist = twist;
    this.torsoNode.rotation.y = twist;
};

/** 胸が現在向いている方向とワールド点への方向の間の符号付き角度(rad)。
 *  0=的が胸の真正面。±π/2=真横。±π/2を越える=上半身の後ろ（そこへのパスは
 *  彼が向き直す必要がある）。 */
Player.prototype.relativeChestAngle = function(x: number, z: number): number {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 1e-4) return 0;
    const want = this.worldYawTo(x, z);                // 目標を向くためのワールドヨー
    const chest = this.root.rotation.y + this.torsoTwist;
    return normAngle(want - chest);
};

/** 胸を即座に腰の上へスクエアに戻す（ベンチ着席、リセット）。 */
Player.prototype.resetTwist = function(): void {
    this.torsoTwist = 0;
    this.torsoNode.rotation.y = 0;
    this.headYaw = 0;                                   // 頭も真っ直ぐにする
    if (this.headNode) this.headNode.rotation.y = 0;
    this.headPitch = 0;                                 // シュート溜めの顔向き補正をクリア
    this.torsoNode.rotation.x = 0;   // 落胆で前かがみになった分をクリア
    this.torsoNode.position.set(0, 0, 0);   // 落胆の腰ヒンジオフセットも
};

/** 姿全体をヨーさせて、胸（番号の反対側）がワールド点を向くようにする —
 *  ベンチの選手が目でボールを追う。コート上のボディはヨーしない（すべての
 *  ゲーム計算がそれを前提とする）ので、これはベンチ専用。 */
Player.prototype.faceToward = function(x: number, z: number, yawOffset = 0): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.01) return;
    // RotationY(θ) はローカル +Z を (sinθ, 0, cosθ) へ写す。胸はローカル -s·Z
    this.root.rotation.y = this.worldYawTo(x, z) + yawOffset;
};

/** コート上のボディをワールド点へ向ける。このフレームで最大 `maxStep` ラジアン
 *  までイージングするので、選手はプレー（ボール、または攻めるバスケット）を
 *  カクつかずに追う。faceTowardと同じ胸の向き規約を使う。腕のリグ(aimArm)は
 *  結果として生じるヨーを織り込む。 */
Player.prototype.faceSmooth = function(x: number, z: number, maxStep: number): void {
    const fx = x - this.pos.x, fz = z - this.pos.z;
    if (Math.abs(fx) + Math.abs(fz) < 0.05) return;   // 目標が自分の真上——向きを保持
    const d = normAngle(this.worldYawTo(x, z) - this.root.rotation.y);   // 最短の角度経路
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
