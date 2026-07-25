// ファウルリアクションのアニメ（のけぞり/よろめき/and1フレックス）。
// basic/arms のムーバ経由で動く。
import { clamp, chance } from "../../util";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    foulReaction(kind: "hurt" | "and1", pushX?: number, pushZ?: number, strength?: number): void;
    poseFoulReaction(): void;
  }
}

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
      this.bendElbow(this.elbowL, 0); this.bendElbow(this.elbowR, 0);
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
