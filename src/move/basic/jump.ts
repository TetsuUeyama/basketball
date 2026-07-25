// ジャンプ: 開始・飛行/着地の更新・手の最高到達点。
import { rate, clamp } from "../../util";
import { Player } from "../../objects/player/player";

declare module "../../objects/player/player" {
  interface Player {
    jump(height: number, dur: number, leapX?: number, leapZ?: number): void;
    updateJump(dt: number): void;
    reachTopY(): number;
  }
}

/** `height` メートルの、`dur` 秒続くジャンプを開始する。任意の (leapX,leapZ) は
 *  飛行全体に分散する水平の踏み込み — 正面にないシュートへの斜めのジャンプ
 *  （高さは低いが、ブロックするために横へ届く）。 */
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
        // 着地 硬直: 再ジャンプや爆発の前に重心が落ち着く必要がある。クイックネス(敏捷性)と
        // ジャンプ力で駆動（両方エリートで~0.3s、両方低いとフルジャンプで≈2.5s）。大きい
        // ジャンプはリセットがやや遅い。再ジャンプを阻み、最初の数歩を鈍らせる(accelSpeed)。
        const ability = (rate(this.attr.agility) + rate(this.attr.jump)) / 2;   // 1 = 両方エリート
        const base = 0.3 + Math.pow(1 - ability, 0.85) * 2.2;                    // 0.3 .. 2.5 (フルジャンプ)
        const heightScale = clamp(0.5 + this.jumpHeight * 0.9, 0.45, 1.3);
        this.landDur = this.landT = clamp(base * heightScale, 0.3, 2.6);
        this.rootT = Math.max(this.rootT, this.landT * 0.4);   // 着地の頭側は完全硬直（動けない）
        this.leapX = this.leapZ = 0;
      }
    }
};

/** 手が現在届く最高点（立ちリーチ+ジャンプ）。 */
Player.prototype.reachTopY = function(): number {
  return this.jumpY() + this.height * 1.35;
};
