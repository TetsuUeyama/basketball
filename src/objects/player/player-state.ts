// 選手の状態リセットとコンディション回復（ボックススコア/スタミナ）。
// プロトタイプ拡張で Player に紐づけ。
import { rate } from "../../util";
import { HUD_OPTS } from "../../config";
import { Player } from "./player";

declare module "./player" {
  interface Player {
    resetStats(): void;
    benchRecover(dt: number): void;
    breakRecover(amount: number): void;
  }
}

/** この選手のボックススコアとコンディションをゼロにする（試合開始）。 */
Player.prototype.resetStats = function(): void {
  const s = this.stats;
  s.pts = s.reb = s.ast = s.stl = s.blk = s.tov = s.fgm = s.fga = s.min = 0;
  s.tpm = s.tpa = s.ftm = s.fta = 0;
  this.fatigue = 0;
  this.curSpd = 0;
  this.stintT = 0;
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
