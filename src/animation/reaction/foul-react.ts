// ファウル/ブロックを受けたリアクションのアニメ（のけぞり/よろめき/and1フレックス）。
// basic/arms のムーバ経由で動く。
//
// ⚠️ 直前に何をしていたかで形を変える。全部が「両腕を低く外へ出して斜めに流れる」
// だけだと、シュートを叩かれても走っていて当てられても同じ動きになる。
import { clamp, chance, rand } from "../../util";
import { Player } from "../../objects/player/player";

/** リアクションの型。直前の動作から選ぶ。 */
export type FoulKind = "hurt" | "and1" | "shoot" | "drive";

declare module "../../objects/player/player" {
  interface Player {
    foulReaction(kind: FoulKind, pushX?: number, pushZ?: number, strength?: number): void;
    poseFoulReaction(): void;
    /** リアクションの型（foulReactKind は "hurt"|"and1" のままなので別に持つ）。 */
    foulStyle: FoulKind;
    /** 上げる/庇う腕を右にするか（イベントごとに決めて散らす）。 */
    foulArmR: boolean;
    /** 上半身のひねり量(rad)。接触で体が回る。 */
    foulTwist: number;
  }
}
Player.prototype.foulStyle = "hurt";
Player.prototype.foulArmR = false;
Player.prototype.foulTwist = 0;

/** ファウルリアクションを開始する。`pushX/pushZ` は接触が彼を弾いたワールド方向
 *  （0,0=不明 → 単純に後ろへのけぞる）。`strength` (0..1) がのけぞりの強さ、
 *  継続時間、よろけになる確率をスケールする。 */
Player.prototype.foulReaction = function(kind: FoulKind, pushX = 0, pushZ = 0, strength = 0.5): void {
    this.foulStyle = kind;
    this.foulReactKind = kind === "and1" ? "and1" : "hurt";   // 既存の分岐互換
    const s = clamp(strength, 0, 1);
    this.foulStrength = s;
    const pl = Math.hypot(pushX, pushZ);
    if (pl > 0.01) { this.foulPushX = pushX / pl; this.foulPushZ = pushZ / pl; }
    else { this.foulPushX = this.foulPushZ = 0; }        // 方向なし → 後ろへ揺れる
    // 押された側と反対の腕が上がる（バランスを取る側）。方向が無ければ半々。
    this.foulArmR = pl > 0.01
      ? (this.foulPushX * Math.cos(this.root.rotation.y) - this.foulPushZ * Math.sin(this.root.rotation.y)) < 0
      : chance(0.5);
    // 上半身のひねり: 接触で体が回る。強いほど大きく、向きは腕の上がる側と揃える。
    this.foulTwist = (this.foulArmR ? -1 : 1) * (0.15 + s * 0.45) * rand(0.7, 1.2);
    // 強く中心を外れたヒットは後方へ吹き飛ばしうる——足が浮く小さなホップと
    // 大きなよろめき。軽いものはつまずく一歩だけ。ほとんどはどちらでもない。
    const hard = kind !== "and1" && pl > 0.01;
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
    const up = this.foulArmR ? this.armPivotR : this.armPivotL;    // 上がる/残る腕
    const upElbow = this.foulArmR ? this.elbowR : this.elbowL;
    const low = this.foulArmR ? this.armPivotL : this.armPivotR;   // 流れる腕
    const lowElbow = this.foulArmR ? this.elbowL : this.elbowR;
    const sx = this.foulArmR ? 1 : -1;                              // 上がる腕の左右符号

    if (this.foulStyle === "and1") {
      // フレックス: 両拳を頭の横に上げ、肘を強く畳む
      this.setArmDir(this.armPivotL, -0.7, 0.9, 0);
      this.setArmDir(this.armPivotR, 0.7, 0.9, 0);
      this.bendElbow(this.elbowL, 1.35);
      this.bendElbow(this.elbowR, 1.35);
      this.flinchPitch = this.flinchRoll = 0;
      this.foulTwist = 0;
    } else if (this.foulStyle === "shoot") {
      // 撃った直後に叩かれた: 撃った腕はフォロースルーの形のまま高く残り、
      // 反対の腕は外へ流れる。上体は後ろへ大きくのけぞる。
      this.setArmDir(up, sx * 0.35, 1, -0.25 * this.numberSide);
      this.bendElbow(upElbow, 0.30 + env * 0.35);   // 叩かれて肘が折れる
      this.setArmDir(low, -sx * 0.9, 0.15, 0.3);
      this.bendElbow(lowElbow, 0.5);
    } else if (this.foulStyle === "drive") {
      // 走り込みで当てられた: 前の腕が体を横切り、後ろの腕は背中側へ流れる。
      this.setArmDir(up, sx * 0.5, 0.45, -0.7 * this.numberSide);
      this.bendElbow(upElbow, 0.95);
      this.setArmDir(low, -sx * 0.8, -0.35, 0.55 * this.numberSide);
      this.bendElbow(lowElbow, 0.25);
    } else {
      // 一般の接触: 片腕は肘を畳んで庇い、もう片方はバランスを取って外へ。
      // ⚠️ 以前は両腕とも真っ直ぐ低く外へ出していて、どの接触でも同じ形に見えた。
      this.setArmDir(up, sx * 0.55, 0.5, -0.2 * this.numberSide);
      this.bendElbow(upElbow, 1.1);
      this.setArmDir(low, -sx * 1, -0.45, 0.25);
      this.bendElbow(lowElbow, 0.2);
    }

    // 上半身のひねり（下半身は root のまま＝体がねじれる）
    if (this.foulStyle !== "and1") {
      const tw = this.foulTwist * env;
      this.torsoTwist = tw;
      this.torsoNode.rotation.y = tw;
    }

    if (this.foulStyle === "and1") return;
    if (this.foulPushX !== 0 || this.foulPushZ !== 0) {
      // 方向性のある揺れ: ヒットが送った方向へ体を傾け、強い接触ほど大きく。
      // ワールドの押し → ヨーローカルのピッチ/ロール（前傾の傾きと同じ規約）で
      // 全身がヒットで傾く。シュートを叩かれたときは後方への反りを増やす。
      const th = this.root.rotation.y;
      const c = Math.cos(th), s = Math.sin(th);
      const lean = this.foulStyle === "shoot" ? 1.5 : this.foulStyle === "drive" ? 0.8 : 1;
      const m = (0.16 + this.foulStrength * 0.34) * env * lean;   // 傾き量
      const wx = this.foulPushX * m, wz = this.foulPushZ * m;
      this.flinchPitch = wx * s + wz * c;                  // ローカル +Z へ傾く
      this.flinchRoll = -(wx * c - wz * s);                // そしてローカル +X へ
    } else {
      // 方向情報なし → 従来の真っ直ぐ後ろへの揺れ
      this.flinchPitch = this.numberSide * 0.22 * env;
      this.flinchRoll = 0;
    }
};
